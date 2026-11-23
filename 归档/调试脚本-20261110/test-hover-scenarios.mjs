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
console.log('  场景 B：拖拽结束、鼠标移开后，高亮是否残留');
console.log('═══════════════════════════════════════════════════════════');
console.log();

await cdp.eval(`(function(){ window.__NEURON3D[0].resetView(); window.__NEURON3D[0].state.hover=null; window.__NEURON3D[0].state.sel=null; return true; })()`);
await new Promise(r => setTimeout(r, 600));

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
    if (d < bestD) { bestD = d; best = { name: n.name, sx: sx, sy: sy }; }
  }
  return { node: best, box: { x: rect.x, y: rect.y }, W: W, H: H };
})()`);

const nodeX = info.box.x + info.node.sx;
const nodeY = info.box.y + info.node.sy;

// 悬停
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nodeX, y: nodeY, button: 'none' });
await new Promise(r => setTimeout(r, 400));

const before = await cdp.eval(`(function(){ var S = window.__NEURON3D[0].state; return { hover: S.hover ? S.hover.name : null }; })()`);
console.log('① 悬停在节点上: ' + JSON.stringify(before));

// 在空白按下并旋转（模拟真实拖背景）
const emptyX = info.box.x + info.W * 0.9;
const emptyY = info.box.y + info.H * 0.9;

await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: emptyX, y: emptyY, button: 'left', clickCount: 1 });
for (let i = 1; i <= 5; i++) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: emptyX - i * 25, y: emptyY - i * 12, button: 'left', buttons: 1
  });
  await new Promise(r => setTimeout(r, 50));
}
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: emptyX - 125, y: emptyY - 60, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 300));

const afterRotate = await cdp.eval(`(function(){ var S = window.__NEURON3D[0].state; return { hover: S.hover ? S.hover.name : null }; })()`);
console.log('② 旋转结束后: ' + JSON.stringify(afterRotate));

// ── 关键测试：鼠标移出画布后，hover 是否被清除？──
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1900, y: 1100, button: 'none' });
await new Promise(r => setTimeout(r, 300));

const afterLeave = await cdp.eval(`(function(){ var S = window.__NEURON3D[0].state; return { hover: S.hover ? S.hover.name : null, inside: S.mouse.inside }; })()`);
console.log('③ 鼠标移出画布后: ' + JSON.stringify(afterLeave));

// ── 再测：拖拽结束后鼠标停在节点上，高亮是否还在 ──
await cdp.eval(`(function(){ window.__NEURON3D[0].state.hover=null; return true; })()`);
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nodeX, y: nodeY, button: 'none' });
await new Promise(r => setTimeout(r, 300));

const rehover = await cdp.eval(`(function(){ var S = window.__NEURON3D[0].state; return { hover: S.hover ? S.hover.name : null }; })()`);
console.log();
console.log('④ 重新悬停到节点: ' + JSON.stringify(rehover));

// ── 旋转（鼠标正按在节点上时旋转）──
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: nodeX, y: nodeY, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 100));

const onNodeDown = await cdp.eval(`(function(){ var S = window.__NEURON3D[0].state; return { draggingNode: S.draggingNode ? S.draggingNode.name : null, hover: S.hover ? S.hover.name : null }; })()`);
console.log('⑤ 在节点上按下（会拖节点而非旋转）: ' + JSON.stringify(onNodeDown));

await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: nodeX, y: nodeY, button: 'left', clickCount: 1 });

console.log();
console.log('════ 结论 ════');
if (afterLeave.hover) {
  console.log('✗ 鼠标移出画布后 hover 仍残留（"' + afterLeave.hover + '"）');
  console.log('  → 这是 bug：移出后应该清除悬停');
  console.log('  → 但你说的"熄灭"可能相反——是希望**保持**高亮');
} else {
  console.log('✓ 鼠标移出后 hover 正常清除');
}
if (afterRotate.hover === before.hover) {
  console.log('✓ 旋转不会清除 hover');
}

cdp.close();
