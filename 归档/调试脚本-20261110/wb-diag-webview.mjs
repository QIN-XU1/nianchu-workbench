/**
 * 诊断：webview 的 did-fail-load 到底在哪一级
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

try {
  console.log(`${C.bold}【1】webview 元素能力${C.reset}`);
  const info = await cdp.eval(`(function(){
    var wv = document.querySelector('webview');
    if (!wv) return { error: 'no webview' };
    return {
      tag: wv.tagName,
      src: (wv.getAttribute('src') || '').slice(0, 52),
      hasGetWebContentsId: typeof wv.getWebContentsId === 'function',
      hasReload: typeof wv.reload === 'function',
      hasStop: typeof wv.stop === 'function',
    };
  })()`);
  console.log(`  ${JSON.stringify(info)}`);

  console.log(`\n${C.bold}【2】主动注入坏地址，看渲染层收到什么${C.reset}`);
  const before = await cdp.eval(`(function(){
    var wv = document.querySelector('webview');
    return { src: wv.getAttribute('src'), fl: (window.__faultList ? window.__faultList().length : 0) };
  })()`);
  console.log(`  注入前: faultList=${before.fl}`);

  const r = await cdp.eval(`(function(){
    var wv = document.querySelector('webview');
    if (!wv) return { error: 'no webview' };
    window.__wvEvents = [];
    ['did-fail-load', 'did-finish-load', 'dom-ready', 'did-start-loading', 'did-stop-loading'].forEach(function(k) {
      try {
        wv.addEventListener(k, function(e) {
          window.__wvEvents.push({ ev: k, code: e && e.errorCode, desc: e && e.errorDescription, url: e && e.validatedURL });
        });
      } catch (err) { /* ignore */ }
    });
    wv.setAttribute('src', 'http://this-host-does-not-exist-12345.invalid/');
    return { ok: true, origSrc: wv.getAttribute('src') };
  })()`);
  console.log(`  已注入坏地址`);

  await new Promise(r2 => setTimeout(r2, 9000));

  const after = await cdp.eval(`(function(){
    var wv = document.querySelector('webview');
    return {
      fl: (window.__faultList ? window.__faultList().length : 0),
      wvEvents: window.__wvEvents || [],
      lastFault: (window.__faultList ? window.__faultList().slice(-1)[0] : null),
      srcNow: (wv.getAttribute('src') || '').slice(0, 50),
    };
  })()`);
  console.log(`  注入后: faultList=${after.fl}`);
  console.log(`  webview 自身事件: ${JSON.stringify(after.wvEvents).slice(0, 400)}`);
  console.log(`  最后 fault: ${JSON.stringify(after.lastFault).slice(0, 200)}`);

  // 恢复
  await cdp.eval(`(function(){
    var wv = document.querySelector('webview');
    if (wv) wv.setAttribute('src', ${JSON.stringify(before.src)});
    return true;
  })()`);
  console.log(`  ${C.dim}已恢复${C.reset}`);

} finally {
  await cdp.close();
}
