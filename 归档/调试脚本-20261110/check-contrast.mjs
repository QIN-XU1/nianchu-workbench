#!/usr/bin/env node
/**
 * check-contrast.mjs — 对比度实测
 *
 * 用法：
 *   node prototype/check-contrast.mjs
 *   node prototype/check-contrast.mjs --css <path/to/tokens.css>
 *   node prototype/check-contrast.mjs --json
 *
 * 做什么：
 *   1. 从 tokens.css 里解析出暗/亮两套 --color-* 令牌（不硬编码值，防止脚本与样式脱节）
 *   2. 对 WCAG AA 要求的组合逐对计算对比度（WCAG 2.1 相对亮度公式）
 *   3. 输出实测数值表；正文 <4.5 或大字 <3.0 记为不合规
 *
 * 判据（WCAG 2.1 AA）：
 *   正文 正常字号        ≥ 4.5:1
 *   大字 ≥18.66px bold / ≥24px  ≥ 3.0:1
 *   非文本（边框/图标）   ≥ 3.0:1（AA 对 UI 组件的要求）
 *
 * 只用 Node 内置模块。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const DEFAULT_CSS = join(HERE, '..', 'workbench', '外壳', 'ui', 'styles', 'tokens.css');

const args = process.argv.slice(2);
const cssPath = args.includes('--css')
  ? args[args.indexOf('--css') + 1]
  : DEFAULT_CSS;
const asJson = args.includes('--json');

/* ══════════════════════════════════════════
   1. 读 CSS，抽出两套色板
   ══════════════════════════════════════════ */

const css = readFileSync(cssPath, 'utf8');

/** 从一段文本里抽出 --color-xxx: #hex; 形式的令牌 */
function extractColors(blockText) {
  const out = {};
  const re = /--color-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g;
  let m;
  while ((m = re.exec(blockText)) !== null) {
    out[m[1]] = m[2].toLowerCase();
  }
  return out;
}

/** 取某个选择器的块文本（大括号配平；选择器可出现在逗号列表里） */
function extractBlock(source, selector) {
  const idx = source.indexOf(selector);
  if (idx < 0) return '';
  const start = source.indexOf('{', idx);
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start + 1, i);
    }
  }
  return '';
}

const darkColors = extractColors(extractBlock(css, ':root {'));
const lightColors = extractColors(extractBlock(css, '[data-theme="light"]'));

/* ══════════════════════════════════════════
   2. 对比度计算（WCAG 2.1）
   ══════════════════════════════════════════ */

