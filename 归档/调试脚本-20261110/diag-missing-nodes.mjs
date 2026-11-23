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

console.log('═══ 自检：节点可见性 + 长直线来源 ═══');
console.log();

const d = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  var W = cv.clientWidth, H = cv.clientHeight;
  var R = S.radius, fov = (S.radiusX || R) * 2.6 / S.zoom;
  var cx = W/2, cy = H/2;

  function proj(wx, wy, wz) {
    var cyaw = Math.cos(S.yaw), syaw = Math.sin(S.yaw);
    var x1 = wx*cyaw + wz*syaw;
    var z1 = -wx*syaw + wz*cyaw;
    var cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
    var y1 = wy*cp - z1*sp;
    var z2 = wy*sp + z1*cp;
    var denom = fov/(fov+z2);
    return { sx: cx + x1*denom, sy: cy + y1*denom, z: z2, scale: denom };
  }

  // 所有节点的屏幕位置 + 深度
  var nodes = [];
  for (var i = 0; i < S.scenes.length; i++) {
    var n = S.scenes[i];
    var p = proj(n.sx, n.sy, n.sz);
    nodes.push({
      name: n.name,
      screen: [Math.round(p.sx), Math.round(p.sy)],
      z: Math.round(p.z),
      scale: Math.round(p.scale * 100) / 100,
      lit: n.lit,
      dragged: n.dragged,
      zNorm: Math.round(p.z / R * 100) / 100,
    });
  }

  // 所有边的两端
  var edgeLines = [];
  for (var i = 0; i < S.edges.length; i++) {
    var e = S.edges[i];
    var na = S.byId[e.a], nb = S.byId[e.b];
    if (!na || !nb) continue;
    var pa = proj(na.sx, na.sy, na.sz);
    var pb = proj(nb.sx, nb.sy, nb.sz);
    var len = Math.hypot(pb.sx - pa.sx, pb.sy - pa.sy);
    edgeLines.push({
      a: e.a, b: e.b,
      aScreen: [Math.round(pa.sx), Math.round(pa.sy)],
      bScreen: [Math.round(pb.sx), Math.round(pb.sy)],
      len: Math.round(len),
    });
  }

  return {
    W: W, H: H,
    nodes: nodes,
    edges: edgeLines,
    // 检查是否有节点落在画布外
    outOfCanvas: nodes.filter(function(n){
      return n.screen[0] < 0 || n.screen[0] > W || n.screen[1] < 0 || n.screen[1] > H;
    }).map(function(n){ return n.name; }),
    // 检查是否有节点 z 太靠后（会被淡到看不见）
    tooFarBack: nodes.filter(function(n){ return n.zNorm < -0.72; }).map(function(n){ return n.name + '(z=' + n.zNorm + ')'; }),
  };
})()`);

console.log('画布: ' + d.W + '×' + d.H);
console.log();
console.log('节点状态:');
for (const n of d.nodes) {
  const flag = (n.screen[0] < 0 || n.screen[0] > d.W || n.screen[1] < 0 || n.screen[1] > d.H) ? ' ★画布外' : '';
  const far = n.zNorm < -0.72 ? ' ★太靠后' : '';
  console.log('  ' + n.name.padEnd(12) + '(' + String(n.screen[0]).padStart(5) + ',' + String(n.screen[1]).padStart(4) + ')' +
    ' z=' + String(n.z).padStart(5) + ' (norm ' + String(n.zNorm).padStart(6) + ')' +
    ' scale=' + n.scale + flag + far);
}

console.log();
console.log('画布外节点: ' + (d.outOfCanvas.length ? d.outOfCanvas.join(', ') : '无'));
console.log('太靠后节点: ' + (d.tooFarBack.length ? d.tooFarBack.join(', ') : '无'));

console.log();
console.log('最长边（可能是那根贯穿线）:');
const sorted = d.edges.slice().sort((a, b) => b.len - a.len);
for (const e of sorted.slice(0, 3)) {
  console.log('  ' + e.a + ' → ' + e.b + '  长度 ' + e.len + 'px');
  console.log('     ' + e.aScreen + ' → ' + e.bScreen);
}

cdp.close();
