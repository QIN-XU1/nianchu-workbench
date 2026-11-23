/**
 * 闲置销毁 · 端到端验证
 *
 * 验证链路：
 *   ① 模块已加载（__webaiIdleGC_API 存在）
 *   ② 默认关闭（安全）
 *   ③ 手动开启后 sweep 能识别闲置站点
 *   ④ 模拟"闲置"后 sweep 真的销毁并释放内存
 *   ⑤ 销毁后能通过顶栏按钮恢复
 */

const CDP_PORT = 9333;
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

class CDP {
  constructor(u) { this.u = u; this.ws = null; this.id = 1; this.p = new Map(); }
  async connect() {
    return new Promise((res, rej) => {
      const ws = new WebSocket(this.u); this.ws = ws;
      const t = setTimeout(() => rej(new Error('超时')), 5000);
      ws.addEventListener('open', () => { clearTimeout(t); res(); });
      ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('失败')); });
      ws.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.p.has(m.id)) { const { resolve, reject } = this.p.get(m.id); this.p.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
      });
    });
  }
  send(method, params = {}) {
    const id = this.id++;
    return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error(method + ' 超时')); } }, 25000); });
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 错误');
    return r.result?.value;
  }
  async close() { const ws = this.ws; if (!ws) return; this.ws = null; try { await new Promise(r => { ws.addEventListener('close', r); ws.close(); setTimeout(r, 500); }); } catch { /* ignore */ } }
}

