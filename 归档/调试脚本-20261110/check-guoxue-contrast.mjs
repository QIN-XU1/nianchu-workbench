/**
 * 国色体系对比度实测（WCAG 2.1 AA）
 *
 * 判据：
 *   正文 ≥ 4.5:1
 *   大字（≥18px 或 ≥14px bold）/ 组件边界 ≥ 3.0:1
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = path.resolve(HERE, '..', 'workbench', '外壳', 'ui', 'styles', 'guoxue-tokens.css');

// ═══════════════════════════════════════════════════════════════
//  颜色解析
// ═══════════════════════════════════════════════════════════════
function parseHex(s) {
  const m = String(s).trim().replace('#', '');
  if (m.length === 3) return [parseInt(m[0] + m[0], 16), parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16)];
  if (m.length === 6) return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
  return null;
}

function relLum(rgb) {
  const [r, g, b] = rgb.map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(hex1, hex2) {
  const a = parseHex(hex1), b = parseHex(hex2);
  if (!a || !b) return null;
  const la = relLum(a), lb = relLum(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// ═══════════════════════════════════════════════════════════════
//  读 CSS 变量
// ═══════════════════════════════════════════════════════════════
function readVars(cssPath) {
  const txt = fs.readFileSync(cssPath, 'utf8');
  const out = {};
  // 匹配 --name: value;  只取 hex 值
  const re = /(--[a-zA-Z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\s*;/g;
  let m;
  while ((m = re.exec(txt))) out[m[1]] = m[2];
  return out;
}

const V = readVars(CSS);

// 手动补 alias（CSS 里是 var() 引用，正则取不到 hex）
const ALIAS = {
  '--s0': V['--gu-xuan-ji'],
  '--s1': V['--gu-xuan-deep'],
  '--s2': V['--gu-xuan'],
  '--s3': V['--gu-xuan-light'],
  '--s4': V['--gu-xuan-raised'],
  '--s5': V['--gu-xuan-active'],
  '--t1': V['--gu-su'],
  '--t2': V['--gu-su-2'],
  '--t3': V['--gu-su-3'],
  '--t4': V['--gu-su-4'],
  '--a1': V['--gu-qing'],
  '--a2': V['--gu-qing-light'],
  '--a3': V['--gu-qing-deep'],
  '--ok': V['--gu-huang'],
  '--warn': V['--gu-chi'],
  '--err': V['--gu-err'],
  '--info': V['--gu-qing'],
};

// ═══════════════════════════════════════════════════════════════
//  测试矩阵：正文色 × 7 级底
// ═══════════════════════════════════════════════════════════════
const SURFACES = [
  ['--gu-xuan-ji', '玄之极'],
  ['--gu-xuan-deep', '玄深'],
  ['--gu-xuan', '玄'],
  ['--gu-xuan-light', '玄浅'],
  ['--gu-xuan-raised', '抬起'],
  ['--gu-xuan-hover', '悬停'],
  ['--gu-xuan-active', '按下'],
];

const TEXT = [
  ['--gu-su', '素白（正文一级）', 4.5],
  ['--gu-su-2', '次文字（正文二级）', 4.5],
  ['--gu-su-3', '辅助（仅大字）', 3.0],
  ['--gu-qing', '石青（信息/链接）', 4.5],
  ['--gu-chi', '朱砂（告警）', 4.5],
  ['--gu-huang', '藤黄（成功）', 4.5],
  ['--gu-err', '朱殷（错误）', 4.5],
];

const rows = [];
let pass = 0, fail = 0;

for (const [tk, tn, need] of TEXT) {
  for (const [sk, sn] of SURFACES) {
    const fg = V[tk];
    const bg = V[sk];
    if (!fg || !bg) continue;
    const c = contrast(fg, bg);
    if (c === null) continue;
    const ok = c >= need;
    if (ok) pass++; else fail++;
    rows.push({ fg: tn, bg: sn, ratio: c, need, ok });
  }
}

// ═══════════════════════════════════════════════════════════════
//  输出
// ═══════════════════════════════════════════════════════════════
console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  国色体系 · 对比度实测（WCAG 2.1 AA）');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  源: ' + path.basename(CSS));
console.log();

console.log('  ratio  need  fg                        bg          status   ');
console.log('  ' + '─'.repeat(76));

for (const r of rows) {
  const ratio = r.ratio.toFixed(2).padStart(6);
  const need = r.need.toFixed(1).padStart(4);
  const fg = r.fg.padEnd(24);
  const bg = r.bg.padEnd(10);
  const st = r.ok ? ' PASS' : ' FAIL';
  console.log('  ' + ratio + '  ' + need + '  ' + fg + '  ' + bg + '  ' + st);
}

console.log();
console.log('═══════════════════════════════════════════════════════════════════════');

// 汇总每个文字色对七级底的最差值
const byFg = {};
for (const r of rows) {
  if (!byFg[r.fg] || r.ratio < byFg[r.fg].ratio) byFg[r.fg] = r;
}
console.log('  最差值汇总（每个文字色对 7 级底取最差）:');
for (const k of Object.keys(byFg)) {
  const r = byFg[k];
  console.log('    ' + (r.ok ? '✓' : '✗') + ' ' + k.padEnd(24) +
    ' 最低 ' + r.ratio.toFixed(2) + ':1（on ' + r.bg + '，需 ' + r.need.toFixed(1) + '）');
}

console.log();
console.log('  共 ' + rows.length + ' 组：' + pass + ' 通过 / ' + fail + ' 未达标');
console.log(fail === 0 ? '  ✅ 全部达标' : '  ⚠ 有 ' + fail + ' 组未达标');
console.log('═══════════════════════════════════════════════════════════════════════');

// 顺带输出间色（场景用）的对比度
console.log();
console.log('  间色（场景区分）对玄底对比度:');
const jian = [
  ['--gu-jian1', '赤缇'], ['--gu-jian2', '朱殷'], ['--gu-jian3', '藤黄'],
  ['--gu-jian4', '秋香'], ['--gu-jian5', '松花'], ['--gu-jian6', '竹青'],
  ['--gu-jian7', '石青'], ['--gu-jian8', '群青'], ['--gu-jian9', '藕荷'],
  ['--gu-jian10', '胭脂'],
];
for (const [k, n] of jian) {
  const c = contrast(V[k], V['--gu-xuan']);
  if (c) console.log('    ' + (c >= 3 ? '✓' : '✗') + ' ' + n.padEnd(6) + ' ' + V[k] + '  ' + c.toFixed(2) + ':1');
}

process.exitCode = fail === 0 ? 0 : 1;
