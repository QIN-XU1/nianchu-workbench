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

console.log('═══ 自检：左上角斜线 + 实例数 ═══');
console.log();

const d = await cdp.eval(`(function(){
  var N = window.__NEURON3D;
  var S = N && N.length ? N[0].state : null;

  // 检查边数据
  var edgeInfo = [];
  if (S && S.edges) {
    for (var i = 0; i < S.edges.length; i++) {
      var e = S.edges[i];
      var na = S.byId[e.a], nb = S.byId[e.b];
      // 检查是否有节点在世界外（可能造成超出画布的线）
      var outOfRange = false;
      if (na) {
        var d1 = Math.sqrt(na.sx*na.sx + na.sy*na.sy + na.sz*na.sz);
        if (d1 > (S.radius || 1) * 1.6) outOfRange = true;
      }
      if (nb) {
        var d2 = Math.sqrt(nb.sx*nb.sx + nb.sy*nb.sy + nb.sz*nb.sz);
        if (d2 > (S.radius || 1) * 1.6) outOfRange = true;
      }
      edgeInfo.push({
        a: e.a, b: e.b,
        aExists: !!na, bExists: !!nb,
        outOfRange: outOfRange,
      });
    }
  }

  return {
    instanceCount: N ? N.length : 0,
    destroyedCount: N ? N.filter(function(x){ return x.state && x.state.destroyed; }).length : 0,
    sceneCount: S ? S.scenes.length : 0,
    edgeCount: S ? S.edges.length : 0,
    edges: edgeInfo,
    radius: S ? Math.round(S.radius) : 0,
    // 检查所有节点是否在合理范围
    nodesOutOfRange: S ? S.scenes.filter(function(n){
      var dist = Math.sqrt(n.sx*n.sx + n.sy*n.sy + n.sz*n.sz);
      return dist > S.radius * 1.6;
    }).map(function(n){ return n.name; }) : [],
  };
})()`);

console.log('实例数: ' + d.instanceCount + '（已销毁: ' + d.destroyedCount + '）');
console.log('场景数: ' + d.sceneCount);
console.log('边数: ' + d.edgeCount);
console.log('radius: ' + d.radius);
console.log();
console.log('越界节点: ' + (d.nodesOutOfRange.length ? d.nodesOutOfRange.join(', ') : '无'));
console.log();
console.log('边检查:');
for (const e of d.edges) {
  const flag = (!e.aExists || !e.bExists) ? ' ★节点缺失' : (e.outOfRange ? ' ★越界' : '');
  console.log('  ' + e.a + ' → ' + e.b + flag);
}

cdp.close();
