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
console.log('  缩放/旋转手感实测');
console.log('═══════════════════════════════════════════════════════════');
console.log();

await cdp.eval(`(function(){ window.__NEURON3D[0].resetView(); return true; })()`);
await new Promise(r => setTimeout(r, 500));

const box = await cdp.eval(`(function(){
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  var r = cv.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
})()`);
console.log('画布: ' + box.w + '×' + box.h);
console.log();

// ═══ 测试 1：滚轮缩放灵敏度 ═══
console.log('【测试 1】滚轮缩放灵敏度');
console.log('  一档滚轮（deltaY=100，普通鼠标一格的典型值）:');

const cx = box.x + box.w / 2;
const cy = box.y + box.h / 2;

for (let i = 1; i <= 5; i++) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -100
  });
  await new Promise(r => setTimeout(r, 150));
  const z = await cdp.eval(`(function(){ return window.__NEURON3D[0].state.zoom; })()`);
  console.log('    第 ' + i + ' 格 → zoom = ' + z.toFixed(3));
}

await cdp.eval(`(function(){ window.__NEURON3D[0].state.zoom = 1; window.__NEURON3D[0].update(); return true; })()`);
await new Promise(r => setTimeout(r, 200));

console.log();
console.log('  触控板（deltaY=3，极小的增量）:');
for (let i = 1; i <= 5; i++) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -3
  });
  await new Promise(r => setTimeout(r, 100));
  const z = await cdp.eval(`(function(){ return window.__NEURON3D[0].state.zoom; })()`);
  console.log('    第 ' + i + ' 次 → zoom = ' + z.toFixed(3));
}

console.log();
console.log('  AXES: 当前实现 zoom * (deltaY > 0 ? 0.93 : 1.07)');
console.log('        → deltaY 大小完全忽略，任何一次滚动都是固定比例');
console.log('        → 触控板滑动会疯狂缩放');

// ═══ 测试 2：缩放是否以鼠标为中心 ═══
console.log();
console.log('【测试 2】缩放是否以鼠标位置为中心');

await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  S.zoom = 1; S.yaw = 0.4; S.pitch = -0.25;
  // 清拖拽
  for (var i = 0; i < S.scenes.length; i++) S.scenes[i].dragged = false;
  N.update();
  return true;
})()`);
await new Promise(r => setTimeout(r, 300));

// 记录某节点在 zoom=1 时的位置
const before = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  var W = cv.clientWidth, H = cv.clientHeight;
  var R = S.radius, fov = (S.radiusX || R) * 2.6 / S.zoom;
  var n = S.scenes[5];
  var cyaw = Math.cos(S.yaw), syaw = Math.sin(S.yaw);
  var x1 = n.sx*cyaw + n.sz*syaw;
  var z1 = -n.sx*syaw + n.sz*cyaw;
  var cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
  var y1 = n.sy*cp - z1*sp;
  var z2 = n.sy*sp + z1*cp;
  var denom = fov/(fov+z2);
  return { name: n.name, x: W/2 + x1*denom, y: H/2 + y1*denom };
})()`);

// 把鼠标放到画布左上角，然后缩放
const cornerX = box.x + 100;
const cornerY = box.y + 100;

await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cornerX, y: cornerY, button: 'none' });
await new Promise(r => setTimeout(r, 200));

for (let i = 1; i <= 3; i++) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: cornerX, y: cornerY, deltaX: 0, deltaY: -100
  });
  await new Promise(r => setTimeout(r, 120));
}

const after = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  var W = cv.clientWidth, H = cv.clientHeight;
  var R = S.radius, fov = (S.radiusX || R) * 2.6 / S.zoom;
  var n = S.scenes[5];
  var cyaw = Math.cos(S.yaw), syaw = Math.sin(S.yaw);
  var x1 = n.sx*cyaw + n.sz*syaw;
  var z1 = -n.sx*syaw + n.sz*cyaw;
  var cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
  var y1 = n.sy*cp - z1*sp;
  var z2 = n.sy*sp + z1*cp;
  var denom = fov/(fov+z2);
  return { name: n.name, x: W/2 + x1*denom, y: H/2 + y1*denom, zoom: S.zoom };
})()`);

console.log('  鼠标在左上角 (100,100) 处滚动 3 格');
console.log('  节点"' + before.name + '":');
console.log('    缩放前: (' + Math.round(before.x) + ', ' + Math.round(before.y) + ')');
console.log('    缩放后: (' + Math.round(after.x) + ', ' + Math.round(after.y) + ')  zoom=' + after.zoom.toFixed(2));
console.log('  → 节点向**画布中心**移动，而非鼠标位置');
console.log('  → 这是"缩放不跟手"的根源');

// ═══ 测试 3：旋转灵敏度 ═══
console.log();
console.log('【测试 3】旋转灵敏度');

await cdp.eval(`(function(){ window.__NEURON3D[0].resetView(); return true; })()`);
await new Promise(r => setTimeout(r, 400));

const yaw0 = await cdp.eval(`(function(){ return window.__NEURON3D[0].state.yaw; })()`);

// 拖 100px
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
for (let i = 1; i <= 10; i++) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: cx + i * 10, y: cy, button: 'left', buttons: 1
  });
  await new Promise(r => setTimeout(r, 20));
}
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx + 100, y: cy, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 200));

const yaw1 = await cdp.eval(`(function(){ return window.__NEURON3D[0].state.yaw; })()`);
console.log('  拖 100px 横向 → yaw 变化 ' + ((yaw1 - yaw0) * 180 / Math.PI).toFixed(1) + '°');
console.log('  灵敏度: ' + (0.0080 * 180 / Math.PI).toFixed(2) + '°/px');
console.log('  → 100px = 45.8°，屏幕宽度 1221px 转一圈需 ' + Math.round(360 / 45.8 * 100) + 'px');
console.log('  → 转一圈需要约 ' + Math.round((360 / (yaw1 - yaw0) * 100) * 100) + 'px 拖拽（超过画布宽度）');

// ═══ 测试 4：pitch 钳制手感 ═══
console.log();
console.log('【测试 4】pitch 钳制（撞墙感）');

await cdp.eval(`(function(){ window.__NEURON3D[0].resetView(); return true; })()`);
await new Promise(r => setTimeout(r, 300));

await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
for (let i = 1; i <= 30; i++) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: cx, y: cy + i * 15, button: 'left', buttons: 1
  });
  await new Promise(r => setTimeout(r, 15));
}
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy + 450, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 200));

const pitch = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  return { pitch: S.pitch, deg: S.pitch * 180 / Math.PI };
})()`);
console.log('  向下拖 450px → pitch = ' + pitch.pitch.toFixed(3) + ' (' + pitch.deg.toFixed(1) + '°)');
console.log('  钳制值 ±1.40 rad = ±80.2°');
console.log('  实际到达 ' + pitch.deg.toFixed(1) + '° → ' + (Math.abs(pitch.pitch) >= 1.40 - 0.001 ? '★ 撞到钳制边界（硬停，生硬）' : '未到边界'));

cdp.close();
