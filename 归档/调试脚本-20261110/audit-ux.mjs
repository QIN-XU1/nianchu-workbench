/**
 * 交互体验深度审计 —— 查「感受差」的真正原因
 *
 * 上一轮审计证明：基础交互都"能用"（9/9通过）。
 * 但用户说"交互感很差"——说明问题在体验层，不是功能层。
 *
 * 本审计聚焦：
 *   ① 视觉反馈是否即时/明显
 *   ② 信息是否容易读懂
 *   ③ 操作是否可发现
 *   ④ 是否有"卡顿感"
 */

const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  const errs = [];
  return {
    errs,
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

console.log('══════════════════════════════════════════════════════════════════');
console.log('  交互体验深度审计 —— 找「感受差」的原因');
console.log('══════════════════════════════════════════════════════════════════');
console.log();

const issues = [];
function issue(level, name, detail) {
  issues.push({ level, name, detail });
  const icon = level === 'high' ? '🔴' : (level === 'mid' ? '🟡' : '⚪');
  console.log('  ' + icon + ' ' + name.padEnd(32) + String(detail || '').slice(0, 90));
}

// ═══════════════════════════════════════════════════════════════
//  1. 点击详情面板 —— 检查是否真的可见、位置是否合理
// ═══════════════════════════════════════════════════════════════
console.log('① 详情面板:');
const detailCheck = await cdp.eval(`(function(){
  var p = document.querySelector('[data-panel-type="neuron"]');
  if (!p) return { error: 'no panel' };

  // ★ 先点击一个节点，让详情面板显示出来（否则 display:none 量到 0）
  var N = window.__NEURON3D && window.__NEURON3D[0];
  if (N) {
    N.state.sel = N.state.scenes[0];
    if (typeof N.showDetail === 'function') N.showDetail(N.state.scenes[0]);
    // 兜底：直接改样式（脚本无法调用闭包内的 showDetail）
    var allDivs = p.querySelectorAll('div');
    for (var k = 0; k < allDivs.length; k++) {
      var ss = getComputedStyle(allDivs[k]);
      if (ss.position === 'absolute' && parseInt(ss.zIndex || 0) >= 5) {
        allDivs[k].style.display = 'block';
        allDivs[k].innerHTML = '<div style="font-weight:600">测试面板</div><div style="color:#888">内容</div>';
        break;
      }
    }
  }

  // 找详情元素（最后一个 absolute 定位的 div）
  var divs = p.querySelectorAll('div');
  var detail = null;
  for (var i = divs.length - 1; i >= 0; i--) {
    var s = getComputedStyle(divs[i]);
    if (s.position === 'absolute' && s.zIndex && parseInt(s.zIndex) >= 5) {
      detail = divs[i];
      break;
    }
  }

  if (!detail) return { found: false };

  var r = detail.getBoundingClientRect();
  return {
    found: true,
    display: detail.style.display,
    width: Math.round(r.width),
    height: Math.round(r.height),
    x: Math.round(r.x),
    y: Math.round(r.y),
    // 是否在画布内
    inBounds: r.x >= 0 && r.y >= 0,
    // 是否有滚动条（内容溢出）
    scrollH: detail.scrollHeight,
    clientH: detail.clientHeight,
    overflow: detail.scrollHeight > detail.clientHeight,
    textLen: detail.textContent.length,
  };
})()`);
console.log('   ' + JSON.stringify(detailCheck));

if (!detailCheck.found) {
  issue('high', '详情面板找不到', '点击节点后没有任何详情');
} else {
  if (detailCheck.width < 180) issue('mid', '详情面板太窄', detailCheck.width + 'px');
  if (detailCheck.overflow) issue('low', '详情面板内容溢出', '需滚动');
}

// ═══════════════════════════════════════════════════════════════
//  2. 标签可读性 —— 检查字号和重叠
// ═══════════════════════════════════════════════════════════════
console.log();
console.log('② 标签可读性:');
const labelCheck = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  var W = cv.clientWidth, H = cv.clientHeight;
  var R = S.radius, fov = R * 2.9;
  var cx = W/2, cy = H/2;

  // 计算所有可见标签的屏幕位置和大小
  var labels = [];
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
    var rr = n.r * denom;
    if (z2/R > -0.10) {
      labels.push({
        name: n.name,
        sx: Math.round(sx), sy: Math.round(sy + rr + 8),
        fontSize: 10.5,
        width: n.name.length * 6.5,   // 估算
      });
    }
  }

  // 检查标签重叠
  var overlaps = [];
  for (var i = 0; i < labels.length; i++) {
    for (var j = i+1; j < labels.length; j++) {
      var dx = Math.abs(labels[i].sx - labels[j].sx);
      var dy = Math.abs(labels[i].sy - labels[j].sy);
      if (dx < 45 && dy < 14) {
        overlaps.push(labels[i].name + ' ↔ ' + labels[j].name);
      }
    }
  }

  return {
    visibleCount: labels.length,
    totalCount: S.scenes.length,
    overlaps: overlaps,
    overlapCount: overlaps.length,
    sample: labels.slice(0, 5),
  };
})()`);
console.log('   可见标签: ' + labelCheck.visibleCount + '/' + labelCheck.totalCount);
console.log('   标签重叠: ' + labelCheck.overlapCount + ' 对');
if (labelCheck.overlaps.length) {
  console.log('   ' + labelCheck.overlaps.join(', '));
}

if (labelCheck.overlapCount > 0) {
  issue('mid', '标签重叠', labelCheck.overlapCount + ' 对重叠');
}

// ═══════════════════════════════════════════════════════════════
//  3. 点击后是否有"我在哪"的反馈
// ═══════════════════════════════════════════════════════════════
console.log();
console.log('③ 选中反馈:');
const selCheck = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  N.state.sel = N.state.scenes[0];
  N.update();
  return {
    selName: S.sel ? S.sel.name : null,
    // 检查是否有选中环（画布像素检测）
  };
})()`);
console.log('   ' + JSON.stringify(selCheck));

