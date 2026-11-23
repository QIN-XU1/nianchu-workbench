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
console.log('  复现：拖拽背景旋转时，高亮节点是否熄灭');
console.log('═══════════════════════════════════════════════════════════');
console.log();

// ── 重置 ──
await cdp.eval(`(function(){ window.__NEURON3D[0].resetView(); window.__NEURON3D[0].state.hover=null; return true; })()`);
await new Promise(r => setTimeout(r, 600));

// ── ① 找一个节点，悬停上去 ──
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
    if (d < bestD) { bestD = d; best = { name: n.name, id: n.id, sx: sx, sy: sy }; }
  }
  return { node: best, box: { x: rect.x, y: rect.y }, W: W, H: H };
})()`);

console.log('目标节点: ' + info.node.name + ' @(' + Math.round(info.node.sx) + ',' + Math.round(info.node.sy) + ')');

const nodeX = info.box.x + info.node.sx;
const nodeY = info.box.y + info.node.sy;

// ── ② 悬停到节点上 ──
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nodeX, y: nodeY, button: 'none' });
await new Promise(r => setTimeout(r, 400));

const s1 = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  return { hover: S.hover ? S.hover.name : null, sel: S.sel ? S.sel.name : null, draggingNode: !!S.draggingNode, rotating: !!S.rotating };
})()`);
console.log();
console.log('① 悬停后: ' + JSON.stringify(s1));

// ── ③ 在空白处按下（准备旋转）──
// 找一个远离节点的空白位置
const emptyX = info.box.x + info.W * 0.85;
const emptyY = info.box.y + info.H * 0.85;

console.log();
console.log('② 在空白处按下: (' + Math.round(emptyX) + ',' + Math.round(emptyY) + ')');
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: emptyX, y: emptyY, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 200));

const s2 = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  return { hover: S.hover ? S.hover.name : null, rotating: !!S.rotating, mouseInside: S.mouse.inside };
})()`);
console.log('   按下后: ' + JSON.stringify(s2));

// ── ④ 拖动旋转 ──
console.log();
console.log('③ 拖动旋转...');
for (let i = 1; i <= 6; i++) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: emptyX - i * 20, y: emptyY - i * 10, button: 'left', buttons: 1
  });
  await new Promise(r => setTimeout(r, 60));
}

const s3 = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  return { hover: S.hover ? S.hover.name : null, rotating: !!S.rotating, yaw: Math.round(S.yaw*100)/100 };
})()`);
console.log('   旋转中: ' + JSON.stringify(s3));

// ── ⑤ 释放 ──
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: emptyX - 120, y: emptyY - 60, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 300));

const s4 = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  return { hover: S.hover ? S.hover.name : null, rotating: !!S.rotating };
})()`);
console.log('   释放后: ' + JSON.stringify(s4));

// ── 判定 ──
console.log();
console.log('════ 判定 ════');
const kept = s3.hover === info.node.name || s4.hover === info.node.name;
console.log('悬停节点: ' + info.node.name);
console.log('旋转中 hover: ' + (s3.hover || 'null'));
console.log('释放后 hover: ' + (s4.hover || 'null'));
console.log(kept ? '✓ 高亮未熄灭' : '✗ 高亮熄灭了（复现成功）');

cdp.close();
