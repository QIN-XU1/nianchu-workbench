/**
 * 闲置销毁 · 确定性端到端验证（v2）
 *
 * 为什么要重写：
 *   v1 依赖运行时历史状态（lastSeen 累计、warmed 标志、上一轮遗留的 wins 记录），
 *   导致同一测试连跑两次结果不同（9/9 → 6/9 → 5/9）。
 *   一个不能重复通过的测试没有价值。
 *
 * v2 设计：
 *   ① 开头 resetState()，回到确定状态
 *   ② 用 forceSweepAll 保证释放能被观测（不依赖时间戳）
 *   ③ 恢复后用实际 webview 数判定
 *   ④ 每个断言都基于"本次操作前后"的差值，不基于绝对值
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
    return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error(method + ' 超时')); } }, 30000); });
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
const failures = [];
function chk(name, ok, detail) {
  total++; if (ok) pass++; else failures.push(name);
  console.log(`${ok ? C.green + 'PASS' : C.red + 'FAIL'}${C.reset}  ${name.padEnd(36)} ${C.dim}${detail}${C.reset}`);
}

console.log(`${C.bold}闲置销毁 · 确定性验证 v2${C.reset}\n`);

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
if (!page) { console.log('找不到主页面'); process.exit(1); }
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();

async function ensureSitesLoaded() {
  // 确保 4 个站都加载（点顶栏按钮，走项目自己的重建路径）
  const r = await cdp.eval(`(function(){
    var btns = [].slice.call(document.querySelectorAll('.webai-btn'));
    var before = document.querySelectorAll('webview').length;
    var clicked = 0;
    btns.forEach(function(b){
      var t = (b.getAttribute('title') || '');
      if (/豆包|通义|智谱|Kimi/.test(t)) {
        // 只有"关着"的才点（class 带 on 表示开着）
        if (!b.classList.contains('on')) { try { b.click(); clicked++; } catch(e){} }
      }
    });
    return { before: before, clicked: clicked };
  })()`);
  if (r.clicked > 0) await new Promise(x => setTimeout(x, 12000));
  return r;
}

try {
  // ===== 0 重置到确定状态 =====
  const reset0 = await cdp.eval(`(function(){
    var api = window.__webaiIdleGC_API;
    if (!api) return { error: 'API 未加载' };
    var r = api.resetState();
    return r;
  })()`);
  chk('API 已加载', !reset0.error, reset0.error || 'ok');

  console.log(`\n${C.bold}【准备】确保 4 个站已加载${C.reset}`);
  const prep = await ensureSitesLoaded();
  const wvCount0 = await cdp.eval(`document.querySelectorAll('webview').length`);
  console.log(`  webview: ${wvCount0} 个`);
  chk('4 个站已加载', wvCount0 >= 5, `webview=${wvCount0}`);

  const base = { procs: pc(), mem: mem() };
  console.log(`  基线: ${base.procs} 进程 · ${base.mem}MB`);

  // ===== 1 默认关闭 =====
  const st = await cdp.eval(`window.__webaiIdleGC_API.state()`);
  chk('默认关闭（安全）', st.enabled === false, `enabled=${st.enabled}`);

  // ===== 2 forceSweepAll 销毁 =====
  console.log(`\n${C.bold}【销毁】forceSweepAll（确定性入口）${C.reset}`);
  const swept = await cdp.eval(`window.__webaiIdleGC_API.forceSweepAll(true)`);
  console.log(`  销毁 ${swept.destroyed} 个: ${swept.detail.map(d => d.siteKey || d.src.slice(0, 20)).join(', ')}`);
  chk('销毁了站点', swept.destroyed > 0, `${swept.destroyed} 个`);

  const wvAfterDestroy = await cdp.eval(`document.querySelectorAll('webview').length`);
  chk('webview 数减少', wvAfterDestroy < wvCount0, `${wvCount0} → ${wvAfterDestroy}`);

  // ===== 3 等进程回收，量释放 =====
  console.log(`\n${C.bold}【等待进程回收】${C.reset}`);
  let freedProcs = 0, freedMB = 0;
  for (const w of [10, 20, 30]) {
    await new Promise(x => setTimeout(x, 10000));
    const now = { procs: pc(), mem: mem() };
    freedProcs = (base.procs || 0) - (now.procs || 0);
    freedMB = (base.mem || 0) - (now.mem || 0);
    console.log(`  T+${w}s: ${now.procs} 进程 · ${now.mem}MB  (释放 ${freedProcs} 进程 / ${freedMB}MB)`);
  }
  chk('进程已释放', freedProcs > 0, `释放 ${freedProcs} 个`);
  chk('内存已释放', freedMB > 100, `释放 ${freedMB}MB`);

  // ===== 4 恢复 =====
  console.log(`\n${C.bold}【恢复】点顶栏按钮重建${C.reset}`);
  const rest = await ensureSitesLoaded();
  console.log(`  点击 ${rest.clicked} 个按钮`);
  await new Promise(x => setTimeout(x, 15000));

  const wvRestored = await cdp.eval(`document.querySelectorAll('webview').length`);
  chk('webview 已恢复', wvRestored > wvAfterDestroy, `${wvAfterDestroy} → ${wvRestored}`);
  chk('恢复到原数量级', wvRestored >= wvCount0 - 1, `期望 ≥${wvCount0 - 1}，实际 ${wvRestored}`);

  // ===== 5 清理 =====
  await cdp.eval(`window.__webaiIdleGC_API.resetState()`);

} catch (e) {
  console.log(`\n${C.red}测试异常: ${e && e.message}${C.reset}`);
  failures.push('异常: ' + (e && e.message));
} finally {
  await cdp.close();
}

console.log(`\n${C.bold}===== 确定性验证：${pass}/${total} =====${C.reset}`);
if (pass === total) {
  console.log(`${C.green}闲置销毁可用：销毁 → 释放进程 → 可恢复${C.reset}`);
} else {
  console.log(`${C.yellow}未通过：${failures.join('；')}${C.reset}`);
}
process.exit(pass === total ? 0 : 1);
