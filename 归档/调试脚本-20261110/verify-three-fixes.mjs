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
console.log('  验证三项改动');
console.log('═══════════════════════════════════════════════════════════');
console.log();

// 重置
await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  N.resetView();
  S.viewScale = 1; S.panX = 0; S.panY = 0;
  S.hover = null; S.sel = null;
  N.update();
  return true;
})()`);
await new Promise(r => setTimeout(r, 500));

const box = await cdp.eval(`(function(){
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  var r = cv.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
})()`);

const cx = box.x + box.w / 2;
const cy = box.y + box.h / 2;

// ═══ 测试 1：滚轮缩放（应为 2D 等比）═══
console.log('【测试 1】滚轮缩放（2D 画布缩放）');

const scale0 = await cdp.eval(`(function(){ return window.__NEURON3D[0].state.viewScale; })()`);
console.log('  初始 viewScale: ' + scale0);

await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -100 });
await new Promise(r => setTimeout(r, 300));

const after1 = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  return { viewScale: Math.round(S.viewScale * 1000) / 1000, panX: Math.round(S.panX), panY: Math.round(S.panY) };
})()`);
console.log('  滚 1 格后: ' + JSON.stringify(after1));
chk('viewScale 增大', after1.viewScale > scale0, scale0 + ' → ' + after1.viewScale);

// 再滚几次
for (let i = 0; i < 3; i++) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -100 });
  await new Promise(r => setTimeout(r, 150));
}
const after2 = await cdp.eval(`(function(){ return Math.round(window.__NEURON3D[0].state.viewScale * 1000) / 1000; })()`);
console.log('  再滚 3 格: viewScale = ' + after2);

// ═══ 测试 2：缩放锚点（光标位置不动）═══
console.log();
console.log('【测试 2】缩放锚点（光标下的节点应保持不动）');

await cdp.eval(`(function(){ var N=window.__NEURON3D[0]; var S=N.state; S.viewScale=1; S.panX=0; S.panY=0; N.update(); return true; })()`);
await new Promise(r => setTimeout(r, 300));

// 找一个节点，记录它的屏幕位置
const nodePos = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  var W = cv.clientWidth, H = cv.clientHeight;
  var R = S.radius, fov = (S.radiusX || R) * 2.6 / S.zoom;
  var n = S.scenes[0];
  var cyaw = Math.cos(S.yaw), syaw = Math.sin(S.yaw);
  var x1 = n.sx*cyaw + n.sz*syaw;
  var z1 = -n.sx*syaw + n.sz*cyaw;
  var cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
  var y1 = n.sy*cp - z1*sp;
  var z2 = n.sy*sp + z1*cp;
  var denom = fov/(fov+z2);
  // 应用视图变换
  var vs = S.viewScale || 1, px = S.panX || 0, py = S.panY || 0;
  return {
    name: n.name,
    sx: (W/2 + x1*denom) * vs + px,
    sy: (H/2 + y1*denom) * vs + py,
  };
})()`);

const nodeAbsX = box.x + nodePos.sx;
const nodeAbsY = box.y + nodePos.sy;
console.log('  节点: ' + nodePos.name + ' @(' + Math.round(nodePos.sx) + ',' + Math.round(nodePos.sy) + ')');

// 把光标移到节点上，然后缩放
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nodeAbsX, y: nodeAbsY, button: 'none' });
await new Promise(r => setTimeout(r, 200));

for (let i = 0; i < 4; i++) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: nodeAbsX, y: nodeAbsY, deltaX: 0, deltaY: -100 });
  await new Promise(r => setTimeout(r, 150));
}

const nodeAfter = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  var W = cv.clientWidth, H = cv.clientHeight;
  var R = S.radius, fov = (S.radiusX || R) * 2.6 / S.zoom;
  var n = S.scenes[0];
  var cyaw = Math.cos(S.yaw), syaw = Math.sin(S.yaw);
  var x1 = n.sx*cyaw + n.sz*syaw;
  var z1 = -n.sx*syaw + n.sz*cyaw;
  var cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
  var y1 = n.sy*cp - z1*sp;
  var z2 = n.sy*sp + z1*cp;
  var denom = fov/(fov+z2);
  var vs = S.viewScale || 1, px = S.panX || 0, py = S.panY || 0;
  return { sx: (W/2 + x1*denom) * vs + px, sy: (H/2 + y1*denom) * vs + py, viewScale: S.viewScale };
})()`);

