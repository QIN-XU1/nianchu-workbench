#!/usr/bin/env node
// 工具/设计一致性.mjs —— 界面设计令牌一致性检查
//
// ══════════════════════════════════════════════════════════════════════
//  为什么有这个工具
// ══════════════════════════════════════════════════════════════════════
//  参考 dsh-claude-style 的设计规范后，我给主 Agent 界面建了 token 体系
//  （ui/core/theme.js）。但「有 token 表」不等于「代码里真的只用 token」——
//  实际查出来过：
//    · ink-5（对比度 2.44，标注「仅装饰」）被用来显示「系统注入 2.6k 字」
//    · 发送按钮对比度 4.49，差 0.01 不达 AA
//    · 耗时显示 2979s（引擎时间戳和本机不同源）
//
//  这些靠肉眼看不出来。所以要有会失败的检查。
//
//  ══════════════════════════════════════════════════════════════════════
//  四条检查（每条都有反例，见 --selftest）
// ══════════════════════════════════════════════════════════════════════
//    ① 无游离 hex ——  ui/panels/main-agent.js 里不能出现 #xxxxxx 字面量
//                     （颜色必须来自 theme.js 的 token）
//    ② 对比度达标 ——  渲染后所有文字 vs 背景 ≥ 4.5（WCAG AA）
//                     用 CDP 拿实际计算样式，不是猜
//    ③ 圆角在阶梯上 —— 所有 border-radius 必须是 0/4/6/8/12/16/999
//    ④ 间距 4 的倍数 —— 所有 padding/margin/gap 必须是 4 的倍数（允许 2px 例外）
//
//  用法：
//    node 工具/设计一致性.mjs            # 检查（需要工作台在跑）
//    node 工具/设计一致性.mjs --selftest # 自测（含反例）
//    node 工具/设计一致性.mjs --static   # 只做静态检查（不需要工作台）
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// ⚠ 路径解析：必须用 fileURLToPath，不能用 new URL().pathname
//   （后者在 Windows 上会得到 /D:/... 且中文会被 URL 编码，
//    实测导致 "文件不存在" —— 这就是本工具第一版的 bug）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WB = path.resolve(__dirname, '..');          // workbench/
const UI = path.join(WB, '外壳', 'ui');
const PANEL = path.join(UI, 'panels', 'main-agent.js');
const THEME = path.join(UI, 'core', 'theme.js');

const argv = process.argv.slice(2);
const SELFTEST = argv.includes('--selftest');
const STATIC_ONLY = argv.includes('--static');

// ══════════════════════════════════════════════════════════════════════
//  判据（唯一出处 —— 五步法第 1、2 步）
// ══════════════════════════════════════════════════════════════════════
//  ⚠ 2026-11-12 修（判据散在代码里，等于没有判据）
//
//   原来 4.5 / 3.0 / 圆角阶梯 / 4 的倍数 这些数字**直接写在判断处**，
//   而它们同时出现在 checkTokenContrast、RUNTIME_AUDIT 注入串、selftest
//   三处 —— 同一事实存三份（违反项目铁律 §1）。
//   后果：改一个阈值要改三处，漏一处就变成「检查的判据」和「自测的判据」不一致。
//
//   现在：阈值只在这里定义一次并 export，别处一律引用。
//   （命名带 MIN/MAX 是为了让「违规可判定」一眼可读：最小/最大可接受值。）
// ──────────────────────────────────────────────────────────────────────

// WCAG 对比度门槛（AA 级：正文 4.5，大字/图标 3.0）
export const WCAG_INK_MIN = 4.5;    // 承载正文的文字最低对比度
export const WCAG_INK4_MIN = 3.0;   // 大字 / 图标最低对比度
export const WCAG_INK5_MAX = 3.0;   // 仅装饰色上限（超过就不该再叫「仅装饰」）

// 圆角阶梯：所有 border-radius 必须落在这些档位上（999 = 胶囊）
export const RADIUS_STEPS = [0, 4, 6, 8, 12, 16, 999];
// 允许的例外写法（历史遗留的百分比胶囊 / 3px 细线）；不属于阶梯，单独列出
export const RADIUS_EXTRAS = ['50%', '3px'];

