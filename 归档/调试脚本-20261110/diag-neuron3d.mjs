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
    close() { try { ws.close(); } catch { /* ignore */ } }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

const out = await cdp.eval(`(function(){
  var G = window.__WB && window.__WB.neuron3d;
  if(!G || !G.length) return {error:'no neuron instance'};
  var inst = G[0];
  var S = inst.state;
  if(!S) return {error:'no state'};
  var nodes = S.visNodes || S.nodes || [];
  var xs=[],ys=[],zs=[];
  for(var i=0;i<nodes.length;i++){ xs.push(nodes[i].x||0); ys.push(nodes[i].y||0); zs.push(nodes[i].z||0); }
  return {
    count: nodes.length,
    xRange: [Math.min.apply(null,xs).toFixed(2), Math.max.apply(null,xs).toFixed(2)],
    yRange: [Math.min.apply(null,ys).toFixed(2), Math.max.apply(null,ys).toFixed(2)],
    zRange: [Math.min.apply(null,zs).toFixed(2), Math.max.apply(null,zs).toFixed(2)],
    yaw: S.yaw, pitch: S.pitch, zoom: S.zoom,
    nodes: nodes.slice(0,6).map(function(n){ return {label:n.label, type:n.type, x:+n.x.toFixed(2), y:+n.y.toFixed(2), z:+n.z.toFixed(2), r:n.r}; }),
  };
})()`);

console.log('═══ 3D 节点分布 ═══');
console.log(JSON.stringify(out, null, 2).slice(0, 900));

cdp.close();