const dx = Math.abs(nodeAfter.sx - nodePos.sx);
const dy = Math.abs(nodeAfter.sy - nodePos.sy);
console.log('  缩放后位置: (' + Math.round(nodeAfter.sx) + ',' + Math.round(nodeAfter.sy) + ')  viewScale=' + nodeAfter.viewScale.toFixed(2));
console.log('  节点位移: ' + Math.round(Math.sqrt(dx*dx + dy*dy)) + 'px');
chk('缩放锚点生效（节点几乎不动）', Math.sqrt(dx*dx+dy*dy) < 15, '位移 ' + Math.round(Math.sqrt(dx*dx+dy*dy)) + 'px');

// ═══ 测试 3：边的类型统计 ═══
console.log();
console.log('【测试 3】连接层次（边的 kind 分布）');

const edgeStats = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  var kinds = {};
  for (var i = 0; i < S.edges.length; i++) {
    var k = S.edges[i].kind || 'unknown';
    kinds[k] = (kinds[k] || 0) + 1;
  }
  return { total: S.edges.length, kinds: kinds };
})()`);
console.log('  总边数: ' + edgeStats.total);
for (const k of Object.keys(edgeStats.kinds)) {
  console.log('    ' + k.padEnd(12) + edgeStats.kinds[k] + ' 条');
}
chk('连接层次已分级', Object.keys(edgeStats.kinds).length >= 2, Object.keys(edgeStats.kinds).join(', '));

// ═══ 测试 4：点击节点后，不相连的节点是否被错误高亮 ═══
console.log();
console.log('【测试 4】点击节点后的连接正确性');

await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  S.viewScale = 1; S.panX = 0; S.panY = 0;
  N.resetView();
  S.sel = S.scenes.find(function(x){ return x.name === '管线'; }) || S.scenes[0];
  N.update();
  return true;
})()`);
await new Promise(r => setTimeout(r, 400));

const connCheck = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var sel = S.sel;

  // 真实的邻居（从 edges 里查）
  var realNeighbors = [];
  for (var i = 0; i < S.edges.length; i++) {
    var e = S.edges[i];
    if (e.a === sel.id) realNeighbors.push(e.b);
    else if (e.b === sel.id) realNeighbors.push(e.a);
  }

  // 渲染时的高亮邻居（模拟 highlightLinks 构建）
  var focusNode = S.byId[sel.id];
  var hlNodes = new Set();
  hlNodes.add(focusNode.id);
  for (var nid of (focusNode.neighbors || [])) hlNodes.add(nid);

  return {
    selName: sel.name,
    realNeighborCount: realNeighbors.length,
    highlightedCount: hlNodes.size,
    // 检查是否有"非邻居"被高亮
    wrongHighlights: Array.from(hlNodes).filter(function(id){
      return id !== sel.id && realNeighbors.indexOf(id) < 0;
    }),
  };
})()`);

console.log('  选中: ' + connCheck.selName);
console.log('  真实邻居: ' + connCheck.realNeighborCount + ' 个');
console.log('  高亮节点: ' + connCheck.highlightedCount + ' 个（含自己）');
console.log('  错误高亮: ' + (connCheck.wrongHighlights.length ? connCheck.wrongHighlights.join(', ') : '无'));
chk('无错误高亮（索引错位已修）', connCheck.wrongHighlights.length === 0, connCheck.wrongHighlights.join(',') || '正确');

console.log();
const passed = R.filter(r => r.pass).length;
console.log('───────────────────────────────────────────────────────');
console.log('  结果: ' + passed + ' / ' + R.length);

cdp.close();
