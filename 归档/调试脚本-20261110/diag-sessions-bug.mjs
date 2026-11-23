const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  return {
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 8000);
        ws.addEventListener('open', () => { clearTimeout(t); res(); });
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('连接失败')); });
        ws.addEventListener('message', (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch { return; }
          if (m.id && p.has(m.id)) { const { resolve, reject } = p.get(m.id); p.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
        });
      });
    },
    send(method, params = {}) {
      const i = id++;
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 40000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 500) };
      return r.result?.value;
    },
    close() { try { ws.close(); } catch {} }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

console.log('═══ 查 "0 个会话" bug ═══');
console.log();

// ① 直接调 engine.rpc 看原始返回
const raw = await cdp.eval(`(async function(){
  try {
    var r = await window.app.engine.rpc('session/list', { _request: {} });
    return {
      ok: r.ok, status: r.status,
      hasValue: !!r.value,
      err: r.error,
      // 看 value 的结构
      valueKeys: r.value ? Object.keys(r.value) : [],
      itemsLen: (r.value && r.value.items) ? r.value.items.length : -1,
      raw: (r.raw || '').slice(0, 120),
    };
  } catch(e) { return { exception: e.message }; }
})()`);
console.log('① 原始 engine.rpc:');
console.log(JSON.stringify(raw, null, 2));

// ② 对比 wrapper 版本
console.log();
const wrapped = await cdp.eval(`(async function(){
  try {
    var r = await window.__WB.api.engine.rpc('session/list', { _request: {} });
    return {
      ok: r.ok, status: r.status,
      valueKeys: r.value ? Object.keys(r.value) : [],
      itemsLen: (r.value && r.value.items) ? r.value.items.length : -1,
      error: r.error,
    };
  } catch(e) { return { exception: e.message }; }
})()`);
console.log('② 包装后 api.engine.rpc:');
console.log(JSON.stringify(wrapped, null, 2));

// ③ util.sessions
console.log();
const util = await cdp.eval(`(async function(){
  try {
    var r = await window.__WB.api.util.sessions();
    return { ok: r.ok, itemsLen: r.items ? r.items.length : -1, error: r.error };
  } catch(e) { return { exception: e.message }; }
})()`);
console.log('③ util.sessions:');
console.log(JSON.stringify(util, null, 2));

cdp.close();
