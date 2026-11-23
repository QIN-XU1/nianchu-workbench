/**
 * 交互体验全面审计
 *
 * 用真实鼠标事件（CDP Input）模拟用户操作，逐个验证交互是否顺手。
 *
 * 审计维度：
 *   ① 鼠标交互（悬停/点击/拖拽/滚轮）
 *   ② 视觉反馈（是否有响应、响应是否明显）
 *   ③ 边界情况（快速操作、极端位置）
 *   ④ 状态一致性（操作后状态是否同步）
 */

const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  const errs = [];
  const logs = [];
  return {
    errs, logs,
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 8000);
        ws.addEventListener('open', () => { clearTimeout(t); res(); });
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('失败')); });
        ws.addEventListener('message', (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch { return; }
          if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params.exceptionDetails;
            errs.push((d.exception?.description || d.text || '').slice(0, 300));
          }
          if (m.method === 'Runtime.consoleAPICalled') {
            const args = (m.params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || a.type));
            logs.push(m.params.type + ': ' + args.join(' ').slice(0, 200));
          }
          if (m.id && p.has(m.id)) { const { resolve, reject } = p.get(m.id); p.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
        });
      });
    },
    send(method, params = {}) {
      const i = id++;
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 40000); });
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
await cdp.send('Runtime.enable');

const R = [];
function bug(name, detail, severity) {
  R.push({ name, detail: String(detail || '').slice(0, 140), severity });
  console.log('  ' + (severity === 'high' ? '🔴' : severity === 'mid' ? '🟡' : '⚪') + ' ' +
    name.padEnd(34) + String(detail || '').slice(0, 80));
}

console.log('══════════════════════════════════════════════════════════════════');
console.log('  交互体验全面审计');
console.log('══════════════════════════════════════════════════════════════════');
console.log();

// ═══ 获取画布位置 ═══
const box = await cdp.eval(`(function(){
  var p = document.querySelector('[data-panel-type="neuron"]');
  if (!p) return null;
  var cv = p.querySelector('canvas');
  if (!cv) return null;
  var r = cv.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
})()`);

if (!box) { console.log('找不到神经元画布'); process.exit(1); }

console.log('  画布: ' + box.w + '×' + box.h + ' @(' + box.x + ',' + box.y + ')');
console.log();

async function mouse(type, x, y, extra) {
  await cdp.send('Input.dispatchMouseEvent', Object.assign({
    type, x, y, button: 'left', clickCount: 1
  }, extra || {}));
}

async function state() {
  return await cdp.eval(`(function(){
    var S = window.__NEURON3D[0].state;
    return {
      yaw: Math.round(S.yaw*100)/100, pitch: Math.round(S.pitch*100)/100, zoom: Math.round(S.zoom*100)/100,
      hover: S.hover ? S.hover.name : null,
      sel: S.sel ? S.sel.name : null,
      draggingNode: !!S.draggingNode, rotating: !!S.rotating,
      draggedCount: S.scenes.filter(function(n){return n.dragged;}).length,
      detailVisible: (function(){
        var d = document.querySelector('#neuron-detail');
        return d ? d.style.display !== 'none' : null;
      })(),
    };
  })()`);
}

// ═══════════════════════════════════════════════════════════════
//  1. 悬停是否灵敏
// ═══════════════════════════════════════════════════════════════
console.log('① 悬停测试:');
const s0 = await state();

