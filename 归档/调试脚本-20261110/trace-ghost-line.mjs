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

console.log('═══ 追查幽灵折线 ═══');
console.log();

// ① 先检查 Bloom 离屏画布状态
const bloomCheck = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  return {
    hasBloomCanvas: !!(S.bloomCanvas || (N.__bloomCanvas)),
    note: '无法直接访问闭包内的 bloomCanvas',
  };
})()`);
console.log('① Bloom 画布: ' + JSON.stringify(bloomCheck));

// ② 追踪所有 stroke，找出没有节点在端点的线
console.log();
console.log('② 追踪 stroke 路径（找悬空线）:');

const trace = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  var ctx = cv.getContext('2d');

  // 目标区域：(945, 500) 附近
  var TARGET_X = 990, TARGET_Y = 550, TOL = 60;

  var strokes = [];
  var path = [];
  var curStyle = null;
  var curWidth = null;

  var origMoveTo = ctx.moveTo.bind(ctx);
  var origLineTo = ctx.lineTo.bind(ctx);
  var origQuad = ctx.quadraticCurveTo.bind(ctx);
  var origStroke = ctx.stroke.bind(ctx);

  ctx.moveTo = function(x, y) {
    path = [{ op: 'M', x: x, y: y }];
    return origMoveTo(x, y);
  };
  ctx.lineTo = function(x, y) {
    path.push({ op: 'L', x: x, y: y });
    return origLineTo(x, y);
  };
  ctx.quadraticCurveTo = function(cx, cy, x, y) {
    path.push({ op: 'Q', cx: cx, cy: cy, x: x, y: y });
    return origQuad(cx, cy, x, y);
  };
  ctx.stroke = function() {
    // 检查路径是否经过目标区域
    var hit = false;
    for (var i = 0; i < path.length; i++) {
      var p = path[i];
      if (p.x !== undefined &&
          Math.abs(p.x - TARGET_X) < TOL &&
          Math.abs(p.y - TARGET_Y) < TOL) {
        hit = true;
      }
      if (p.cx !== undefined &&
          Math.abs(p.cx - TARGET_X) < TOL &&
          Math.abs(p.cy - TARGET_Y) < TOL) {
        hit = true;
      }
    }
    if (hit) {
      strokes.push({
        style: String(ctx.strokeStyle).slice(0, 50),
        width: ctx.lineWidth,
        segments: path.length,
        path: path.map(function(q){
          if (q.op === 'M') return 'M(' + Math.round(q.x) + ',' + Math.round(q.y) + ')';
          if (q.op === 'L') return 'L(' + Math.round(q.x) + ',' + Math.round(q.y) + ')';
          return 'Q(' + Math.round(q.cx) + ',' + Math.round(q.cy) + ' -> ' + Math.round(q.x) + ',' + Math.round(q.y) + ')';
        }).join(' '),
      });
    }
    path = [];
    return origStroke();
  };

  // 渲染一帧
  N.update();

  ctx.moveTo = origMoveTo;
  ctx.lineTo = origLineTo;
  ctx.quadraticCurveTo = origQuad;
  ctx.stroke = origStroke;

  // 同时取出所有节点的屏幕位置，判断这条线是否连接节点
  var R = S.radius, fov = (S.radiusX || R) * 2.6 / S.zoom;
  var W = cv.clientWidth, H = cv.clientHeight;
  var cx = W/2, cy = H/2;
  var nodeScreens = [];
  for (var i = 0; i < S.scenes.length; i++) {
    var n = S.scenes[i];
    var cyaw = Math.cos(S.yaw), syaw = Math.sin(S.yaw);
    var x1 = n.sx*cyaw + n.sz*syaw;
    var z1 = -n.sx*syaw + n.sz*cyaw;
    var cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
    var y1 = n.sy*cp - z1*sp;
    var z2 = n.sy*sp + z1*cp;
    var denom = fov/(fov+z2);
    nodeScreens.push({
      name: n.name,
      x: Math.round(cx + x1*denom),
      y: Math.round(cy + y1*denom),
    });
  }

  return { strokes: strokes, nodeScreens: nodeScreens };
})()`);

if (trace.__exception) {
  console.log('ERROR: ' + trace.__exception);
} else {
  console.log('命中目标区域的 stroke: ' + trace.strokes.length);
  for (const s of trace.strokes) {
    console.log('  颜色: ' + s.style);
    console.log('  线宽: ' + s.width + '  段数: ' + s.segments);
    console.log('  路径: ' + s.path);
    console.log();
  }

  console.log('节点屏幕位置（检查端点是否接节点）:');
  for (const n of trace.nodeScreens) {
    const near = Math.abs(n.x - 990) < 100 && Math.abs(n.y - 550) < 100;
    console.log('  ' + n.name.padEnd(12) + '(' + String(n.x).padStart(4) + ',' + String(n.y).padStart(4) + ')' + (near ? ' ★接近目标区域' : ''));
  }
}

cdp.close();
