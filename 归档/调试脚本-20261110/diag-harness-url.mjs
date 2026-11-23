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
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 40000); });
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

console.log('═══ 探测 getHarnessUrl 的真实行为 ═══');
console.log();

// ① 原始调用
const raw = await cdp.eval(`(async function(){
  try {
    var v = await window.app.getHarnessUrl();
    return { value: v, type: typeof v };
  } catch(e) { return { error: e.message }; }
})()`);
console.log('① 原始 window.app.getHarnessUrl(): ' + JSON.stringify(raw));

// ② 包装版
const wrapped = await cdp.eval(`(async function(){
  try {
    var r = await window.__WB.api.getHarnessUrl();
    return { ok: r.ok, value: r.value, error: r.error };
  } catch(e) { return { error: e.message }; }
})()`);
console.log('② api.getHarnessUrl(): ' + JSON.stringify(wrapped));

// ③ 引擎 token 环境
const env = await cdp.eval(`(function(){
  return {
    hasApp: !!window.app,
    isHarnessReady: window.app.isHarnessReady ? 'fn' : 'none',
  };
})()`);
console.log('③ 环境: ' + JSON.stringify(env));

// ④ 检查 main.js 里 harness:url 的实现逻辑（在主进程侧，只能看日志）
const bootState = await cdp.eval(`(function(){
  var s = window.app.bootState ? 'fn' : 'none';
  return { bootState: s };
})()`);
console.log('④ ' + JSON.stringify(bootState));

cdp.close();
