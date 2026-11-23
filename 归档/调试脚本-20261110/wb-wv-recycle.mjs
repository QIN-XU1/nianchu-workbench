/**
 * 验证：场景切换时旧 webview 是否被正确回收
 *
 * 问题：webview[0] 0x0 + 在隐藏容器里，与 webview[1] 同源同分区。
 * 可能的解释：
 *   a) 上一个场景的 harness webview 没被销毁（泄漏）
 *   b) 是当前场景的隐藏备用面板（设计需要）
 *
 * 验证方法：记录当前场景 → 切场景 → 看 webview 数变化
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
    return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error(method + ' 超时')); } }, 20000); });
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 错误');
    return r.result?.value;
  }
  async close() { const ws = this.ws; if (!ws) return; this.ws = null; try { await new Promise(r => { ws.addEventListener('close', r); ws.close(); setTimeout(r, 600); }); } catch { /* ignore */ } }
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();

const snap = () => cdp.eval(`(function(){
  return {
    webviews: [].slice.call(document.querySelectorAll('webview')).map(function(w){
      var r = w.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), src: (w.getAttribute('src')||'').slice(0,40), part: w.getAttribute('partition')||'' };
    }),
    dom: document.querySelectorAll('*').length,
    panels: document.querySelectorAll('.panel').length,
  };
})()`);

try {
  console.log(`${C.bold}验证：切场景时 webview 回收${C.reset}\n`);

  const s0 = await snap();
  console.log(`【当前】webview ${s0.webviews.length} 个, 面板 ${s0.panels} 个, DOM ${s0.dom}`);
  s0.webviews.forEach((w, i) => console.log(`  [${i}] ${w.w}x${w.h}  ${w.part}  ${w.src}`));

  // 找可用场景列表
  const scenes = await cdp.eval(`(async function(){
    try { return await window.app.listScenarios(); } catch (e) { return []; }
  })()`);
  console.log(`\n可用场景: ${scenes.map(s => s.id).join(', ')}`);

  const cur = scenes.find(s => s.first) || scenes[0];
  const next = scenes.find(s => s.id !== cur.id);
  console.log(`\n从 ${cur.id} 切到 ${next.id}`);

  // 切场景
  const switched = await cdp.eval(`(async function(){
    try {
      if (typeof window.loadScenario === 'function') { await window.loadScenario(${JSON.stringify(next.id)}); return 'ok'; }
      return 'no-func';
    } catch (e) { return 'err:' + e.message; }
  })()`);
  console.log(`切换结果: ${switched}`);

  await new Promise(r => setTimeout(r, 3000));

  const s1 = await snap();
  console.log(`\n【切换后】webview ${s1.webviews.length} 个, 面板 ${s1.panels} 个, DOM ${s1.dom}`);
  s1.webviews.forEach((w, i) => console.log(`  [${i}] ${w.w}x${w.h}  ${w.part}  ${w.src}`));

  console.log(`\n${C.bold}比较${C.reset}`);
  console.log(`  webview: ${s0.webviews.length} → ${s1.webviews.length} (${s1.webviews.length - s0.webviews.length >= 0 ? '+' : ''}${s1.webviews.length - s0.webviews.length})`);
  console.log(`  面板: ${s0.panels} → ${s1.panels}`);
  console.log(`  DOM: ${s0.dom} → ${s1.dom} (${s1.dom - s0.dom >= 0 ? '+' : ''}${s1.dom - s0.dom})`);

  const wvGrew = s1.webviews.length - s0.webviews.length;
  if (wvGrew > 0) {
    console.log(`\n${C.red}! webview 数量增加了 ${wvGrew} 个 —— 切换场景时旧的没被销毁${C.reset}`);
  } else {
    console.log(`\n${C.green}✓ webview 数量没有增加${C.reset}`);
  }

  const zero = s1.webviews.filter(w => w.w === 0 || w.h === 0);
  console.log(`  其中 0x0 尺寸: ${zero.length} 个`);

  // 切回
  await cdp.eval(`(async function(){ try { if(typeof window.loadScenario==='function'){ await window.loadScenario(${JSON.stringify(cur.id)}); } } catch(e){} })()`);

} finally {
  await cdp.close();
}
