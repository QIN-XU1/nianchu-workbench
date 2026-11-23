// probe-preview.mjs —— 真实 Chrome 渲染测量（响应式 / 尺度 / 对比度 / 溢出）
//
// 用法：node prototype/probe-preview.mjs
// 做法：把 workbench/外壳/ui 的样式与页面复制到临时目录，用不同视口宽度
//       分别真实渲染，抓取真实布局数值。媒体查询只有真实视口才生效，
//       所以这里靠改 --window-size 测断点，不用容器模拟。
//
// 只用 Node 内置模块。

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..', 'workbench', '外壳', 'ui');
const OUT = join(tmpdir(), 'wb-probe');

const CHROME_CANDIDATES = [
  'C:/Users/15282/AppData/Local/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!CHROME) {
  console.error('未找到 Chrome/Edge，无法做真实渲染测量');
  process.exit(2);
}

mkdirSync(join(OUT, 'styles'), { recursive: true });
for (const f of readdirSync(join(ROOT, 'styles'))) {
  if (f.endsWith('.css')) copyFileSync(join(ROOT, 'styles', f), join(OUT, 'styles', f));
}
for (const page of ['style-preview.html', 'skeleton.html']) {
  copyFileSync(join(ROOT, page), join(OUT, page));
}

/* ══════════════ 1. 注入探针代码 ══════════════ */

