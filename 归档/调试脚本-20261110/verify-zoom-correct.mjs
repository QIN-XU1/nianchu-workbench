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
  console.log((pass ? '  ✓ ' : '  ✗ ') + name.padEnd(36) + String(detail || '').slice(0, 60));
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  验证：缩放是否改变节点位置（自检修正版）');
console.log('═══════════════════════════════════════════════════════════');
console.log();

// ── 步骤 1：等待整理动画完全结束（关键！）──
await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  if (typeof N.tidy === 'function') N.tidy();
  return true;
})()`);
console.log('① 调用 tidy()，等待动画完全结束（1000ms）...');
await new Promise(r => setTimeout(r, 1000));

// ── 步骤 2：确认无动画中（tidying = false）──
const idle = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  return { tidying: !!S.tidying, draggedCount: S.scenes.filter(function(n){return n.dragged;}).length };
})()`);
console.log('   状态: tidying=' + idle.tidying + ' dragged=' + idle.draggedCount);
chk('整理动画已结束', !idle.tidying, 'tidying=' + idle.tidying);
chk('无拖拽节点', idle.draggedCount === 0, 'dragged=' + idle.draggedCount);

// ── 步骤 3：记录基准坐标 ──
const before = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  return {
    zoom: S.zoom,
    radius: Math.round(S.radius),
    canvasW: document.querySelector('[data-panel-type="neuron"] canvas').clientWidth,
    canvasH: document.querySelector('[data-panel-type="neuron"] canvas').clientHeight,
    coords: S.scenes.map(function(n){
      return { id: n.id, x: Math.round(n.sx*100)/100, y: Math.round(n.sy*100)/100, z: Math.round(n.sz*100)/100 };
    }),
  };
})()`);
console.log();
console.log('② 基准状态:');
console.log('   zoom=' + before.zoom + '  radius=' + before.radius + '  画布=' + before.canvasW + '×' + before.canvasH);
console.log('   前 2 个节点: ' + JSON.stringify(before.coords.slice(0, 2)));

// ── 步骤 4：只改 zoom 并渲染（不重排）──
await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  S.zoom = S.zoom * 1.5;     // 放大 50%
  N.update();
  return S.zoom;
})()`);
await new Promise(r => setTimeout(r, 300));

// ── 步骤 5：对比 ──
const after = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  return {
    zoom: S.zoom,
    radius: Math.round(S.radius),
    canvasW: document.querySelector('[data-panel-type="neuron"] canvas').clientWidth,
    canvasH: document.querySelector('[data-panel-type="neuron"] canvas').clientHeight,
    coords: S.scenes.map(function(n){
      return { id: n.id, x: Math.round(n.sx*100)/100, y: Math.round(n.sy*100)/100, z: Math.round(n.sz*100)/100 };
    }),
  };
})()`);
console.log();
console.log('③ 缩放后:');
console.log('   zoom=' + after.zoom + '  radius=' + after.radius + '  画布=' + after.canvasW + '×' + after.canvasH);
console.log('   前 2 个节点: ' + JSON.stringify(after.coords.slice(0, 2)));

// ── 判定 ──
console.log();
console.log('④ 判定:');
chk('zoom 已改变', Math.abs(after.zoom - before.zoom) > 0.01, before.zoom + ' → ' + after.zoom);
chk('canvas 尺寸未变', after.canvasW === before.canvasW && after.canvasH === before.canvasH,
    before.canvasW + '×' + before.canvasH);
chk('radius 未变', Math.abs(after.radius - before.radius) < 1,
    before.radius + ' → ' + after.radius);

let maxDelta = 0;
for (let i = 0; i < before.coords.length; i++) {
  const a = before.coords[i];
  const b = after.coords[i];
  if (!a || !b) continue;
  const d = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
  if (d > maxDelta) maxDelta = d;
}

chk('节点世界坐标未变', maxDelta < 0.5, '最大变化 ' + maxDelta.toFixed(2) + 'px');

console.log();
const passed = R.filter(r => r.pass).length;
console.log('───────────────────────────────────────────────────────');
console.log('  结果: ' + passed + ' / ' + R.length);

if (maxDelta < 0.5) {
  console.log();
  console.log('  ✓ 缩放只改变"视角"，不改变"布局"');
  console.log('    这正是修复目标：缩放不再强制重排页面');
}

cdp.close();
