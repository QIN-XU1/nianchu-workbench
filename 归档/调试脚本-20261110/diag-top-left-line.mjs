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

console.log('═══ 精确定位：左上角斜线来自哪条边 ═══');
console.log();

// 先 tidy 恢复
await cdp.eval(`(function(){ window.__NEURON3D[0].tidy(); return true; })()`);
await new Promise(r => setTimeout(r, 800));

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
    return { sx: cx + x1*denom, sy: cy + y1*denom, z: z2 };
  }

  // 所有边的两端屏幕坐标
  var edges = [];
  for (var i = 0; i < S.edges.length; i++) {
    var e = S.edges[i];
    var na = S.byId[e.a], nb = S.byId[e.b];
    if (!na || !nb) continue;
    var pa = proj(na.sx, na.sy, na.sz);
    var pb = proj(nb.sx, nb.sy, nb.sz);

    // 判断是否接近左上角（x < 200 或 y < 200）
    var nearTopLeft = (pa.sx < 200 || pa.sy < 200 || pb.sx < 200 || pb.sy < 200);
    var bothOutside = (pa.sx < 0 || pa.sx > W || pa.sy < 0 || pa.sy > H) &&
                      (pb.sx < 0 || pb.sx > W || pb.sy < 0 || pb.sy > H);

    edges.push({
      a: e.a, b: e.b,
      aScreen: [Math.round(pa.sx), Math.round(pa.sy)],
      bScreen: [Math.round(pb.sx), Math.round(pb.sy)],
      nearTopLeft: nearTopLeft,
      bothOutside: bothOutside,
    });
  }

  return {
    canvas: { W: W, H: H },
    edges: edges,
    nodes: S.scenes.map(function(n){
      var p = proj(n.sx, n.sy, n.sz);
      return { name: n.name, screen: [Math.round(p.sx), Math.round(p.sy)], world: [Math.round(n.sx), Math.round(n.sy), Math.round(n.sz)] };
    }),
  };
})()`);

console.log('画布: ' + d.canvas.W + '×' + d.canvas.H);
console.log();
console.log('节点屏幕位置:');
for (const n of d.nodes) {
  const flag = (n.screen[0] < 0 || n.screen[0] > d.canvas.W || n.screen[1] < 0 || n.screen[1] > d.canvas.H) ? ' ★画布外' : '';
  console.log('  ' + n.name.padEnd(12) + '(' + String(n.screen[0]).padStart(5) + ',' + String(n.screen[1]).padStart(5) + ')' + flag);
}

console.log();
console.log('边（只显示靠近左上角的）:');
for (const e of d.edges) {
  if (e.nearTopLeft) {
    console.log('  ' + e.a + ' (' + e.aScreen + ') → ' + e.b + ' (' + e.bScreen + ')' +
      (e.bothOutside ? ' ★两端都在画布外' : ''));
  }
}

cdp.close();
