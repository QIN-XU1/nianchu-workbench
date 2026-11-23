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
  console.log((pass ? '  ✓ ' : '  ✗ ') + name.padEnd(36) + String(detail || '').slice(0, 50));
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  验证：拖拽背景旋转时，高亮节点是否熄灭');
console.log('═══════════════════════════════════════════════════════════');
console.log();

await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  N.resetView();
  N.state.hover = null;
  N.state.sel = null;
  N.state.stickyFocus = null;
  return true;
})()`);
await new Promise(r => setTimeout(r, 600));

// ── 找节点 ──
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
console.log('目标节点: ' + info.node.name);

// ── ① 悬停 ──
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nodeX, y: nodeY, button: 'none' });
await new Promise(r => setTimeout(r, 400));

const s1 = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  return { hover: S.hover ? S.hover.name : null, sticky: S.stickyFocus };
})()`);
console.log();
console.log('① 悬停: ' + JSON.stringify(s1));
chk('悬停命中', s1.hover === info.node.name, s1.hover);
chk('粘滞焦点已记录', s1.sticky === 'self-review' || s1.sticky != null, s1.sticky);

// ── ② 鼠标移开节点（模拟"离开"）──
// 移到空白处但不按下
const emptyX = info.box.x + info.W * 0.9;
const emptyY = info.box.y + info.H * 0.95;
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: emptyX, y: emptyY, button: 'none' });
await new Promise(r => setTimeout(r, 400));

const s2 = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  // 计算实际 focusId
  var focusId = (S.hover && S.hover.id) || (S.sel && S.sel.id) || null;
  if (!focusId && S.stickyFocus) {
    var age = Date.now() - (S.stickyAt || 0);
    if (age < 90000 && S.byId[S.stickyFocus]) focusId = S.stickyFocus;
  }
  return { hover: S.hover ? S.hover.name : null, sticky: S.stickyFocus, focusId: focusId };
})()`);
console.log();
console.log('② 鼠标移开节点后: ' + JSON.stringify(s2));
chk('hover 已清除', s2.hover === null, s2.hover || 'null');
chk('粘滞焦点保留', s2.sticky != null, s2.sticky);
chk('focusId 仍指向该节点', s2.focusId === s2.sticky, s2.focusId);

// ── ③ 拖拽背景旋转 ──
console.log();
console.log('③ 拖拽背景旋转...');
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: emptyX, y: emptyY, button: 'left', clickCount: 1 });
for (let i = 1; i <= 6; i++) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: emptyX - i * 25, y: emptyY - i * 14, button: 'left', buttons: 1
  });
  await new Promise(r => setTimeout(r, 50));
}
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: emptyX - 150, y: emptyY - 84, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 400));

const s3 = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  var focusId = (S.hover && S.hover.id) || (S.sel && S.sel.id) || null;
  if (!focusId && S.stickyFocus) {
    var age = Date.now() - (S.stickyAt || 0);
    if (age < 90000 && S.byId[S.stickyFocus]) focusId = S.stickyFocus;
  }
  return { hover: S.hover ? S.hover.name : null, sticky: S.stickyFocus, focusId: focusId, yaw: Math.round(S.yaw*100)/100 };
})()`);
console.log();
console.log('④ 旋转结束后: ' + JSON.stringify(s3));
chk('旋转后 focusId 仍有效', s3.focusId != null, s3.focusId);
chk('高亮未熄灭', s3.focusId === s2.focusId, s3.focusId + ' (原 ' + s2.focusId + ')');

// ── ④ 截图对比 ──
const fs = await import('node:fs');
const ROOT = String.raw`D:\file\AI Temp\DeepSeek\Agent自研`;
const shot = await cdp.send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: 0, y: 90, width: 1230, height: 800, scale: 1 },
});
fs.writeFileSync(ROOT + '\\prototype\\screens\\sticky-focus.png', Buffer.from(shot.data, 'base64'));
console.log();
console.log('已保存 sticky-focus.png');

console.log();
const passed = R.filter(r => r.pass).length;
console.log('───────────────────────────────────────────────────────');
console.log('  结果: ' + passed + ' / ' + R.length);

cdp.close();
