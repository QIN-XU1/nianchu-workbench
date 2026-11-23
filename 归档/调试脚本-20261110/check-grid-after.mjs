const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  return {
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 5000);
        ws.addEventListener('open', () => { clearTimeout(t); res(); });
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('失败')); });
        ws.addEventListener('message', (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch { return; }
          if (m.id && p.has(m.id)) { const { resolve, reject } = p.get(m.id); p.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
        });
      });
    },
    send(method, params = {}) {
      const i = id++;
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 25000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 错误');
      return r.result?.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const eng = targets.filter(t => t.type === 'webview' && t.url.includes('3080') && t.title.includes('命令'));
const cdp = CDP(eng[0].webSocketDebuggerUrl);
await cdp.connect();

const check = await cdp.eval(`(function(){
  var c = document.querySelector('[class*="centerCol"]');
  var f = document.querySelector('[class*="frame"]');
  return {
    centerW: c ? Math.round(c.getBoundingClientRect().width) : 0,
    frameW: f ? Math.round(f.getBoundingClientRect().width) : 0,
    template: f ? getComputedStyle(f).gridTemplateColumns : '',
    winW: window.innerWidth,
    bodyText: (document.body.innerText || '').slice(0, 150),
  };
})()`);

console.log('=== grid 修复后 ===');
console.log(JSON.stringify(check, null, 2));

cdp.close();