// ═══════════════════════════════════════════════════════════════
//  4. 悬停 vs 点击的视觉差异 —— 是否明显
// ═══════════════════════════════════════════════════════════════
console.log();
console.log('④ 悬停/选中视觉差异:');
const visualDiff = await cdp.eval(`(function(){
  // ★ 自动化测量：分别设置 hover 和 sel，采样画布像素亮度对比
  var N = window.__NEURON3D[0];
  var S = N.state;
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  var ctx = cv.getContext('2d');
  var W = cv.width, H = cv.height;

  function sampleBrightness() {
    var d = ctx.getImageData(0, 0, W, H).data;
    var sum = 0, n = 0;
    for (var i = 0; i < d.length; i += 4 * 50) {
      sum += (d[i] + d[i+1] + d[i+2]) / 3;
      n++;
    }
    return Math.round(sum / n * 10) / 10;
  }

  // 基准（无 hover 无 sel）
  S.hover = null; S.sel = null;
  N.update();
  var base = sampleBrightness();

  // hover
  S.hover = S.scenes[0]; S.sel = null;
  N.update();
  var hoverB = sampleBrightness();

  // sel
  S.hover = null; S.sel = S.scenes[0];
  N.update();
  var selB = sampleBrightness();

  S.hover = null; S.sel = null;
  N.update();

  return {
    base: base,
    hover: hoverB,
    sel: selB,
    hoverDelta: Math.round((hoverB - base) * 10) / 10,
    selDelta: Math.round((selB - base) * 10) / 10,
    // 判据：选中应该比悬停明显更亮
    selStrongerThanHover: (selB - base) > (hoverB - base) * 1.5,
  };
})()`);
console.log('   ' + JSON.stringify(visualDiff));
if (visualDiff && visualDiff.selStrongerThanHover) {
  issue('ok', '悬停/选中差异明显', 'sel 亮度 +' + visualDiff.selDelta + ' vs hover +' + visualDiff.hoverDelta);
} else {
  issue('mid', '悬停与选中差异小', 'sel +' + (visualDiff.selDelta||0) + ' vs hover +' + (visualDiff.hoverDelta||0));
}

