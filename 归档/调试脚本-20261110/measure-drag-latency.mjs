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

console.log('═══════════════════════════════════════════════════════════');
console.log('  拖拽延迟实测：鼠标位置 vs 节点渲染位置');
console.log('═══════════════════════════════════════════════════════════');
console.log();

// ── 先整理，恢复干净状态 ──
await cdp.eval(`(function(){ window.__NEURON3D[0].tidy(); return true; })()`);
await new Promise(r => setTimeout(r, 800));

// ── 找一个中间节点 ──
const info = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  var rect = cv.getBoundingClientRect();
  var W = cv.clientWidth, H = cv.clientHeight;
  var R = S.radius, fov = (S.radiusX || R) * 2.6 / S.zoom;
  var cx = W/2, cy = H/2;

  var best = null, bestD = 1e9;
  for (var i = 0; i < S.scenes.length; i++) {
    var n = S.scenes[i];
    var cyaw = Math.cos(S.yaw), syaw = Math.sin(S.yaw);
    var x1 = n.sx*cyaw + n.sz*syaw;
    var z1 = -n.sx*syaw + n.sz*cyaw;
    var cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
    var y1 = n.sy*cp - z1*sp;
    var z2 = n.sy*sp + z1*cp;
    var denom = fov/(fov+z2);
    var sx = cx + x1*denom, sy = cy + y1*denom;
    var d = Math.hypot(sx - cx, sy - cy);
    if (d < bestD) { bestD = d; best = { name: n.name, id: n.id, sx: sx, sy: sy, wx: n.sx, wy: n.sy, wz: n.sz }; }
  }
  return { node: best, box: { x: rect.x, y: rect.y }, W: W, H: H };
})()`);

console.log('目标节点: ' + info.node.name);
console.log('画布内位置: (' + Math.round(info.node.sx) + ',' + Math.round(info.node.sy) + ')');

const startX = info.box.x + info.node.sx;
const startY = info.box.y + info.node.sy;

// ── 按下 ──
await cdp.send('Input.dispatchMouseEvent', {
  type: 'mousePressed', x: startX, y: startY, button: 'left', clickCount: 1
});
await new Promise(r => setTimeout(r, 100));

// ── 移动鼠标 10 步，每步测量节点实际屏幕位置 ──
console.log();
console.log('  步  鼠标位置      节点屏幕位置    偏差(px)   耗时(ms)');
console.log('  ' + '─'.repeat(62));

const results = [];

for (let step = 1; step <= 10; step++) {
  const mx = startX + step * 20;
  const my = startY + step * 10;

  const t0 = Date.now();
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: mx, y: my, button: 'left', buttons: 1
  });

  // 等一帧让渲染完成
  await new Promise(r => setTimeout(r, 50));

  const t1 = Date.now();

  // 测量节点实际渲染位置
  const measured = await cdp.eval(`(function(){
    var N = window.__NEURON3D[0];
    var S = N.state;
    var n = S.scenes.find(function(x){ return x.id === '${info.node.id}'; });
    if (!n) return null;
    var cv = document.querySelector('[data-panel-type="neuron"] canvas');
    var W = cv.clientWidth, H = cv.clientHeight;
    var R = S.radius, fov = (S.radiusX || R) * 2.6 / S.zoom;
    var cx = W/2, cy = H/2;
    var cyaw = Math.cos(S.yaw), syaw = Math.sin(S.yaw);
    var x1 = n.sx*cyaw + n.sz*syaw;
    var z1 = -n.sx*syaw + n.sz*cyaw;
    var cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
    var y1 = n.sy*cp - z1*sp;
    var z2 = n.sy*sp + z1*cp;
    var denom = fov/(fov+z2);
    return { sx: cx + x1*denom, sy: cy + y1*denom, dragged: n.dragged };
  })()`);

  if (!measured) continue;

  // 鼠标在画布内的坐标
  const mouseLocalX = mx - info.box.x;
  const mouseLocalY = my - info.box.y;

  const dx = measured.sx - mouseLocalX;
  const dy = measured.sy - mouseLocalY;
  const dist = Math.sqrt(dx * dx + dy * dy);

  results.push({ step, mx: mouseLocalX, my: mouseLocalY, nx: measured.sx, ny: measured.sy, dist, ms: t1 - t0 });

  console.log('  ' + String(step).padStart(2) +
    '  (' + String(Math.round(mouseLocalX)).padStart(4) + ',' + String(Math.round(mouseLocalY)).padStart(4) + ')' +
    '  (' + String(Math.round(measured.sx)).padStart(4) + ',' + String(Math.round(measured.sy)).padStart(4) + ')' +
    '  ' + String(Math.round(dist)).padStart(7) + 'px' +
    '  ' + String(t1 - t0).padStart(5) + 'ms');
}

// ── 释放 ──
await cdp.send('Input.dispatchMouseEvent', {
  type: 'mouseReleased', x: startX + 200, y: startY + 100, button: 'left', clickCount: 1
});

console.log();
console.log('════ 分析 ════');
const avgDist = results.reduce((s, r) => s + r.dist, 0) / results.length;
const maxDist = Math.max(...results.map(r => r.dist));
const avgMs = results.reduce((s, r) => s + r.ms, 0) / results.length;

console.log('平均偏差: ' + Math.round(avgDist) + ' px');
console.log('最大偏差: ' + Math.round(maxDist) + ' px');
console.log('平均帧耗时: ' + Math.round(avgMs) + ' ms');
console.log();

if (avgDist < 5) {
  console.log('✓ 节点完全跟随鼠标（偏差 < 5px）');
} else if (avgDist < 20) {
  console.log('🟡 轻微偏差（' + Math.round(avgDist) + 'px）');
} else {
  console.log('🔴 明显延迟（' + Math.round(avgDist) + 'px）— 需要修');
}

cdp.close();
