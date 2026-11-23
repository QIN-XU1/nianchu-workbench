/**
 * Refactoring UI 正式审计 —— 按 skill 的 Sweep 顺序跑
 *
 * 扫描顺序（固定，不可换）：
 *   hierarchy → layout & spacing → typography → color → depth → images → finishing
 *
 * 每个 lens 检查项来自 13-audit-rubric.md
 * 输出按 P0/P1/P2 分级
 */

import fs from 'node:fs';

const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  return {
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 5000);
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
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 20000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 错误');
      return r.result?.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

const findings = [];
function add(lens, severity, rule, location, now, proposed) {
  findings.push({ lens, severity, rule, location, now, proposed });
}

// ══════════ 采集数据 ══════════
const data = await cdp.eval(`(function(){
  var out = { textColors: [], fontWeights: [], fontSizes: [], spacings: [], radii: [], shadows: [] };
  var seen = {};
  var all = document.querySelectorAll('body[data-tui-mode="on"] *');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (!el.tagName || el.tagName === 'WEBVIEW' || el.tagName === 'SCRIPT') continue;
    var cs = getComputedStyle(el);
    var txt = (el.textContent || '').trim();
    if (!txt || el.children.length > 0) continue;   // 只看叶子文本节点

    var c = cs.color;
    if (!seen['c' + c]) { seen['c' + c] = 1; out.textColors.push(c); }
    var fw = cs.fontWeight;
    if (!seen['w' + fw]) { seen['w' + fw] = 1; out.fontWeights.push(fw); }
    var fs = cs.fontSize;
    if (!seen['s' + fs]) { seen['s' + fs] = 1; out.fontSizes.push(fs); }
  }

  // 间距采样
  var containers = document.querySelectorAll('.panel-body, .tui-line, .tui-section');
  for (var j = 0; j < Math.min(containers.length, 30); j++) {
    var c2 = getComputedStyle(containers[j]);
    var pt = c2.paddingTop, pb = c2.paddingBottom, mt = c2.marginTop, gap = c2.gap;
    ['p' + pt, 'p' + pb, 'm' + mt, 'g' + gap].forEach(function(k){
      if (!seen[k] && k.length > 2) { seen[k] = 1; out.spacings.push(k); }
    });
  }

  // 一次可见的主动作数量（实心按钮）
  var primaryButtons = 0;
  document.querySelectorAll('button').forEach(function(b){
    var cs2 = getComputedStyle(b);
    if (cs2.backgroundColor && cs2.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs2.backgroundColor !== 'transparent') primaryButtons++;
  });
  out.primaryButtons = primaryButtons;

  // 面板标题与正文的颜色比较
  var pTitle = document.querySelector('.panel-title');
  var pBody = document.querySelector('.panel-body');
  out.titleColor = pTitle ? getComputedStyle(pTitle).color : null;
  out.titleWeight = pTitle ? getComputedStyle(pTitle).fontWeight : null;
  out.bodyColor = pBody ? getComputedStyle(pBody).color : null;

  return out;
})()`);

// ══════════ Lens 1: Hierarchy ══════════
console.log('══ Lens 1: Hierarchy ══');
console.log('  文字色数量:', data.textColors.length, JSON.stringify(data.textColors));
console.log('  字重数量:', data.fontWeights.length, JSON.stringify(data.fontWeights));
console.log('  字号数量:', data.fontSizes.length, JSON.stringify(data.fontSizes));
console.log('  实心按钮数:', data.primaryButtons);
console.log('  标题色:', data.titleColor, '重:', data.titleWeight);
console.log('  正文色:', data.bodyColor);

if (data.textColors.length > 3) {
  add('hierarchy', 'P1', '2.2.a', '全站文字色', data.textColors.length + ' 种', '压到 3 种（primary/secondary/tertiary）');
}
if (data.fontWeights.filter(w => parseInt(w) < 400).length > 0) {
  add('hierarchy', 'P0', '2.2.b', 'UI 文字', '存在 <400 字重', 'UI 文字不低于 400');
}
if (data.primaryButtons > 1) {
  add('hierarchy', 'P1', '2.8', '页面动作', data.primaryButtons + ' 个实心按钮', '一页一个主行动');
}