const INSTRUMENT = String.raw`
<script>
(function () {
  var R = { url: location.pathname.split('/').pop(), vw: window.innerWidth, vh: window.innerHeight };

  /* ── 页面级横向溢出 ── */
  var de = document.documentElement;
  R.pageOverflow = de.scrollWidth > de.clientWidth + 1;
  R.scrollW = de.scrollWidth;
  R.clientW = de.clientWidth;

  /* ── 骨架结构指标 ── */
  function rect(sel) {
    var el = document.querySelector(sel);
    if (!el) return null;
    var b = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width),
             h: Math.round(b.height), right: Math.round(b.right), pos: cs.position };
  }
  R.shell = {
    app:   rect('.wb-app'),
    top:   rect('.wb-titlebar'),
    scene: rect('.wb-scenebar'),
    body:  rect('.wb-body'),
    main:  rect('.wb-main'),
    side:  rect('.wb-side'),
    handle: rect('.wb-split-handle'),
    foot:  rect('.wb-footbar'),
    grid:  rect('.wb-grid'),
  };

  /* ── 右栏形态（断点是否生效） ── */
  if (R.shell.side) {
    var sideEl = document.querySelector('.wb-side');
    var cs = getComputedStyle(sideEl);
    R.sideMode = cs.position === 'absolute' ? 'drawer' : 'inline';
    R.sideTransform = cs.transform === 'none' ? 'none' : 'translated';
    R.sideVisible = R.shell.side.x >= 0 && R.shell.side.x + R.shell.side.w <= R.vw + 1;
  }

  /* ── 溢出检测：任何元素超出视口右缘 ──
     注意：抽屉（.wb-side）在收起态被 translateX(100%) 移出视口是设计行为，
     不构成「内容溢出」，必须排除；否则会误报。 */
  var spills = [];
  document.querySelectorAll('.wb-app *').forEach(function (el) {
    if (el.closest('svg') && el.tagName !== 'svg') return;
    // 排除抽屉及其子树（收起时本来就在视口外，且不可见）
    var drawer = el.closest('.wb-side');
    if (drawer) {
      var dcs = getComputedStyle(drawer);
      if (dcs.position === 'absolute' && dcs.visibility === 'hidden') return;
    }
    var b = el.getBoundingClientRect();
    if (b.width <= 0 || b.height <= 0) return;
    if (b.right > R.vw + 1) {
      spills.push({ cls: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).slice(0, 44),
                    tag: el.tagName, right: Math.round(b.right), w: Math.round(b.width) });
    }
  });
  R.spills = spills.slice(0, 10);
  R.spillCount = spills.length;

  /* ── 横向滚动条（比 getBoundingClientRect 更硬的证据） ── */
  var bodyEl = document.querySelector('.wb-body');
  R.bodyScrollLeft = bodyEl ? (bodyEl.scrollWidth - bodyEl.clientWidth) : null;

  /* ── 竖排文字：宽度 < 1.25 字宽 且 高 > 2.2 行 ── */
  var vertical = [];
  document.querySelectorAll('.wb-app *').forEach(function (el) {
    if (el.closest('.wb-code') || el.closest('svg')) return;
    if (el.children.length > 0) return;
    var t = (el.textContent || '').trim();
    if (!t) return;
    var b = el.getBoundingClientRect();
    if (b.width <= 0 || b.height <= 0) return;
    var fs = parseFloat(getComputedStyle(el).fontSize);
    if (b.width < fs * 1.25 && b.height > fs * 2.2) {
      vertical.push({ cls: String(el.className).slice(0, 34), w: Math.round(b.width), h: Math.round(b.height), t: t.slice(0, 16) });
    }
  });
  R.verticalText = vertical.slice(0, 10);
  R.verticalCount = vertical.length;

  /* ── 尺度：字号档数 / 圆角档数 / 阴影级数 ──
     扫描设计系统内的全部元素：凡带 wb- 类名、或位于 .wb-app 内、或为设计系统组件，
     都算。预览页自身的 .pv-* 外壳不属于设计系统，排除。
     圆角/阴影按「设计系统声明的档位」统计：只统计 .wb-* 与 .pv-* 之外的元素。 */
  var fsSet = {}, radSet = {}, shSet = {};
  function inPreviewChrome(el) {
    // 预览页自身的 .pv-* 排版外壳不属于设计系统；
    // 但凡元素自身带 wb- 类名，就一定是设计系统元件，必须计入。
    if (el.classList && Array.prototype.some.call(el.classList, function (c) { return c.indexOf('wb-') === 0; })) return false;
    return el.closest('.pv-wrap') !== null && el.closest('.wb-app') === null;
  }
  document.querySelectorAll('body *').forEach(function (el) {
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    var isDS = el.classList && Array.prototype.some.call(el.classList, function (c) { return c.indexOf('wb-') === 0; });
    var inApp = el.closest('.wb-app') !== null;
    if (!isDS && !inApp) return;
    if (inPreviewChrome(el)) return;
    var hasText = el.children.length === 0 && (el.textContent || '').trim();
    if (hasText) fsSet[cs.fontSize] = 1;
    var r = cs.borderTopLeftRadius;
    if (parseFloat(r) > 0) radSet[r] = 1;
    if (cs.boxShadow !== 'none') shSet[cs.boxShadow] = 1;
  });
  R.scale = {
    fonts: Object.keys(fsSet).sort(function (a, b) { return parseFloat(a) - parseFloat(b); }),
    fontCount: Object.keys(fsSet).length,
    radii: Object.keys(radSet).sort(function (a, b) { return parseFloat(a) - parseFloat(b); }),
    radiusCount: Object.keys(radSet).length,
    shadowCount: Object.keys(shSet).length,
  };

  /* ── 实测对比度（取真实渲染的 fg/bg） ── */
  function lum(c) {
    var v = c.map(function (x) { var s = x / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  }
  function parseRGB(s) { var m = s.match(/[\d.]+/g); return m ? m.slice(0, 4).map(Number) : null; }
  function ratio(a, b) { var x = lum(a), y = lum(b); var hi = Math.max(x, y), lo = Math.min(x, y); return (hi + 0.05) / (lo + 0.05); }
  function effBg(el) {
    var cur = el, guard = 0;
    while (cur && guard++ < 12) {
      var bg = parseRGB(getComputedStyle(cur).backgroundColor);
      if (bg && (bg.length < 4 || bg[3] > 0)) return bg;
      cur = cur.parentElement;
    }
    return [13, 15, 18, 1];
  }
  R.contrast = [];
  [
    ['正文一级', '.wb-row-title'],
    ['正文二级', '.wb-panel-head-meta'],
    ['正文三级', '.wb-row-meta'],
    ['表格正文', '.wb-table tbody td'],
    ['徽标 ok', '.wb-badge--ok'],
    ['强调文字', '.wb-scenetab[data-busy="1"] .wb-scenetab-icon'],
  ].forEach(function (p) {
    var el = document.querySelector(p[1]);
    if (!el) return;
    var fg = parseRGB(getComputedStyle(el).color);
    var bg = effBg(el);
    if (!fg || !bg) return;
    R.contrast.push({ what: p[0], ratio: Number(ratio(fg, bg).toFixed(2) ) });
  });

  /* ── 页面元素统计（组件覆盖） ── */
  var need = ['wb-titlebar','wb-scenebar','wb-body','wb-split','wb-main','wb-side','wb-footbar',
              'wb-btn','wb-input','wb-textarea','wb-select','wb-badge','wb-card','wb-row','wb-table',
              'wb-tabs','wb-tab','wb-empty','wb-toast','wb-switch','wb-bar','wb-panel','wb-panel-head',
              'wb-panel-body','wb-split-handle'];
  R.counts = {};
  need.forEach(function (c) { R.counts[c] = document.querySelectorAll('.' + c).length; });

  /* ── 纵向填充：面板是否铺满主区（空大块是密度缺陷） ── */
  var gridEl = document.querySelector('.wb-grid');
  var panelEl = document.querySelector('.wb-panel');
  if (gridEl && panelEl) {
    var gb = gridEl.getBoundingClientRect();
    var pb = panelEl.getBoundingClientRect();
    R.fill = {
      gridH: Math.round(gb.height),
      panelH: Math.round(pb.height),
      // 面板底边到 grid 底边的空隙
      gapBottom: Math.round(gb.bottom - pb.bottom),
      fillRatio: Number((pb.height / gb.height).toFixed(2)),
    };
  }

  /* ── 输出 ── */
  var pre = document.createElement('pre');
  pre.id = '__probe';
  pre.style.display = 'none';
  pre.textContent = JSON.stringify(R);
  document.body.appendChild(pre);
  document.title = 'PROBE_READY';
})();
</script>
`;