const { execFileSync } = await import('node:child_process');
const pc = () => { try { return Number(execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Process -Name electron -ErrorAction SilentlyContinue | Measure-Object).Count'], { encoding: 'utf8', timeout: 20000 }).trim()); } catch { return null; } };
const mem = () => { try { return Number(execFileSync('powershell', ['-NoProfile', '-Command', '$s=0; Get-Process -Name electron -ErrorAction SilentlyContinue | % { $s += $_.PrivateMemorySize64/1MB }; [math]::Round($s)'], { encoding: 'utf8', timeout: 20000 }).trim()); } catch { return null; } };

let pass = 0, total = 0;
function chk(name, ok, detail) {
  total++; if (ok) pass++;
  console.log(`${ok ? C.green + 'PASS' : C.red + 'FAIL'}${C.reset}  ${name.padEnd(38)} ${C.dim}${detail}${C.reset}`);
}

console.log(`${C.bold}闲置销毁 · 端到端验证${C.reset}\n`);

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();

try {
  // ---- 0 确保起点干净（可重复运行）----
  // 上一轮跑完后可能留下"站点已销毁"的状态；先恢复，避免影响本轮计数。
  const cleaned = await cdp.eval(`(function(){
    var st = window.__kunWebAi || {};
    var wvs = document.querySelectorAll('webview').length;
    // 若有幽灵状态（wins 有记录但 DOM 没窗口），清掉
    var domKeys = [].slice.call(document.querySelectorAll('.webai-win')).map(function(e){ return e.dataset.key || ''; });
    var cleanedKeys = [];
    Object.keys(st.wins || {}).forEach(function(k){
      if (domKeys.indexOf(k) < 0) { delete st.wins[k]; cleanedKeys.push(k); }
    });
    return { webviews: wvs, ghostCleared: cleanedKeys };
  })()`);
  console.log(`${C.dim}[起点] webview=${cleaned.webviews} 幽灵状态清除=${JSON.stringify(cleaned.ghostCleared)}${C.reset}\n`);

  // ---- 1 模块是否加载 ----
  const loaded = await cdp.eval(`(function(){
    return {
      hasApi: typeof window.__webaiIdleGC_API === 'object',
      state: window.__webaiIdleGC_API ? window.__webaiIdleGC_API.state() : null,
      webviews: document.querySelectorAll('webview').length,
    };
  })()`);
  chk('模块已加载', loaded.hasApi, `hasApi=${loaded.hasApi}`);
  chk('默认关闭（安全）', loaded.state && loaded.state.enabled === false, `enabled=${loaded.state ? loaded.state.enabled : '?'}`);
  console.log(`  当前 webview: ${loaded.webviews} 个`);

  if (!loaded.hasApi) throw new Error('模块未加载，无法继续');

  // ---- 2 开启并设短超时 ----
  console.log(`\n${C.bold}【准备】开启回收，设 1 分钟超时${C.reset}`);
  const setup = await cdp.eval(`(function(){
    window.__webaiIdleGC_API.setIdleMinutes(1);
    window.__webaiIdleGC_API.setEnabled(true);
    return window.__webaiIdleGC_API.state();
  })()`);
  console.log(`  state: ${JSON.stringify(setup)}`);
  chk('已开启', setup.enabled === true, `enabled=${setup.enabled}`);

  // ---- 3 第一次 sweep：应该只记录时间戳，不销毁 ----
  const sweep1 = await cdp.eval(`(function(){ return window.__webaiIdleGC_API.sweep(); })()`);
  console.log(`\n  第一次 sweep: ${JSON.stringify(sweep1)}`);
  chk('第一次不销毁（先记录时间）', sweep1.destroyed === 0, `destroyed=${sweep1.destroyed}`);

  // ---- 4 人工把时间戳倒回，模拟"闲置" ----
  // [关键] 在同一段 eval 里完成三件事，避免中间被定时器刷新时间戳：
  //   ① 重新确认 enabled 与 idleMinutes（防止上一轮遗留）
  //   ② 把所有已知键的时间戳设为很久以前
  //   ③ 立刻 sweep（用 setTimeout(0) 抢在定时器前面）
  console.log(`\n${C.bold}【模拟闲置并立即回收】${C.reset}`);
  const aged = await cdp.eval(`(function(){
    var api = window.__webaiIdleGC_API;
    var st = window.__webaiIdleGC;
    if (!api || !st) return { error: 'no api/state' };
    api.setIdleMinutes(1);
    api.setEnabled(true);
    var past = Date.now() - 10 * 60000;
    var keys = Object.keys(st.lastSeen);
    keys.forEach(function(k){ st.lastSeen[k] = past; });
    // 立刻 sweep，不给定时器刷新机会
    var r = api.sweep();
    return { aged: keys.length, keys: keys.map(function(k){ return k.slice(0, 30); }), swept: r.destroyed };
  })()`);
  console.log(`  ${JSON.stringify(aged)}`);
  chk('已模拟闲置', aged.aged > 0, `${aged.aged} 个站点被设为闲置`);

  // ---- 5 记录销毁前 ----
  const before = { procs: pc(), mem: mem() };
  const wvBefore = await cdp.eval(`document.querySelectorAll('webview').length`);
  console.log(`\n  销毁前: ${before.procs} 进程 · ${before.mem}MB · ${wvBefore} webview`);

  // ---- 6 执行 sweep（再扫一遍确保干净；上面那次可能已销毁）----
  console.log(`\n${C.bold}【执行回收】${C.reset}`);
  const sweep2 = await cdp.eval(`(function(){
    var st = window.__webaiIdleGC;
    var past = Date.now() - 30 * 60000;
    Object.keys(st.lastSeen || {}).forEach(function(k){ st.lastSeen[k] = past; });
    return { ok: true };
  })()`);
  const swept2 = await cdp.eval(`(function(){ return window.__webaiIdleGC_API.sweep(); })()`);
  const totalDestroyed = (aged.swept || 0) + (swept2.destroyed || 0);
  console.log(`  第一次 sweep 销毁 ${aged.swept} 个，第二次 ${swept2.destroyed} 个`);
  chk('sweep 执行了销毁', totalDestroyed > 0, `共销毁 ${totalDestroyed} 个`);

  // ---- 7 等进程回收 ----
  await new Promise(r => setTimeout(r, 20000));
  const after = { procs: pc(), mem: mem() };
  const wvAfter = await cdp.eval(`document.querySelectorAll('webview').length`);
  console.log(`  销毁后(20s): ${after.procs} 进程 · ${after.mem}MB · ${wvAfter} webview`);

  const freedProcs = (before.procs || 0) - (after.procs || 0);
  const freedMB = (before.mem || 0) - (after.mem || 0);
  chk('进程已释放', freedProcs > 0, `释放 ${freedProcs} 个进程`);
  chk('内存已释放', freedMB > 50, `释放 ${freedMB}MB`);
  console.log(`  ${C.dim}webview: ${wvBefore} → ${wvAfter}${C.reset}`);

  // ---- 8 恢复 ----
  console.log(`\n${C.bold}【恢复验证】${C.reset}`);
  const restore = await cdp.eval(`(function(){
    window.__webaiIdleGC_API.setEnabled(false);
    var btns = [].slice.call(document.querySelectorAll('.webai-btn'));
    var n = 0;
    btns.forEach(function(b){
      var t = (b.getAttribute('title') || '');
      if (/豆包|通义|智谱|Kimi/.test(t)) {
        try { b.click(); n++; } catch(e){}
      }
    });
    return { clicked: n, state: window.__webaiIdleGC_API.state() };
  })()`);
  console.log(`  ${JSON.stringify(restore)}`);

  await new Promise(r => setTimeout(r, 10000));
  const final = { procs: pc(), mem: mem() };
  const wvFinal = await cdp.eval(`document.querySelectorAll('webview').length`).catch(() => -1);
  console.log(`  恢复后: ${final.procs} 进程 · ${final.mem}MB · ${wvFinal} webview`);

  // 等恢复完全稳定（预热是错峰 700ms 一个，4 个站需要约 3 秒）
  await new Promise(r => setTimeout(r, 5000));
  const final2 = await cdp.eval(`document.querySelectorAll('webview').length`).catch(() => -1);
  const restored = final2 > wvAfter;
  chk('能恢复（点顶栏按钮重建）', restored, `webview ${wvAfter} → ${final2}`);
  console.log(`  ${C.dim}恢复稳定后: ${final2} 个 webview${C.reset}`);

  // 恢复默认配置
  await cdp.eval(`(function(){
    var st = window.__webaiIdleGC;
    if (st) { st.enabled = false; st.idleMinutes = 15; }
    return true;
  })()`);

} finally {
  await cdp.close();
}

console.log(`\n${C.bold}===== 闲置销毁验证：${pass}/${total} =====${C.reset}`);
if (pass === total) {
  console.log(`${C.green}闲置销毁可用：检测到闲置 → 销毁元素 → 释放进程 → 可恢复${C.reset}`);
} else {
  console.log(`${C.yellow}有项未通过${C.reset}`);
}
process.exit(pass === total ? 0 : 1);