function hexToRgb(hex) {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6); // 忽略 alpha，按不透明色计算（本项目不使用透明文字）
  if (h.length !== 6) throw new Error(`无法解析颜色: ${hex}`);
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fgHex, bgHex) {
  const l1 = relativeLuminance(hexToRgb(fgHex));
  const l2 = relativeLuminance(hexToRgb(bgHex));
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/* ══════════════════════════════════════════
   3. 检查清单
   ══════════════════════════════════════════
   每条：[前景令牌, 背景令牌, 用途, 阈值]
*/

const SURFACES = ['void', 'sunken', 'base', 'panel', 'raised', 'hover', 'active'];

/** 正文/次要/三级文字：必须在所有实际承载它们的表面上达标 */
function textOnSurfaces(fgKey, label, threshold) {
  return SURFACES.map((bg) => [fgKey, bg, `${label} on ${bg}`, threshold]);
}

const CHECKS = [
  // ── 正文与次级文字（≥4.5，普通字号）
  ...textOnSurfaces('txt-1', '正文一级', 4.5),
  ...textOnSurfaces('txt-2', '正文二级', 4.5),
  ...textOnSurfaces('txt-3', '正文三级', 4.5),

  // ── 强调色当文字用（链接/选中态/图标）
  ...textOnSurfaces('accent', '强调色文字', 4.5),

  // ── 状态色当文字用
  ...textOnSurfaces('ok', '成功色文字', 4.5),
  ...textOnSurfaces('warn', '警告色文字', 4.5),
  ...textOnSurfaces('err', '错误色文字', 4.5),

  // ── 实心强调底上的文字（按钮 primary）
  ['accent-ink', 'accent', '主按钮文字 / 强调底', 4.5],
  ['accent-ink', 'accent-hover', '主按钮文字 / 强调悬停', 4.5],
  ['accent-ink', 'accent-press', '主按钮文字 / 强调按下', 4.5],

  // ── 状态淡底上的状态文字（徽标）
  ['accent', 'accent-soft', '强调徽标文字', 4.5],
  ['ok', 'ok-soft', '成功徽标文字', 4.5],
  ['warn', 'warn-soft', '警告徽标文字', 4.5],
  ['err', 'err-soft', '错误徽标文字', 4.5],

  // ── 强调淡底上的正文（选中行）
  ['txt-1', 'accent-soft', '选中行正文', 4.5],
  ['txt-2', 'accent-soft', '选中行二级文字', 4.5],

  // ── 大字（≥3.0）：标题/指标数字
  ['txt-1', 'base', '大标题 on base', 3.0],
  ['txt-1', 'panel', '大标题 on panel', 3.0],
  ['txt-1', 'accent-soft', '大标题 on 选中底', 3.0],

  // ── 非文本 UI 组件（WCAG 1.4.11 要求 ≥3.0，仅针对「必须被识别为控件」的边界）
  ['control-line', 'panel', '交互边界 on panel', 3.0],
  ['control-line', 'base', '交互边界 on base', 3.0],
  ['control-line', 'sunken', '交互边界 on sunken', 3.0],
  ['control-line', 'raised', '交互边界 on raised', 3.0],
  ['control-line', 'hover', '交互边界 on hover', 3.0],
  ['control-line', 'active', '交互边界 on active', 3.0],
  ['accent', 'sunken', '焦点环 / 输入框聚焦边框 on sunken', 3.0],
  ['accent', 'void', '焦点环 on void', 3.0],
  ['txt-disabled', 'base', '禁用文字 on base', 0],   // 豁免，仅记录数值
  ['line', 'base', '发丝分隔线 on base', 0],         // 豁免，装饰
  ['line', 'panel', '发丝分隔线 on panel', 0],       // 豁免，装饰
  ['line', 'raised', '发丝分隔线 on raised', 0],     // 豁免，装饰
];

/* ══════════════════════════════════════════
   4. 执行
   ══════════════════════════════════════════ */

/** 亮色主题里 --color-raised 与 panel 同值属正常，去重后仍逐条算 */
const THEMES = [
  { id: 'dark', colors: darkColors, note: '默认' },
  { id: 'light', colors: lightColors, note: '[data-theme="light"]' },
];

const results = [];
let failures = 0;
let missing = 0;

for (const theme of THEMES) {
  const rows = [];
  for (const [fgKey, bgKey, usage, threshold] of CHECKS) {
    const fg = theme.colors[fgKey];
    const bg = theme.colors[bgKey];
    if (!fg || !bg) {
      rows.push({ usage, fgKey, bgKey, fg, bg, ratio: null, threshold, status: 'MISSING' });
      missing++;
      continue;
    }
    const ratio = contrast(fg, bg);
    const ok = threshold === 0 ? true : ratio >= threshold;
    if (!ok) failures++;
    rows.push({
      usage, fgKey, bgKey, fg, bg,
      ratio: Number(ratio.toFixed(2)),
      threshold,
      status: threshold === 0 ? 'N/A' : (ok ? 'PASS' : 'FAIL'),
    });
  }
  results.push({ theme: theme.id, note: theme.note, rows });
}

/* ══════════════════════════════════════════
   5. 输出
   ══════════════════════════════════════════ */

if (asJson) {
  console.log(JSON.stringify({ cssPath, failures, missing, results }, null, 2));
} else {
  const W = 5;
  console.log('');
  console.log('  contrast audit · WCAG 2.1 AA');
  console.log('  source: ' + cssPath);
  console.log('');

  for (const theme of results) {
    console.log(`  ── ${theme.theme}  (${theme.note}) ──`);
    console.log(
      '  ' +
      'ratio'.padStart(W) + '  ' +
      'need'.padStart(4) + '  ' +
      'fg'.padEnd(14) + '  ' +
      'bg'.padEnd(14) + '  ' +
      'status'.padEnd(7) + '  usage'
    );
    for (const r of theme.rows) {
      if (r.status === 'MISSING') {
        console.log(`  ${'—'.padStart(W)}  ${String(r.threshold).padStart(4)}  ${String(r.fgKey).padEnd(14)}  ${String(r.bgKey).padEnd(14)}  ${'MISS'.padEnd(7)}  ${r.usage}`);
        continue;
      }
      const ratioStr = r.ratio.toFixed(2);
      console.log(
        `  ${ratioStr.padStart(W)}  ${(r.threshold === 0 ? '—' : r.threshold.toFixed(1)).padStart(4)}  ` +
        `${(r.fg + ' ' + r.fgKey).padEnd(14)}  ${(r.bg + ' ' + r.bgKey).padEnd(14)}  ` +
        `${r.status.padEnd(7)}  ${r.usage}`
      );
    }
    console.log('');
  }

  // 摘要：暗色主题里实测最低的几个正文比值（便于人工复核）
  for (const theme of results) {
    const textRows = theme.rows.filter((r) => r.threshold >= 4.5 && r.ratio !== null);
    if (!textRows.length) continue;
    const min = textRows.reduce((a, b) => (a.ratio < b.ratio ? a : b));
    console.log(`  ${theme.theme}: 正文类最低 ${min.ratio.toFixed(2)}:1 (${min.usage})，共 ${textRows.length} 组`);
  }

  console.log('');
  if (missing) console.log(`  ⚠ 缺失令牌 ${missing} 条（CSS 与清单不一致）`);
  if (failures) {
    console.log(`  FAIL · ${failures} 组不达标`);
    console.log('');
    process.exit(1);
  }
  console.log('  PASS · 全部达标（阈值：正文 4.5:1，大字/组件 3.0:1）');
  console.log('');
}
