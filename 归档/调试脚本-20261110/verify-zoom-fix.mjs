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
  R.push({ name, pass: !!pass, detail });
  console.log((pass ? '  ✓ ' : '  ✗ ') + name.padEnd(34) + (detail || ''));
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  验证：整理后缩放是否会强制更改页面');
console.log('═══════════════════════════════════════════════════════════');
console.log();

// ── ① 先整理（复位到标准位置）──
await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  N.state.draggedCount = 0;
  if (typeof N.tidy === 'function') N.tidy();
  return true;
})()`);
await new Promise(r => setTimeout(r, 700));

// ── ② 记录整理后的世界坐标（基准）──
const before = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  return {
    zoom: S.zoom,
    radius: Math.round(S.radius),
    coords: S.scenes.map(function(n){
      return { id: n.id, x: Math.round(n.sx*100)/100, y: Math.round(n.sy*100)/100, z: Math.round(n.sz*100)/100 };
    }),
  };
})()`);
console.log('① 整理后基准:');
console.log('   zoom=' + before.zoom + '  radius=' + before.radius);
console.log('   前 3 个节点坐标: ' + JSON.stringify(before.coords.slice(0, 3)));

// ── ③ 执行缩放（模拟滚轮）──
await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  // 模拟滚轮放大 3 次
  for (var i = 0; i < 3; i++) {
    S.zoom = Math.max(0.5, Math.min(2.0, S.zoom * 1.07));
  }
  N.update();   // 这会调用 layout() + render()
  return S.zoom;
})()`);
await new Promise(r => setTimeout(r, 400));

// ── ④ 记录缩放后的世界坐标 ──
const after = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  return {
    zoom: S.zoom,
    radius: Math.round(S.radius),
    coords: S.scenes.map(function(n){
      return { id: n.id, x: Math.round(n.sx*100)/100, y: Math.round(n.sy*100)/100, z: Math.round(n.sz*100)/100 };
    }),
  };
})()`);
console.log();
console.log('② 缩放后:');
console.log('   zoom=' + after.zoom + '  radius=' + after.radius);
console.log('   前 3 个节点坐标: ' + JSON.stringify(after.coords.slice(0, 3)));

// ── ⑤ 对比 ──
console.log();
console.log('③ 判定:');

const zoomChanged = Math.abs(after.zoom - before.zoom) > 0.01;
chk('zoom 确实改变了', zoomChanged, before.zoom + ' → ' + after.zoom);

// 关键判定：世界坐标是否保持不变
let maxDelta = 0;
let changedCount = 0;
for (let i = 0; i < before.coords.length; i++) {
  const a = before.coords[i];
  const b = after.coords[i];
  if (!a || !b || a.id !== b.id) continue;
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  const dz = Math.abs(a.z - b.z);
  const d = Math.max(dx, dy, dz);
  if (d > maxDelta) maxDelta = d;
  if (d > 1) changedCount++;
}

console.log('   世界坐标最大变化: ' + maxDelta.toFixed(2) + ' px');
console.log('   坐标变化的节点数: ' + changedCount + ' / ' + before.coords.length);

if (maxDelta < 1 && changedCount === 0) {
  chk('缩放不改变节点世界坐标', true, '最大变化 ' + maxDelta.toFixed(2) + 'px');
} else {
  chk('缩放不改变节点世界坐标', false, '最大变化 ' + maxDelta.toFixed(2) + 'px（应接近 0）');
}

// radius 不应随 zoom 变化
const radiusSame = Math.abs(after.radius - before.radius) < 1;
chk('radius 不随 zoom 变化', radiusSame, before.radius + ' → ' + after.radius);

console.log();
const passed = R.filter(r => r.pass).length;
console.log('───────────────────────────────────────────────────────');
console.log('  结果: ' + passed + ' / ' + R.length);

cdp.close();