// 逐个节点位置试
const nodePos = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var R = S.radius, fov = R * 2.9;
  var W = document.querySelector('[data-panel-type="neuron"] canvas').clientWidth;
  var H = document.querySelector('[data-panel-type="neuron"] canvas').clientHeight;
  var cx = W/2, cy = H/2;
  var out = [];
  for (var i = 0; i < Math.min(5, S.scenes.length); i++) {
    var n = S.scenes[i];
    // 手算投影（用 canvas 的 rotate3d/project3d 逻辑无法外部调用，这里用相同公式）
    var cyaw = Math.cos(S.yaw), syaw = Math.sin(S.yaw);
    var x1 = n.sx*cyaw + n.sz*syaw;
    var z1 = -n.sx*syaw + n.sz*cyaw;
    var cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
    var y1 = n.sy*cp - z1*sp;
    var z2 = n.sy*sp + z1*cp;
    var denom = fov/(fov+z2);
    out.push({
      name: n.name,
      sx: Math.round(cx + x1*denom),
      sy: Math.round(cy + y1*denom),
      z: Math.round(z2),
    });
  }
  return out;
})()`);

console.log('  前 5 个节点的屏幕位置:');
for (const n of nodePos) console.log('    ' + n.name + ' @(' + n.sx + ',' + n.sy + ') z=' + n.z);

// 试悬停第一个可见节点（z 最大的）
const visible = nodePos.filter(n => n.z > -50);
if (visible.length) {
  const target = visible[0];
  const px = box.x + target.sx;
  const py = box.y + target.sy;
  console.log();
  console.log('  瞄准: ' + target.name + ' @(' + px + ',' + py + ')');
  await mouse('mouseMoved', px, py);
  await new Promise(r => setTimeout(r, 400));
  const sHover = await state();
  console.log('  悬停后: ' + JSON.stringify(sHover));

  if (sHover.hover === target.name) {
    bug('悬停识别正确', '✓ ' + target.name, 'ok');
  } else {
    bug('⚠ 悬停未命中', '预期 ' + target.name + ' 实际 ' + (sHover.hover || 'null'), 'mid');
  }
} else {
  bug('⚠ 无可见节点', '所有节点 z < -50，可能转过背了', 'mid');
}

// ═══════════════════════════════════════════════════════════════
//  2. 点击是否打开详情
// ═══════════════════════════════════════════════════════════════
console.log();
console.log('② 点击测试:');
if (visible.length) {
  const target = visible[0];
  const px = box.x + target.sx;
  const py = box.y + target.sy;

  await mouse('mousePressed', px, py);
  await mouse('mouseReleased', px, py);
  await new Promise(r => setTimeout(r, 400));

  const sClick = await state();
  console.log('  点击后 sel=' + (sClick.sel || 'null'));

  if (sClick.sel === target.name) {
    bug('点击选中正确', '✓ ' + target.name, 'ok');
  } else {
    bug('⚠ 点击未选中', '预期 ' + target.name, 'mid');
  }

  // 再点一次应取消
  await mouse('mousePressed', px, py);
  await mouse('mouseReleased', px, py);
  await new Promise(r => setTimeout(r, 300));
  const s2 = await state();
  if (s2.sel === null) {
    bug('再次点击取消选中', '✓', 'ok');
  } else {
    bug('⚠ 再次点击未取消', 'sel=' + s2.sel, 'low');
  }
}

// ═══════════════════════════════════════════════════════════════
//  3. 旋转是否流畅
// ═══════════════════════════════════════════════════════════════
console.log();
console.log('③ 旋转测试:');
const sBefRot = await state();
const startX = box.x + box.w / 2;
const startY = box.y + box.h / 2;

await mouse('mousePressed', startX + 200, startY + 100);
for (let i = 1; i <= 8; i++) {
  await mouse('mouseMoved', startX + 200 + i * 15, startY + 100 + i * 8);
  await new Promise(r => setTimeout(r, 40));
}
await mouse('mouseReleased', startX + 320, startY + 164);
await new Promise(r => setTimeout(r, 300));

const sAftRot = await state();
const dyaw = Math.abs(sAftRot.yaw - sBefRot.yaw);
const dpitch = Math.abs(sAftRot.pitch - sBefRot.pitch);
console.log('  yaw Δ=' + dyaw.toFixed(2) + '  pitch Δ=' + dpitch.toFixed(2));

if (dyaw > 0.1 || dpitch > 0.1) {
  bug('旋转有响应', '✓ yaw Δ=' + dyaw.toFixed(2), 'ok');
} else {
  bug('⚠ 旋转无响应', 'Δyaw=' + dyaw.toFixed(2), 'high');
}

// ═══════════════════════════════════════════════════════════════
//  4. 滚轮缩放
// ═══════════════════════════════════════════════════════════════
console.log();
console.log('④ 缩放测试:');
const zBefore = (await state()).zoom;
await cdp.send('Input.dispatchMouseEvent', {
  type: 'mouseWheel', x: startX, y: startY, deltaX: 0, deltaY: -120,
});
await new Promise(r => setTimeout(r, 300));
const zAfter = (await state()).zoom;

if (zAfter !== zBefore) {
  bug('滚轮缩放有效', '✓ ' + zBefore + ' → ' + zAfter, 'ok');
} else {
  bug('⚠ 滚轮无效', 'zoom 未变', 'high');
}

// ═══════════════════════════════════════════════════════════════
//  5. 拖拽节点
// ═══════════════════════════════════════════════════════════════
console.log();
console.log('⑤ 节点拖拽:');
if (visible.length) {
  const t = nodePos.filter(n => n.z > -50)[0];
  const px = box.x + t.sx;
  const py = box.y + t.sy;

  await mouse('mousePressed', px, py);
  for (let i = 1; i <= 5; i++) {
    await mouse('mouseMoved', px + i * 10, py + i * 6);
    await new Promise(r => setTimeout(r, 30));
  }
  await mouse('mouseReleased', px + 50, py + 30);
  await new Promise(r => setTimeout(r, 300));

  const sd = await state();
  console.log('  draggedCount=' + sd.draggedCount);

  if (sd.draggedCount > 0) {
    bug('节点可拖拽', '✓ ' + sd.draggedCount + ' 个已移动', 'ok');
  } else {
    bug('⚠ 拖拽未生效', 'draggedCount=0', 'high');
  }
}

// ═══════════════════════════════════════════════════════════════
//  6. 整理按钮
// ═══════════════════════════════════════════════════════════════
console.log();
console.log('⑥ 整理按钮:');
const tidyBtn = await cdp.eval(`(function(){
  var btns = document.querySelectorAll('[data-panel-type="neuron"] button');
  for (var i = 0; i < btns.length; i++) {
    if (btns[i].textContent === '整理') {
      var r = btns[i].getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), found: true };
    }
  }
  return { found: false };
})()`);

if (tidyBtn.found) {
  await mouse('mousePressed', tidyBtn.x, tidyBtn.y);
  await mouse('mouseReleased', tidyBtn.x, tidyBtn.y);
  await new Promise(r => setTimeout(r, 700));

  const st = await state();
  if (st.draggedCount === 0) {
    bug('整理复位成功', '✓ draggedCount=0', 'ok');
  } else {
    bug('⚠ 整理未复位', 'draggedCount=' + st.draggedCount, 'high');
  }
} else {
  bug('⚠ 找不到整理按钮', '', 'high');
}

// ═══════════════════════════════════════════════════════════════
//  7. 快速连续点击（压力）
// ═══════════════════════════════════════════════════════════════
console.log();
console.log('⑦ 快速点击压力:');
const errCountBefore = cdp.errs.length;
for (let i = 0; i < 20; i++) {
  const px = box.x + 300 + (i % 5) * 40;
  const py = box.y + 250 + (i % 4) * 40;
  await mouse('mousePressed', px, py);
  await mouse('mouseReleased', px, py);
}
await new Promise(r => setTimeout(r, 500));
const errCountAfter = cdp.errs.length;

if (errCountAfter === errCountBefore) {
  bug('快速点击无异常', '✓ 20 次点击', 'ok');
} else {
  bug('⚠ 快速点击报错', (errCountAfter - errCountBefore) + ' 个异常', 'high');
}

// ═══════════════════════════════════════════════════════════════
//  8. 极端缩放
// ═══════════════════════════════════════════════════════════════
console.log();
console.log('⑧ 极端缩放:');
const zErrBefore = cdp.errs.length;
for (let i = 0; i < 10; i++) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: startX, y: startY, deltaX: 0, deltaY: -200 });
}
for (let i = 0; i < 20; i++) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: startX, y: startY, deltaX: 0, deltaY: 200 });
}
await new Promise(r => setTimeout(r, 400));
const zErrAfter = cdp.errs.length;
const zFinal = (await state()).zoom;

if (zErrAfter === zErrBefore) {
  bug('极端缩放无异常', '✓ zoom=' + zFinal, 'ok');
} else {
  bug('⚠ 极端缩放报错', (zErrAfter - zErrBefore) + ' 个', 'high');
}

// ═══════════════════════════════════════════════════════════════
//  汇总
// ═══════════════════════════════════════════════════════════════
console.log();
console.log('══════════════════════════════════════════════════════════════════');
const okCount = R.filter(r => r.severity === 'ok').length;
const issues = R.filter(r => r.severity !== 'ok');
console.log('  通过 ' + okCount + ' 项 / 问题 ' + issues.length + ' 项');
console.log();

if (issues.length) {
  console.log('  需要修复的问题:');
  for (const i of issues) {
    console.log('    ' + (i.severity === 'high' ? '🔴' : '🟡' ) + ' ' + i.name + '  ' + i.detail);
  }
}

console.log();
console.log('  JS 异常总数: ' + cdp.errs.length);
if (cdp.errs.length) {
  const uniq = [...new Set(cdp.errs)];
  for (const e of uniq.slice(0, 5)) console.log('    ✗ ' + e.slice(0, 120));
}
console.log('══════════════════════════════════════════════════════════════════');

cdp.close();

const fs = await import('node:fs');
fs.writeFileSync(
  String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\audit-interaction.json`,
  JSON.stringify({ results: R, errors: cdp.errs }, null, 2),
  'utf8'
);
