/**
 * 诊断：为什么第二次跑测试时销毁后 webview 又变成 6
 *
 * 现象：第一次跑 9/9（6→2→6）；第二次跑 6/9（6→6→6）
 *
 * 可能原因：
 *   ① 上一次测试结束时恢复了 4 个站，但 webAiEnsure 的内部状态有残留
 *   ② 预热逻辑被 ⟳ 重跑，又建了一遍
 *   ③ 销毁时只清了 wins 记录，但 DOM 里的 webai-win 没清干净
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

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();

try {
  console.log(`${C.bold}诊断：销毁-重建的真实行为${C.reset}\n`);

  // 当前状态
  const s0 = await cdp.eval(`(function(){
    var st = window.__kunWebAi || {};
    return {
      webviews: document.querySelectorAll('webview').length,
      winsKeys: Object.keys(st.wins || {}),
      domWins: [].slice.call(document.querySelectorAll('.webai-win')).map(function(e){ return e.dataset.key || '?'; }),
      warmed: st.warmed,
      gcState: window.__webaiIdleGC_API ? window.__webaiIdleGC_API.state() : null,
    };
  })()`);
  console.log(`【当前】webview=${s0.webviews} wins=${JSON.stringify(s0.winsKeys)}`);
  console.log(`  DOM 里的 webai-win: ${JSON.stringify(s0.domWins)}`);
  console.log(`  warmed=${s0.warmed}  gcState=${JSON.stringify(s0.gcState)}`);

  // 检查 DOM wins 与 wins 状态是否一致
  const orphanDom = s0.domWins.filter(k => !s0.winsKeys.includes(k));
  const orphanState = s0.winsKeys.filter(k => !s0.domWins.includes(k));
  console.log(`\n  不一致检查:`);
  console.log(`    DOM 有但状态没有（孤儿 DOM）: ${JSON.stringify(orphanDom)}`);
  console.log(`    状态有但 DOM 没有（幽灵状态）: ${JSON.stringify(orphanState)}`);

  if (orphanDom.length > 0) {
    console.log(`  ${C.red}✗ 找到问题：DOM 里有孤儿 .webai-win，会干扰计数与布局${C.reset}`);
  }
  if (orphanState.length > 0) {
    console.log(`  ${C.red}✗ 找到问题：状态里有幽灵记录，webAiEnsure 会认为"已存在"${C.reset}`);
  }

  // 现在执行一次完整销毁，观察 webview 数
  console.log(`\n${C.bold}【执行销毁并观察 20 秒内变化】${C.reset}`);
  await cdp.eval(`(function(){
    window.__webaiIdleGC_API.setIdleMinutes(1);
    window.__webaiIdleGC_API.setEnabled(true);
    var st = window.__webaiIdleGC;
    if (st) {
      Object.keys(st.lastSeen).forEach(function(k){ st.lastSeen[k] = Date.now() - 10*60000; });
    }
    return true;
  })()`);

  const r = await cdp.eval(`window.__webaiIdleGC_API.sweep()`);
  console.log(`  sweep: destroyed=${r.destroyed}`);

  for (const w of [3, 6, 10, 15, 20]) {
    await new Promise(x => setTimeout(x, 3000));
    const n = await cdp.eval(`document.querySelectorAll('webview').length`);
    const wins = await cdp.eval(`Object.keys((window.__kunWebAi||{}).wins||{}).length`);
    console.log(`  T+${w}s: webview=${n}  wins=${wins}  进程=${pc()}`);
  }

  console.log(`\n${C.bold}结论${C.reset}`);
  const finalWv = await cdp.eval(`document.querySelectorAll('webview').length`);
  if (finalWv > 2) {
    console.log(`  ${C.yellow}! 销毁后 webview 数量回升到 ${finalWv} —— 说明有东西在自动重建${C.reset}`);
    console.log(`  ${C.dim}可能是：⟳ 热重载后 decorateWebAi 又跑了一遍预热（warmed 被重置）${C.reset}`);
  } else {
    console.log(`  ${C.green}✓ 销毁后保持 ${finalWv} 个，没有自动重建${C.reset}`);
  }

  // 清理
  await cdp.eval(`(function(){ window.__webaiIdleGC_API.setEnabled(false); return true; })()`);

} finally {
  await cdp.close();
}