const UD = join(tmpdir(), 'wb-chrome-prof');

for (const page of ['skeleton.html', 'style-preview.html']) {
  const src = join(OUT, page);
  const dst = join(OUT, 'probe-' + page);
  const html = readFileSync(dst === src ? src : src, 'utf8');
  writeFileSync(dst, html.replace('</body>', INSTRUMENT + '\n</body>'));
}

function run(pageFile, viewport, budget = 1600) {
  const url = 'file:///' + join(OUT, pageFile).replace(/\\/g, '/');
  const dom = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--user-data-dir=' + UD, '--no-first-run', '--disable-extensions',
    '--window-size=' + viewport.w + ',' + viewport.h,
    '--virtual-time-budget=' + budget,
    '--dump-dom', url,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

  const m = dom.match(/<pre id="__probe"[^>]*>([\s\S]*?)<\/pre>/);
  if (!m) return { error: 'probe 未找到输出', page: pageFile, vw: viewport.w };
  const un = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return JSON.parse(un(m[1]));
}

const VIEWPORTS = [
  { name: '1440', w: 1440, h: 900 },
  { name: '1280', w: 1280, h: 860 },
  { name: '1100', w: 1100, h: 820 },
  { name: '900',  w: 900,  h: 780 },
  { name: '760',  w: 760,  h: 760 },
  { name: '720',  w: 720,  h: 720 },
];

// Chrome 的 --window-size 指外框，内视口更窄（本机实测差 18px）。
// 先测一次得到真实差值，再把每个目标宽度换算成外框宽度，保证测的是目标内视口。
const calib = run('probe-skeleton.html', { w: 1000, h: 700 }, 1200);
const PAD = calib.error ? 0 : (1000 - calib.vw);
if (PAD !== 0) {
  console.log('  · 视口校准：外框比内视口宽 ' + PAD + 'px（已自动补偿）');
}

const report = { generatedAt: new Date().toISOString(), chrome: CHROME, pad: PAD, runs: [] };
for (const vp of VIEWPORTS) {
  report.runs.push({ label: vp.name, ...run('probe-skeleton.html', { w: vp.w + PAD, h: vp.h }, 1600) });
}
report.preview = run('probe-style-preview.html', { w: 1280 + PAD, h: 3000 }, 2600);

writeFileSync(join(OUT, 'probe-report.json'), JSON.stringify(report, null, 2));

/* ══════════════ 2. 控制台报告 ══════════════ */

