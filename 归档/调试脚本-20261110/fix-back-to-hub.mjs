const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  return {
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 8000);
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
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 30000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 400) };
      return r.result?.value;
    },
    close() { try { ws.close(); } catch {} }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

console.log('═══ 切回 hub 场景 ═══');

const before = await cdp.eval(`(function(){
  var st = window.__WB.state;
  return {
    current: window.__WB.getCurrentScene ? window.__WB.getCurrentScene() : null,
    sceneState: st && st.get ? st.get('scene.current') : null,
  };
})()`);
console.log('切换前: ' + JSON.stringify(before));

const r = await cdp.eval(`(async function(){
  try {
    var ok = await window.__WB.switchScene('hub');
    await new Promise(function(res){ setTimeout(res, 700); });
    return {
      ok: ok,
      current: window.__WB.getCurrentScene(),
      panels: Array.from(document.querySelectorAll('[data-panel-type]')).map(function(p){
        return p.getAttribute('data-panel-type');
      }),
    };
  } catch(e) { return { error: e.message }; }
})()`);
console.log('切换后: ' + JSON.stringify(r, null, 2));

cdp.close();
