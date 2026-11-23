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

console.log('═══ 找 neuron3d 实例 ═══');
console.log();

const found = await cdp.eval(`(function(){
  return {
    __NEURON3D: !!window.__NEURON3D,
    len: window.__NEURON3D ? window.__NEURON3D.length : -1,
    __WB_keys: window.__WB ? Object.keys(window.__WB) : [],
  };
})()`);
console.log(JSON.stringify(found, null, 2));

if (found.__NEURON3D && found.len > 0) {
  const st = await cdp.eval(`(function(){
    var S = window.__NEURON3D[0].state;
    var nodes = S.visNodes || S.nodes || [];
    var allNodes = S.nodes || [];
    return {
      visCount: nodes.length,
      allCount: allNodes.length,
      ready: S.ready,
      filter: S.filter,
      layers: allNodes.reduce(function(acc,n){
        var k = (n.shell === 0 || n.shell === 0.0) ? 'core' : (n.shell < 0.9 ? 'mem' : 'scene');
        acc[k] = (acc[k]||0)+1; return acc;
      }, {}),
      shellValues: [...new Set(allNodes.map(function(n){ return n.shell; }))],
      types: [...new Set(allNodes.map(function(n){ return n.type; }))],
      samples: allNodes.slice(0, 6).map(function(n){
        return {label:n.label, type:n.type, shell:n.shell, r:n.r,
          x: (n.x===null||n.x===undefined)?'NULL':Math.round(n.x*1000)/1000,
          y: (n.y===null||n.y===undefined)?'NULL':Math.round(n.y*1000)/1000,
          z: (n.z===null||n.z===undefined)?'NULL':Math.round(n.z*1000)/1000};
      }),
    };
  })()`);
  console.log();
  console.log(JSON.stringify(st, null, 2).slice(0, 1200));
} else {
  console.log();
  console.log('⚠ __NEURON3D 不存在，说明渲染器还没执行到暴露那一步');
}

cdp.close();
