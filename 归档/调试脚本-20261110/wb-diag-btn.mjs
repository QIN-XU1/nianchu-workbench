/**
 * 诊断：webai-btn 的真实 class 与状态
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

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();

try {
  const info = await cdp.eval(`(function(){
    var st = window.__kunWebAi || {};
    var wins = Object.keys(st.wins || {});
    var domWins = [].slice.call(document.querySelectorAll('.webai-win')).map(function(e){ return e.dataset.key || '?'; });
    var btns = [].slice.call(document.querySelectorAll('.webai-btn')).map(function(b){
      return {
        key: b.dataset.key || '',
        cls: b.className,
        hasOn: b.classList.contains('on'),
        hasActive: b.classList.contains('active'),
        title: (b.getAttribute('title') || '').slice(0, 30),
      };
    });
    // 看 webAiMarkOn 的实现（决定 class）
    var markOnSrc = '';
    try { if (typeof webAiMarkOn === 'function') markOnSrc = webAiMarkOn.toString().slice(0, 400); } catch(e){}
    return {
      webviews: document.querySelectorAll('webview').length,
      winsKeys: wins,
      domWins: domWins,
      btns: btns,
      markOn: markOnSrc,
    };
  })()`);

  console.log(`${C.bold}当前状态${C.reset}`);
  console.log(`  webview: ${info.webviews}`);
  console.log(`  wins 状态: ${JSON.stringify(info.winsKeys)}`);
  console.log(`  DOM 窗口: ${JSON.stringify(info.domWins)}`);
  console.log(`\n  顶栏按钮:`);
  for (const b of info.btns) {
    console.log(`    key=${b.key.padEnd(10)} on=${b.hasOn ? 'Y' : 'N'} active=${b.hasActive ? 'Y' : 'N'} cls="${b.cls}"`);
  }
  console.log(`\n  webAiMarkOn 实现:`);
  console.log(info.markOn);

} finally {
  await cdp.close();
}
