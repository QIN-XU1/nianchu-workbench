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

console.log('═══ 节点球面分布诊断 ═══');
console.log();

const d = await cdp.eval(`(function(){
  var N = window.__NEURON3D;
  if (!N || !N.length) return { error: 'no neuron' };
  var S = N[0].state;
  if (!S.scenes || !S.scenes.length) return { error: 'no scenes' };

  var R = S.radius || 0;

  var nodes = S.scenes.map(function(n){
    return {
      name: n.name,
      domain: n.domain,
      x: Math.round(n.sx * 100) / 100,
      y: Math.round(n.sy * 100) / 100,
      z: Math.round(n.sz * 100) / 100,
      dist: Math.round(Math.sqrt(n.sx*n.sx + n.sy*n.sy + n.sz*n.sz) * 100) / 100,
    };
  });

  // 统计
  var dists = nodes.map(function(n){ return n.dist; });
  var xs = nodes.map(function(n){ return n.x; });
  var ys = nodes.map(function(n){ return n.y; });
  var zs = nodes.map(function(n){ return n.z; });

  var domains = {};
  for (var i=0;i<S.scenes.length;i++){
    var dm = S.scenes[i].domain;
    domains[dm] = (domains[dm]||0)+1;
  }

  return {
    R: Math.round(R),
    count: nodes.length,
    domains: domains,
    xRange: [Math.min(...xs), Math.max(...xs)],
    yRange: [Math.min(...ys), Math.max(...ys)],
    zRange: [Math.min(...zs), Math.max(...zs)],
    distRange: [Math.min(...dists), Math.max(...dists)],
    // 理想情况：所有节点 dist ≈ R（都在球面上）
    onSphere: nodes.filter(function(n){ return Math.abs(n.dist - R) < R*0.15; }).length,
    nodes: nodes,
  };
})()`);

console.log('  R = ' + d.R);
console.log('  节点数 = ' + d.count);
console.log('  领域分布 = ' + JSON.stringify(d.domains));
console.log();
console.log('  x 范围: ' + JSON.stringify(d.xRange));
console.log('  y 范围: ' + JSON.stringify(d.yRange));
console.log('  z 范围: ' + JSON.stringify(d.zRange));
console.log('  到球心距离范围: ' + JSON.stringify(d.distRange));
console.log('  ★ 在球面上的节点: ' + d.onSphere + ' / ' + d.count);
console.log();
console.log('  节点明细:');
for (const n of d.nodes) {
  console.log('    ' + String(n.name).padEnd(12) + n.domain.padEnd(10) +
    'x=' + String(n.x).padStart(7) + ' y=' + String(n.y).padStart(7) +
    ' z=' + String(n.z).padStart(7) + '  dist=' + String(n.dist).padStart(7));
}

cdp.close();