const bad = [];
console.log('\n  真实 Chrome 渲染测量 · ' + CHROME.split('/').pop());
console.log('  ' + '-'.repeat(96));
console.log('  ' + 'vw'.padStart(5) + '  ' + 'mainW'.padStart(6) + '  ' + 'sideW'.padStart(6) + '  ' +
  'side-mode'.padStart(10) + '  ' + 'spill'.padStart(6) + '  ' + 'vertical'.padStart(8) + '  ' +
  'fonts'.padStart(6) + '  ' + 'radii'.padStart(6) + '  ' + 'shadow'.padStart(7));
console.log('  ' + '-'.repeat(96));

for (const r of report.runs) {
  if (r.error) { console.log('  ' + r.label + '  ERROR ' + r.error); bad.push(r.label + ': ' + r.error); continue; }
  const s = r.shell || {};
  const w = (v) => (v === null || v === undefined) ? '—' : String(v);
  console.log('  ' + r.label.padStart(5) + '  ' +
    w(s.main && s.main.w).padStart(6) + '  ' +
    w(s.side && s.side.w).padStart(6) + '  ' +
    String(r.sideMode || '—').padStart(10) + '  ' +
    String(r.spillCount).padStart(6) + '  ' +
    String(r.verticalCount).padStart(8) + '  ' +
    String(r.scale.fontCount).padStart(6) + '  ' +
    String(r.scale.radiusCount).padStart(6) + '  ' +
    String(r.scale.shadowCount).padStart(7));

  if (r.pageOverflow) bad.push('vw ' + r.label + ': 页面横向溢出 (' + r.scrollW + ' > ' + r.clientW + ')');
  if (r.spillCount > 0) bad.push('vw ' + r.label + ': ' + r.spillCount + ' 个元素超出右缘');
  if (r.verticalCount > 0) bad.push('vw ' + r.label + ': ' + r.verticalCount + ' 处竖排文字');
  if (r.scale.fontCount > 7) bad.push('vw ' + r.label + ': 字号 ' + r.scale.fontCount + ' 档（上限 7）');
  if (r.scale.radiusCount > 3) bad.push('vw ' + r.label + ': 圆角 ' + r.scale.radiusCount + ' 档（上限 3）');
  if (r.scale.shadowCount > 5) bad.push('vw ' + r.label + ': 阴影 ' + r.scale.shadowCount + ' 级（上限 5）');
  for (const c of r.contrast || []) {
    if (c.ratio < 4.5) bad.push('vw ' + r.label + ': ' + c.what + ' 对比度 ' + c.ratio + ':1 < 4.5');
  }
  if (r.spills && r.spills.length) {
    for (const sp of r.spills.slice(0, 3)) {
      console.log('        ↳ ' + sp.tag + '.' + sp.cls + ' right=' + sp.right + ' w=' + sp.w);
    }
  }
  if (r.fill && r.fill.fillRatio < 0.95) {
    bad.push('vw ' + r.label + ': 面板未铺满主区（' + r.fill.fillRatio * 100 + '%，底部空 ' + r.fill.gapBottom + 'px）');
  }
  if (r.verticalText && r.verticalText.length) {
    for (const v of r.verticalText.slice(0, 3)) {
      console.log('        ↳ 竖排 ' + v.cls + ' ' + v.w + 'x' + v.h + ' "' + v.t + '"');
    }
  }
}

const p = report.preview;
if (p && !p.error) {
  console.log('\n  preview 页（1280 宽）');
  console.log('    组件统计: ' + Object.entries(p.counts).map(([k, v]) => k + '=' + v).join(' '));
  console.log('    实测对比度: ' + p.contrast.map((c) => c.what + ' ' + c.ratio + ':1').join(' · '));
  if (!p.pageOverflow) console.log('    无横向溢出 ✓');
  else bad.push('preview: 横向溢出');
}

console.log('\n  ' + '-'.repeat(96));
if (bad.length) {
  console.log('  FAIL · ' + bad.length + ' 项');
  for (const b of bad) console.log('    - ' + b);
  console.log('');
  process.exit(1);
}
console.log('  PASS · 全部指标达标');
console.log('  （720px 无溢出 / 无竖排 / 字号≤7档 / 圆角≤3档 / 阴影≤5级 / 正文≥4.5:1）\n');