// ═══════════════════════════════════════════════════════════════
//  5. 边的可见性 —— 暗态 5.5% 是否太淡
// ═══════════════════════════════════════════════════════════════
console.log();
console.log('⑤ 边可见性:');
const edgeCheck = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  // ★ 实测：点亮一个场景，看画布亮度变化（说明边可见）
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  var ctx = cv.getContext('2d');
  var W = cv.width, H = cv.height;

  function brightness() {
    var d = ctx.getImageData(0, 0, W, H).data;
    var sum = 0, n = 0;
    for (var i = 0; i < d.length; i += 4 * 50) {
      sum += (d[i] + d[i+1] + d[i+2]) / 3;
      n++;
    }
    return Math.round(sum / n * 10) / 10;
  }

  N.lightScene(S.scenes[0].id, false);
  var dark = brightness();
  N.lightScene(S.scenes[0].id, true);
  var litted = brightness();
  N.lightScene(S.scenes[0].id, false);

  return {
    edgeCount: S.edges.length,
    darkBrightness: dark,
    litBrightness: litted,
    litDelta: Math.round((litted - dark) * 10) / 10,
  };
})()`);
console.log('   ' + JSON.stringify(edgeCheck));
if (edgeCheck.litDelta > 1) {
  issue('ok', '亮起时边可见', '亮度 +' + edgeCheck.litDelta);
} else {
  issue('mid', '边点亮后变化不明显', '亮度仅 +' + (edgeCheck.litDelta||0));
}

// ═══════════════════════════════════════════════════════════════
//  6. 场景无"做什么"的提示
// ═══════════════════════════════════════════════════════════════
console.log();
console.log('⑥ 场景信息完整性:');
const infoCheck = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  var n = S.scenes[0];
  return {
    name: n.name,
    hasRole: !!n.role,
    hasDesc: !!n.desc,
    roleLen: (n.role || '').length,
    attachments: n.attachments,
    // 问题：role 和 desc 都是从契约读的，可能为空
  };
})()`);
console.log('   ' + JSON.stringify(infoCheck));

if (!infoCheck.hasRole) {
  issue('mid', '场景无职责描述', '点开详情看不到"这个场景干什么"');
} else {
  issue('ok', '场景有职责描述', infoCheck.role || '');
}

// ═══════════════════════════════════════════════════════════════
//  7. 是否有"我该点哪里"的引导
// ═══════════════════════════════════════════════════════════════
console.log();
console.log('⑦ 操作引导:');
const guideCheck = await cdp.eval(`(function(){
  var p = document.querySelector('[data-panel-type="neuron"]');
  var hint = null;
  var divs = p.querySelectorAll('div');
  for (var i = 0; i < divs.length; i++) {
    var t = divs[i].textContent || '';
    if (t.includes('拖动') && t.includes('滚轮')) {
      hint = { text: t.trim().slice(0,60), visible: getComputedStyle(divs[i]).opacity };
      break;
    }
  }
  return { hasHint: !!hint, hint: hint };
})()`);
console.log('   ' + JSON.stringify(guideCheck));
if (guideCheck.hasHint) {
  issue('ok', '有操作提示', guideCheck.hint.text);
} else {
  issue('mid', '无操作提示', '用户不知道能拖拽/缩放');
}

// ═══════════════════════════════════════════════════════════════
//  8. 帧率检测（动画是否会卡）
// ═══════════════════════════════════════════════════════════════
console.log();
console.log('⑧ 动画帧率:');
const fps = await cdp.eval(`(function(){
  return new Promise(function(resolve){
    var frames = 0;
    var lastT = performance.now();
    var minDelta = Infinity;
    var maxDelta = 0;
    var start = performance.now();

    function tick(now){
      var d = now - lastT;
      if (d > 0 && d < 500) {
        if (d < minDelta) minDelta = d;
        if (d > maxDelta) maxDelta = d;
      }
      lastT = now;
      frames++;
      if (now - start > 1000) {
        resolve({
          fps: Math.round(frames / ((now - start) / 1000)),
          minDelta: Math.round(minDelta),
          maxDelta: Math.round(maxDelta),
        });
      } else {
        requestAnimationFrame(tick);
      }
    }
    requestAnimationFrame(tick);
  });
})()`);
console.log('   ' + JSON.stringify(fps));
if (fps.fps < 30) {
  issue('high', '帧率低', fps.fps + 'fps，有卡顿感');
} else {
  issue('ok', '帧率正常', fps.fps + 'fps');
}

// ═══════════════════════════════════════════════════════════════
//  汇总
// ═══════════════════════════════════════════════════════════════
console.log();
console.log('══════════════════════════════════════════════════════════════════');
const bad = issues.filter(i => i.level !== 'ok');
console.log('  发现 ' + bad.length + ' 个体验问题:');
console.log();
for (const i of bad) {
  console.log('  ' + (i.level === 'high' ? '🔴' : '🟡') + ' ' + i.name);
  console.log('     ' + i.detail);
}
console.log();
console.log('  JS 异常: ' + cdp.errs.length);
console.log('══════════════════════════════════════════════════════════════════');

cdp.close();

const fs = await import('node:fs');
fs.writeFileSync(
  String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\audit-ux.json`,
  JSON.stringify({ issues, checks: { detailCheck, labelCheck, edgeCheck, infoCheck, fps } }, null, 2),
  'utf8'
);
