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

console.log('═══ 注册表读取验证 ═══');
console.log();

const out = await cdp.eval(`(async function(){
  try {
    var r = await window.app.listScenarios();
    return {
      count: (r || []).length,
      first: (r || [])[0],
      ids: (r || []).map(function(x){ return x.id + (x.isHub ? ' [HUB]' : ''); }),
      allFromRegistry: (r || []).every(function(x){ return x.fromRegistry === true; }),
    };
  } catch(e) { return { error: e.message }; }
})()`);

console.log(JSON.stringify(out, null, 2).slice(0, 900));

console.log();
console.log('═══ 前端场景标签（应该只剩中枢优先显示）═══');
const tabs = await cdp.eval(`(function(){
  var tabs = document.querySelectorAll('.wb-scenetab');
  return {
    count: tabs.length,
    texts: Array.from(tabs).map(function(t){ return t.textContent.trim(); }),
    active: document.querySelector('.wb-scenetab[data-active="1"]') ? document.querySelector('.wb-scenetab[data-active="1"]').textContent.trim() : '(无)',
  };
})()`);
console.log(JSON.stringify(tabs, null, 2).slice(0, 600));

cdp.close();
