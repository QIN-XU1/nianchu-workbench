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
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 40000); });
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

console.log('═══ 3080 引擎的会话全貌 ═══');
console.log();

const r = await cdp.eval(`(async function(){
  try {
    var res = await window.app.engine.rpc('session/list', { _request: {} });
    if (!res.ok) return { err: res.err, raw: res.raw };
    var items = (res.value && res.value.items) || [];

    // 分类：running / 空白 / 有内容的
    var running = items.filter(function(x){ return x.running; });
    var withSeq = items.filter(function(x){ return x.projections && x.projections.asOfSeq > 10; });
    var ours = items.filter(function(x){ return x.sessionId && x.sessionId.indexOf('session-') === 0; });

    return {
      total: items.length,
      running: running.length,
      runningList: running.map(function(x){ return { id: x.sessionId, seq: x.projections && x.projections.asOfSeq }; }),
      withContent: withSeq.length,
      // 最近的几个
      recent: items.slice(0, 5).map(function(x){
        return {
          id: x.sessionId,
          seq: x.projections && x.projections.asOfSeq,
          running: x.running,
          blank: x.blank,
          updatedAt: x.updatedAt,
        };
      }),
    };
  } catch(e) { return { error: String(e) }; }
})()`);

console.log(JSON.stringify(r, null, 2).slice(0, 1000));

cdp.close();