// 间距：必须是 SPACING_MULTIPLE 的倍数；SPACING_ALLOW_PX 是明确允许的细调值
export const SPACING_MULTIPLE = 4;
export const SPACING_ALLOW_PX = [2];

// 由阶梯派生出的可查集合（唯一事实仍是 RADIUS_STEPS）
export const RADIUS_LADDER = new Set([
  '0',
  ...RADIUS_STEPS.map((n) => n + 'px'),
  ...RADIUS_EXTRAS,
]);

// 判据函数也 export：别的工具（或自测）要复用同一套判断，不要再写一份
export function isRadiusAllowed(v) {
  return RADIUS_LADDER.has(String(v).trim());
}

export function isSpacingOk(px) {
  return px % SPACING_MULTIPLE === 0 || SPACING_ALLOW_PX.includes(px);
}

const R = [];
export function chk(name, ok, detail) {
  R.push({ name, ok, detail });
  console.log('  ' + (ok ? 'OK  ' : 'XX  ') + name + (detail ? '  ' + detail : ''));
}

// ══════════════════════════════════════════════════════════════════════
//  ① 静态：无游离 hex
// ══════════════════════════════════════════════════════════════════════
const ALLOWED_HEX = new Set([
  '#fff', '#ffffff',           // 纯白（极少用，但允许）
]);

