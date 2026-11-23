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

console.log('═══ 前端神经元数据核查 ═══');
console.log();

const d = await cdp.eval(`(function(){
  var N = window.__NEURON3D && window.__NEURON3D[0];
  if (!N) return { error: 'no neuron' };
  var S = N.state;
  return {
    scenes: S.scenes.length,
    edges: S.edges.length,
    sceneNames: S.scenes.map(function(n){ return n.name; }),
    edgeKinds: S.edges.reduce(function(acc, e){ acc[e.kind||'?'] = (acc[e.kind||'?']||0)+1; return acc; }, {}),
    // 找故障分析的边
    incidentEdges: S.edges.filter(function(e){
      var a = S.byId[e.a], b = S.byId[e.b];
      return (a && a.name === '故障分析') || (b && b.name === '故障分析');
    }).map(function(e){
      var a = S.byId[e.a], b = S.byId[e.b];
      return (a?a.name:'?') + ' -- ' + (b?b.name:'?') + ' [' + (e.kind||'?') + ']';
    }),
  };
})()`);

console.log(JSON.stringify(d, null, 2));
cdp.close();
