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
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 35000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 300) };
      return r.result?.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

console.log('═══ 引擎 RPC 通道验证 ═══');
console.log();

// ① 检查 preload 暴露
const api = await cdp.eval(`(function(){
  return {
    hasEngine: !!(window.app && window.app.engine),
    hasRpc: !!(window.app && window.app.engine && window.app.engine.rpc),
    hasPrompt: !!(window.app && window.app.engine && window.app.engine.prompt),
  };
})()`);
console.log('① preload API: ' + JSON.stringify(api));

// ② 通过 IPC 调 session/list（只读，无副作用）
console.log();
console.log('② 通过 IPC 调 session/list:');
const list = await cdp.eval(`(async function(){
  try {
    var r = await window.app.engine.rpc('session/list', {});
    return { ok: r.ok, status: r.status, hasValue: !!r.value, err: r.err, raw: (r.raw||'').slice(0,120) };
  } catch(e) { return { error: String(e) }; }
})()`);
console.log('   ' + JSON.stringify(list));

// ③ 找一个场景的 sessionId
console.log();
const sessions = await cdp.eval(`(async function(){
  try {
    var res = await window.app.listScenarios();
    var out = [];
    for (var s of res.slice(0, 3)) {
      var sc = await window.app.getScenario(s.id);
      var h = (sc.panels || []).find(function(p){ return p.type === 'harness'; });
      if (h) out.push({ id: s.id, name: s.name, sid: h.sessionId });
    }
    return out;
  } catch(e) { return { error: String(e) }; }
})()`);
console.log('③ 前 3 个场景的 sessionId:');
if (Array.isArray(sessions)) {
  for (const s of sessions) console.log('   ' + s.id.padEnd(20) + s.name + '  ' + (s.sid || '(无)'));
}

cdp.close();