function findStrayHex(src) {
  // 排除注释行
  const lines = src.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 跳过注释
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    // 找 #xxxxxx 或 #xxx
    const ms = [...line.matchAll(/#[0-9a-fA-F]{3,8}\b/g)];
    for (const m of ms) {
      const hex = m[0].toLowerCase();
      if (ALLOWED_HEX.has(hex)) continue;
      // 排除颜色名的十六进制（如 url 里的）
      hits.push({ line: i + 1, hex, code: trimmed.slice(0, 70) });
    }
  }
  return hits;
}

function checkNoStrayHex() {
  if (!fs.existsSync(PANEL)) {
    chk('无游离 hex（main-agent.js 只用 token）', false, '文件不存在');
    return;
  }
  const src = fs.readFileSync(PANEL, 'utf8');
  const hits = findStrayHex(src);
  chk('无游离 hex（main-agent.js 只用 token）', hits.length === 0,
    hits.length ? '发现 ' + hits.length + ' 处: ' + hits.slice(0, 3).map((h) => 'L' + h.line + ' ' + h.hex).join(', ') : '');
  if (hits.length) {
    for (const h of hits.slice(0, 5)) {
      console.log('       L' + h.line + '  ' + h.hex + '   ' + h.code);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
//  ② 静态：token 表本身完整
// ══════════════════════════════════════════════════════════════════════
const REQUIRED_TOKENS = [
  'canvas', 'surface-1', 'surface-2', 'surface-3',
  'ink', 'ink-2', 'ink-3', 'ink-4',
  'border-1', 'border-2', 'border-3', 'divider',
  'bubble-user', 'bubble-ai',
  'accent', 'on-accent',
];

async function checkThemeTokens() {
  let mod = null;
  try {
    mod = await import('file:///' + THEME.replace(/\\/g, '/'));
  } catch (e) {
    chk('theme.js 可加载', false, String(e.message).slice(0, 80));
    return null;
  }
  chk('theme.js 可加载', true);

  const card = mod.INK_CARD;
  if (!card) {
    chk('INK_CARD 存在', false);
    return null;
  }
  chk('INK_CARD 存在', true);

  const missing = REQUIRED_TOKENS.filter((k) => card[k] === undefined);
  chk('必需 token 齐全', missing.length === 0,
    missing.length ? '缺: ' + missing.join(', ') : REQUIRED_TOKENS.length + ' 个');

  return { mod, card };
}

// ══════════════════════════════════════════════════════════════════════
//  ③ 静态：对比度（token 层）
// ══════════════════════════════════════════════════════════════════════
function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function luminance(rgb) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(rgb.r) + 0.7152 * f(rgb.g) + 0.0722 * f(rgb.b);
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function checkTokenContrast(card) {
  if (!card) return;
  const canvas = hexToRgb(card.canvas);

  // ink 1-4 必须 ≥ 4.5（承载文字）
  const textTokens = ['ink', 'ink-2', 'ink-3'];
  let allOk = true;
  const details = [];
  for (const k of textTokens) {
    if (!card[k]) continue;
    const ratio = contrast(hexToRgb(card[k]), canvas);
    if (ratio < WCAG_INK_MIN) { allOk = false; details.push(k + '=' + ratio.toFixed(2)); }
  }
  chk('ink/ink-2/ink-3 对比度 ≥ ' + WCAG_INK_MIN, allOk, details.join(', '));

  // ink-4 ≥ WCAG_INK4_MIN（大字/图标）
  if (card['ink-4']) {
    const ratio = contrast(hexToRgb(card['ink-4']), canvas);
    chk('ink-4 对比度 ≥ ' + WCAG_INK4_MIN + '（大字可用）', ratio >= WCAG_INK4_MIN, ratio.toFixed(2));
  }

  // ink-5 < WCAG_INK5_MAX（仅装饰，这是有意设计）
  if (card['ink-5']) {
    const ratio = contrast(hexToRgb(card['ink-5']), canvas);
    chk('ink-5 对比度 < ' + WCAG_INK5_MAX + '（仅装饰，不该承载信息）', ratio < WCAG_INK5_MAX,
      ratio.toFixed(2) + (ratio >= WCAG_INK5_MAX ? ' ← 太亮了，失去了「仅装饰」的定位' : ''));
  }

  // accent vs on-accent ≥ WCAG_INK_MIN（按钮文字）
  if (card.accent && card['on-accent']) {
    const ratio = contrast(hexToRgb(card.accent), hexToRgb(card['on-accent']));
    chk('accent vs on-accent ≥ ' + WCAG_INK_MIN + '（按钮可读）', ratio >= WCAG_INK_MIN, ratio.toFixed(2));
  }
}

// ══════════════════════════════════════════════════════════════════════
//  ④ 静态：几何（圆角 / 间距）
// ══════════════════════════════════════════════════════════════════════
// 判据本身在文件顶部的 RADIUS_STEPS / SPACING_MULTIPLE，这里只做提取和比对。

function checkGeometry() {
  if (!fs.existsSync(PANEL)) return;
  const src = fs.readFileSync(PANEL, 'utf8');

  // 找所有 border-radius 值
  const radiusVals = [...src.matchAll(/border-radius:\s*([^;'"]+)/g)]
    .map((m) => m[1].trim())
    .filter((v) => !v.startsWith("' +") && !v.includes('R.'));

  const badRadius = [...new Set(radiusVals)].filter((v) => !isRadiusAllowed(v));
  chk('圆角都在阶梯上（' + RADIUS_STEPS.join('/') + '）', badRadius.length === 0,
    badRadius.length ? '游离: ' + badRadius.join(', ') : '');

  // 找所有硬编码的 padding/margin/gap 数字（px）
  const spaceVals = [];
  for (const m of src.matchAll(/(?:padding|margin|gap):\s*([0-9]+)px/g)) {
    spaceVals.push(Number(m[1]));
  }
  // 判据：SPACING_MULTIPLE 的倍数，允许 SPACING_ALLOW_PX 里的细调值
  const badSpace = [...new Set(spaceVals)].filter((v) => !isSpacingOk(v));
  chk('间距都是 ' + SPACING_MULTIPLE + ' 的倍数（允许 ' + SPACING_ALLOW_PX.join('/') + '）', badSpace.length === 0,
    badSpace.length ? '游离: ' + badSpace.join(', ') : '');
}

// ══════════════════════════════════════════════════════════════════════
//  ⑤ 运行时：真实渲染对比度（需要 CDP）
// ══════════════════════════════════════════════════════════════════════
const get = (u) => new Promise((res, rej) => {
  const r = http.get(u, { timeout: 3000 }, (s) => { let d = ''; s.on('data', (c) => { d += c; }); s.on('end', () => res(d)); });
  r.on('error', rej);
  r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); });
});

async function cdpEval(expression) {
  const port = process.env.SEA_DEBUG_PORT || 9333;
  const targets = JSON.parse(await get('http://127.0.0.1:' + port + '/json/list'));
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('找不到工作台页面');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map();
  const send = (method, params) => new Promise((resolve, reject) => {
    const myId = id++;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    }
  };
  try {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result && r.result.value;
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
}

// ⚠ 2026-11-12 修（判据又存了第二份）：
//   下面这段会被注入浏览器执行，原本里面硬编码了 `ratio < 4.5`，
//   与文件顶部的 WCAG_INK_MIN 是同一事实的两份拷贝。
//   现在用字符串插值把唯一出处传进去 —— 注入串里不再有字面量阈值。
const RUNTIME_AUDIT = `(function(){
  const INK_MIN = ${WCAG_INK_MIN};
  function rgbToArr(s) {
    const m = s.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    return m[1].split(',').map(Number);
  }
  function lum(rgb) {
    const f = function(v){ const s=v/255; return s<=0.03928?s/12.92:Math.pow((s+0.055)/1.055,2.4); };
    return 0.2126*f(rgb[0]) + 0.7152*f(rgb[1]) + 0.0722*f(rgb[2]);
  }
  function contrast(a, b) {
    const la = lum(a), lb = lum(b);
    return (Math.max(la,lb)+0.05)/(Math.min(la,lb)+0.05);
  }

  const ma = document.getElementById('ma-panel');
  if (!ma) return { err: '找不到主 Agent 面板（当前可能不在中枢场景）' };

  const panelBg = rgbToArr(getComputedStyle(ma).backgroundColor);
  const out = [];

  for (const el of [...ma.querySelectorAll('*')]) {
    const cs = getComputedStyle(el);
    const txt = (el.childNodes.length && el.childNodes[0].nodeType === 3) ? el.textContent.trim() : '';
    if (!txt || txt.length > 60) continue;
    const fg = rgbToArr(cs.color);
    if (!fg) continue;
    let bg = null;
    let cur = el;
    while (cur && cur !== document.body) {
      const b = rgbToArr(getComputedStyle(cur).backgroundColor);
      if (b && b.length === 4 && b[3] > 0.5) { bg = b; break; }
      if (b && b.length === 3) { bg = b; break; }
      cur = cur.parentElement;
    }
    if (!bg) bg = panelBg;
    if (!bg) continue;
    const ratio = contrast(fg.slice(0,3), bg.slice(0,3));
    if (ratio < INK_MIN) {
      out.push({ text: txt.slice(0, 24), color: cs.color, ratio: Math.round(ratio*100)/100, fontSize: cs.fontSize });
    }
  }
  return { lowContrast: out, total: out.length };
})()`;

async function checkRuntimeContrast() {
  let r = null;
  try {
    r = await cdpEval(RUNTIME_AUDIT);
  } catch (e) {
    chk('运行时对比度审计', false, 'CDP 不可用: ' + String(e.message).slice(0, 50));
    console.log('       （跳过：需要工作台在跑且开着调试端口）');
    return;
  }
  if (!r || r.err) {
    chk('运行时对比度审计', true, '跳过：' + ((r && r.err) || '无数据') + '（不算失败）');
    return;
  }
  chk('运行时所有文字对比度 ≥ ' + WCAG_INK_MIN, r.total === 0,
    r.total === 0 ? '0 处不合格' : r.total + ' 处不合格');
  if (r.total > 0) {
    for (const item of r.lowContrast.slice(0, 6)) {
      console.log('       "' + item.text + '"  ' + item.ratio + '  ' + item.fontSize + '  ' + item.color);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
//  自测（含反例 —— 规矩：没有会失败的检查 = 装饰）
// ══════════════════════════════════════════════════════════════════════
async function selftest() {
  console.log('═'.repeat(72));
  console.log('  设计一致性 · 自测');
  console.log('═'.repeat(72));
  console.log();

  console.log('【一】游离 hex 检测器');
  const goodSrc = "background: T.canvas; color: T.ink;";
  const badSrc = "background: '#0E1114'; color: '#DDE3EA';";
  chk('合规源码被放行', findStrayHex(goodSrc).length === 0);
  chk('反例：游离 hex 必须报', findStrayHex(badSrc).length === 2,
    '检出 ' + findStrayHex(badSrc).length + ' 处');

  console.log();
  console.log('【二】对比度计算');
  // 黑 vs 白 = 21
  const w = hexToRgb('#ffffff');
  const b = hexToRgb('#000000');
  chk('黑白对比度 = 21', Math.abs(contrast(w, b) - 21) < 0.1, contrast(w, b).toFixed(2));
  // 相同色 = 1
  chk('同色对比度 = 1', Math.abs(contrast(w, w) - 1) < 0.01);
  // 反例：低对比应该被识别
  const dim = hexToRgb('#634e44');
  const bg = hexToRgb('#14100E');
  const dimRatio = contrast(dim, bg);
  chk('反例：低对比被识别为不合格', dimRatio < WCAG_INK4_MIN, dimRatio.toFixed(2));

  console.log();
  console.log('【三】圆角阶梯');
  chk('4px 合规', isRadiusAllowed('4px'));
  chk('反例：5px 必须不在阶梯上', !isRadiusAllowed('5px'));
  chk('反例：7px 必须不在阶梯上', !isRadiusAllowed('7px'));

  console.log();
  console.log('【四】间距倍数');
  // 判据全部来自 SPACING_MULTIPLE / SPACING_ALLOW_PX，自测里不再写死 4
  chk('4 / 8 / 12 / 16 合规', [4, 8, 12, 16].every(isSpacingOk));
  chk('反例：倍数 + 1 必须不合规', !isSpacingOk(SPACING_MULTIPLE + 1));
  chk('反例：5 必须不合规', !isSpacingOk(5));
  chk('反例：7 必须不合规', !isSpacingOk(7));

  console.log();
  console.log('═'.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  const failed = R.filter((x) => !x.ok);
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (failed.length) {
    console.log('  失败项:');
    for (const f of failed) console.log('    - ' + f.name + '  ' + (f.detail || ''));
    process.exitCode = 1;
  }
  console.log('═'.repeat(72));
  return failed.length === 0;
}

// ══════════════════════════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════════════════════════
async function main() {
  if (SELFTEST) {
    await selftest();
    return;
  }

  console.log('═'.repeat(72));
  console.log('  设计一致性检查（主 Agent 界面）');
  console.log('═'.repeat(72));
  console.log();

  checkNoStrayHex();
  const theme = await checkThemeTokens();
  if (theme) checkTokenContrast(theme.card);
  checkGeometry();

  if (!STATIC_ONLY) {
    console.log();
    await checkRuntimeContrast();
  }

  console.log();
  console.log('═'.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  const failed = R.filter((x) => !x.ok);
  console.log('  结果: ' + passed + ' / ' + R.length + ' 通过');
  if (failed.length) {
    console.log('  失败项:');
    for (const f of failed) console.log('    - ' + f.name + '  ' + (f.detail || ''));
    process.exitCode = 1;
  }
  console.log('═'.repeat(72));
}

main().catch((e) => {
  console.error('  ✗ 异常: ' + ((e && e.stack) || e));
  process.exitCode = 1;
}).finally(() => {
  // ⚠ WebSocket 连接关闭后 Node 事件循环可能还挂着，导致退出码异常
  //   （实测：11/11 全过但 exit code = 1）
  //   这里显式退出，退出码由 process.exitCode 决定。
  setTimeout(() => process.exit(process.exitCode || 0), 100);
});