// ══════════ Lens 2: Layout & Spacing ══════════
console.log();
console.log('══ Lens 2: Layout & Spacing ══');
console.log('  间距采样数:', data.spacings.length);

// 检查值是否来自 4px 基准系统
const offSystem = data.spacings.filter(s => {
  const v = parseFloat(s.replace(/[pgm]/g, ''));
  return !isNaN(v) && v > 0 && v % 4 !== 0 && v < 100;
});
console.log('  非 4px 基准的值:', offSystem.length, JSON.stringify(offSystem.slice(0, 6)));

if (offSystem.length > 3) {
  add('layout', 'P1', '3.2', '间距', offSystem.length + ' 个值不在 4px 基准', '全部对齐到 4/8/12/16/24/32');
}

// ══════════ Lens 3: Typography ══════════
console.log();
console.log('══ Lens 3: Typography ══');
// 字号是否形成 1.25 倍以上间隔
const sizes = data.fontSizes.map(s => parseFloat(s)).filter(n => !isNaN(n)).sort((a, b) => a - b);
console.log('  字号（排序）:', JSON.stringify(sizes));
const tooClose = [];
for (let i = 1; i < sizes.length; i++) {
  const ratio = sizes[i] / sizes[i - 1];
  if (ratio < 1.18 && sizes[i] > 11) tooClose.push(sizes[i - 1] + '→' + sizes[i] + ' (' + (ratio * 100).toFixed(0) + '%)');
}
console.log('  间隔过小的字号对:', JSON.stringify(tooClose));
if (tooClose.length > 2) {
  add('typography', 'P2', '4.1', '字号尺度', tooClose.length + ' 对字号间隔 <18%', '用 1.25+ 倍率重建字号尺度');
}

// ══════════ Lens 4: Color ══════════
console.log();
console.log('══ Lens 4: Color ══');
// 对比度由 check_contrast.py 单独验证（已做过）

// ══════════ Lens 5: Depth ══════════
console.log();
console.log('══ Lens 5: Depth ══');
// 检查是否滥用阴影
const shadowCount = await cdp.eval(`(function(){
  var n = 0;
  document.querySelectorAll('body[data-tui-mode="on"] *').forEach(function(el){
    var cs = getComputedStyle(el);
    if (cs.boxShadow && cs.boxShadow !== 'none') n++;
  });
  return n;
})()`);
console.log('  有阴影的元素数:', shadowCount);

// ══════════ Lens 7: Finishing touches ══════════
console.log();
console.log('══ Lens 7: Finishing ══');
const emptyCount = await cdp.eval(`document.querySelectorAll('.tui-empty').length`);
console.log('  空状态数:', emptyCount);

// ══════════ 输出报告 ══════════
console.log();
console.log('═'.repeat(70));
console.log('审计结果');
console.log('═'.repeat(70));

if (findings.length === 0) {
  console.log('未发现问题');
} else {
  const P0 = findings.filter(f => f.severity === 'P0');
  const P1 = findings.filter(f => f.severity === 'P1');
  const P2 = findings.filter(f => f.severity === 'P2');

  for (const [level, list] of [['P0', P0], ['P1', P1], ['P2', P2]]) {
    if (!list.length) continue;
    console.log();
    console.log(level + '（' + list.length + ' 项）');
    for (const f of list) {
      console.log(`  [${f.lens}] ${f.rule} @ ${f.location}`);
      console.log(`      现状：${f.now}`);
      console.log(`      建议：${f.proposed}`);
    }
  }
}

fs.writeFileSync(String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\rui-audit.json`,
  JSON.stringify({ at: new Date().toISOString(), data, findings }, null, 2), 'utf8');

cdp.close();
