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

const R = [];
function chk(name, pass, detail) {
  R.push({ name, pass: !!pass, detail: String(detail || '') });
  console.log((pass ? '  ✓ ' : '  ✗ ') + name.padEnd(38) + String(detail || '').slice(0, 50));
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  验证两个修复');
console.log('═══════════════════════════════════════════════════════════');
console.log();

await cdp.eval(`(function(){ var N=window.__NEURON3D[0]; N.resetView(); N.state.hover=null; N.state.sel=null; N.state.dragSnapshot=null; return true; })()`);
await new Promise(r => setTimeout(r, 600));

const box = await cdp.eval(`(function(){
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  var r = cv.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
})()`);

// ═══ 测试 1：旋转灵敏度 ═══
console.log('【测试 1】旋转灵敏度（应为 1572px/圈）');
await cdp.eval(`(function(){ window.__NEURON3D[0].resetView(); return true; })()`);
await new Promise(r => setTimeout(r, 300));

const cx = box.x + box.w / 2;
const cy = box.y + box.h / 2;
const yaw0 = await cdp.eval(`(function(){ return window.__NEURON3D[0].state.yaw; })()`);

await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
for (let i = 1; i <= 10; i++) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + i * 10, y: cy, button: 'left', buttons: 1 });
  await new Promise(r => setTimeout(r, 15));
}
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx + 100, y: cy, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 200));

const yaw1 = await cdp.eval(`(function(){ return window.__NEURON3D[0].state.yaw; })()`);
const deg = Math.abs((yaw1 - yaw0) * 180 / Math.PI);
const pxPerTurn = 360 / deg * 100;
console.log('  拖 100px → ' + deg.toFixed(1) + '°');
console.log('  推算一圈需 ' + Math.round(pxPerTurn) + 'px');
chk('旋转速度接近 OrbitControls 标准', Math.abs(pxPerTurn - 1572) < 100, Math.round(pxPerTurn) + 'px/圈 vs 1572');

// ═══ 测试 2：拖拽时划过节点是否高亮 ═══
console.log();
console.log('【测试 2】拖拽时划过节点（不该高亮）');

await cdp.eval(`(function(){ var N=window.__NEURON3D[0]; N.resetView(); N.state.hover=null; N.state.sel=null; N.state.dragSnapshot=null; return true; })()`);
await new Promise(r => setTimeout(r, 500));

// 找一个节点，记录它的位置
const nodeInfo = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  var W = cv.clientWidth, H = cv.clientHeight;
  var R = S.radius, fov = (S.radiusX || R) * 2.6 / S.zoom;
  var cx = W/2, cy = H/2;
  var n = S.scenes[0];
  var cyaw = Math.cos(S.yaw), syaw = Math.sin(S.yaw);
  var x1 = n.sx*cyaw + n.sz*syaw;
  var z1 = -n.sx*syaw + n.sz*cyaw;
  var cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
  var y1 = n.sy*cp - z1*sp;
  var z2 = n.sy*sp + z1*cp;
  var denom = fov/(fov+z2);
  return { name: n.name, sx: cx + x1*denom, sy: cy + y1*denom };
})()`);

const nodeX = box.x + nodeInfo.sx;
const nodeY = box.y + nodeInfo.sy;
console.log('  目标节点: ' + nodeInfo.name + ' @(' + Math.round(nodeX) + ',' + Math.round(nodeY) + ')');

// 在空白处按下
const emptyX = box.x + box.w * 0.85;
const emptyY = box.y + box.h * 0.9;

await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: emptyX, y: emptyY, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 100));

// 拖过节点位置
console.log('  拖拽路径经过节点...');
const steps = 12;
for (let i = 1; i <= steps; i++) {
  const t = i / steps;
  const mx = emptyX + (nodeX - emptyX) * t;
  const my = emptyY + (nodeY - emptyY) * t;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mx, y: my, button: 'left', buttons: 1 });
  await new Promise(r => setTimeout(r, 25));
}

const duringDrag = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  return { hover: S.hover ? S.hover.name : null, snapshot: S.dragSnapshot, rotating: !!S.rotating };
})()`);
console.log('  拖拽中: ' + JSON.stringify(duringDrag));

// 松手
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: nodeX, y: nodeY, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 400));

const afterDrag = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  var focusId = (S.hover && S.hover.id) || (S.sel && S.sel.id) || null;
  return { hover: S.hover ? S.hover.name : null, sel: S.sel ? S.sel.name : null, snapshot: S.dragSnapshot, focusId: focusId };
})()`);
console.log('  松手后: ' + JSON.stringify(afterDrag));

console.log();
chk('拖拽期间没记录快照（起始无高亮）', duringDrag.snapshot === null, duringDrag.snapshot || 'null');
chk('松手后快照已清除', afterDrag.snapshot === null, afterDrag.snapshot || 'null');
chk('松手后无残留高亮', afterDrag.focusId === null, afterDrag.focusId || 'null');

// ═══ 测试 3：拖拽前已有选中，拖拽时应保持，松手后仍保持 ═══
console.log();
console.log('【测试 3】先选中，再拖拽（选中应保持）');

await cdp.eval(`(function(){ var N=window.__NEURON3D[0]; N.resetView(); N.state.hover=null; N.state.sel=null; N.state.dragSnapshot=null; return true; })()`);
await new Promise(r => setTimeout(r, 400));

// 先点击节点选中
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nodeX, y: nodeY, button: 'none' });
await new Promise(r => setTimeout(r, 200));
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: nodeX, y: nodeY, button: 'left', clickCount: 1 });
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: nodeX, y: nodeY, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 300));

const afterClick = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  return { sel: S.sel ? S.sel.name : null };
})()`);
console.log('  点击选中: ' + JSON.stringify(afterClick));

// 再拖拽背景
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: emptyX, y: emptyY, button: 'left', clickCount: 1 });
for (let i = 1; i <= 6; i++) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: emptyX - i * 20, y: emptyY - i * 10, button: 'left', buttons: 1 });
  await new Promise(r => setTimeout(r, 20));
}
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: emptyX - 120, y: emptyY - 60, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 300));

const afterDrag2 = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  return { sel: S.sel ? S.sel.name : null, snapshot: S.dragSnapshot };
})()`);
console.log('  拖拽后: ' + JSON.stringify(afterDrag2));
chk('选中在拖拽后保持', afterDrag2.sel === afterClick.sel, afterDrag2.sel);

console.log();
const passed = R.filter(r => r.pass).length;
console.log('───────────────────────────────────────────────────────');
console.log('  结果: ' + passed + ' / ' + R.length);

cdp.close();
