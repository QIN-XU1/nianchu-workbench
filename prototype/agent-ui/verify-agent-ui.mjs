#!/usr/bin/env node
/**
 * 我们自己的 agent 界面 v0 —— 可判定验收
 *
 * 为什么要有这个文件：设计这种东西最容易变成"我觉得好看"。
 * 所以这里只做两种事：
 *   1. 算数 —— 对比度是不是真的 ≥4.5:1（WCAG AA 正文），两个主题都算
 *   2. 查引用 —— 有没有 var(--x) 指向不存在的 token（UI 里最常见的静默失效）
 *
 * 抄自 omp-studio 的做法：他们在 tokens.css 里把 #8f96a1（2.95:1）改掉，
 * 并写清每一档的实测值。声称达标和算出来达标是两件事，这里做后者。
 *
 * 用法：node verify-agent-ui.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const HTML = path.join(REPO, 'prototype/agent-ui/workbench-v0.html');
const SHOTS = path.join(REPO, 'research/screenshots');

let pass = 0, fail = 0, warn = 0;
const ICON = { ok: '✓', no: '✗', wr: '◐' };
const ok = (c, msg) => { if (c) { pass++; console.log('  ' + ICON.ok + ' ' + msg); } else { fail++; console.log('  ' + ICON.no + ' ' + msg); } return c; };
const wr = (msg) => { warn++; console.log('  ' + ICON.wr + ' ' + msg); };

console.log('');
console.log('  我们自己的 agent 界面 v0 —— 可判定验收');
console.log('  ' + '─'.repeat(64));

// ── 1. 文件在位 ──
if (!fs.existsSync(HTML)) { console.log('  ✗ 找不到 ' + HTML); process.exit(1); }
const html = fs.readFileSync(HTML, 'utf8');
ok(html.length > 20000, '界面文件在位（' + Math.round(html.length / 1024) + 'KB 单文件，无构建依赖）');

// ── 2. 抽出两个主题的 token 块 ──
// 用花括号计数取块，不用正则 —— 正则会被块内注释/嵌套里的括号截断（本轮实测踩到）
function themeBlock(selectorLiteral) {
  const at = html.indexOf(selectorLiteral);
  if (at < 0) return null;
  const open = html.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0, end = -1;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
    // 必须先剥注释再按 ; 切分：/* 说明 */ --text: … 这一段的开头是 /* 而不是 --，直接切会漏掉紧跟注释的那个变量（本轮实测踩到）
    const body = html.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, '');
  const vars = {};
  for (const d of body.split(';')) {
    const mm = d.match(/^\s*(--[a-z0-9-]+)\s*:\s*(.+?)\s*$/i);
    if (mm) vars[mm[1]] = mm[2];
  }
  return vars;
}

const dark = themeBlock(':root, :root[data-theme="dark"]');
const light = themeBlock(':root[data-theme="light"]');

ok(dark && Object.keys(dark).length > 25, '暗色主题 token 块解析成功（' + (dark ? Object.keys(dark).length : 0) + ' 个变量）');
ok(light && Object.keys(light).length > 25, '亮色主题 token 块解析成功（' + (light ? Object.keys(light).length : 0) + ' 个变量）');

// ── 3. 对比度：算，不声称 ──
function parseColor(v) {
  if (!v) return null;
  let m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = v.match(/^#([0-9a-f]{3})$/i);
  if (m) {
    const h = m[1];
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
  }
  m = v.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (m) return [+m[1], +m[2], +m[3]];
  return null;
}
function relLum([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(fg, bg) {
  const a = parseColor(fg), b = parseColor(bg);
  if (!a || !b) return null;
  const L1 = relLum(a), L2 = relLum(b);
  const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

function checkContrast(name, vars, pairs) {
  let allOk = true;
  const lines = [];
  for (const [label, fgKey, bgKey, min] of pairs) {
    const ratio = contrast(vars[fgKey], vars[bgKey]);
    if (ratio === null) { lines.push(label + ' 取值无法解析（' + vars[fgKey] + ' on ' + vars[bgKey] + '）'); allOk = false; continue; }
    const good = ratio >= min;
    if (!good) allOk = false;
    lines.push(label + ' ' + ratio.toFixed(2) + ':1 (需 ≥' + min + ')' + (good ? '' : '  ← 不达标'));
  }
  ok(allOk, name + ' —— ' + lines.join(' · '));
}

if (dark && light) {
  const textPairs = [
    ['正文 text', '--text', '--surface', 4.5],
    ['次级 text-2', '--text-2', '--surface', 4.5],
    ['三级 text-3', '--text-3', '--surface', 4.5],
    ['最淡 text-faint', '--text-faint', '--surface', 4.5],
  ];
  const statePairs = [
    ['通过', '--st-pass', '--surface', 4.5],
    ['待补', '--st-warn', '--surface', 4.5],
    ['失败', '--st-fail', '--surface', 4.5],
    ['判不了', '--st-unknown', '--surface', 4.5],
  ];
  console.log('');
  console.log('  对比度（WCAG AA 正文门槛 4.5:1）—— 实测不是声称');
  checkContrast('暗色 文字梯', dark, textPairs);
  checkContrast('暗色 四态色', dark, statePairs);
  checkContrast('亮色 文字梯', light, textPairs);
  checkContrast('亮色 四态色', light, statePairs);
}

// ── 4. 四态必须齐全：少一个态，"判不了"就会塌缩成别的 ──
console.log('');
for (const [k, label] of [['--st-pass', '通过'], ['--st-warn', '待补'], ['--st-fail', '失败'], ['--st-unknown', '判不了']]) {
  ok(dark && dark[k] && light && light[k], '四态色齐备：' + label + '（' + k + '，两个主题都有）');
}

// ── 5. 所有 var(--x) 引用都必须在文件里有定义 ──
const defined = new Set([...html.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
const used = new Set([...html.matchAll(/var\((--[a-z0-9-]+)/gi)].map((m) => m[1]));
const missing = [...used].filter((u) => !defined.has(u));
ok(missing.length === 0, '没有悬空的 token 引用（用到 ' + used.size + ' 个，全部已定义）' + (missing.length ? ' 缺: ' + missing.join(', ') : ''));

// ── 6. 密度只缩放间距，不动字号 ──
const densityOk = /\[data-density="compact"\]\s*\{\s*--density-scale:\s*0\.85/.test(html)
  && /\[data-density="cozy"\]\s*\{\s*--density-scale:\s*1\.15/.test(html);
ok(densityOk, '信息密度两档在位（紧凑 0.85× / 宽松 1.15×）');
// 间距梯必须用 calc(* density)（那是设计意图），字号梯必须不用（否则改密度会改字号）
const spScales = /--sp-16:\s*calc\(16px \* var\(--density-scale\)\)/.test(html);
const fsFixed = !/--fs-\d+:\s*calc\(/.test(html);
ok(spScales, '间距梯随密度缩放（--sp-* = calc(px × density-scale)）');
ok(fsFixed, '字号梯不随密度缩放（--fs-* 是固定值，改密度不会改字号）');

// ── 7. 深度不靠阴影堆出来：浮层走 1px 环 + 微阴影 ──
ok(/--shadow-float:/.test(html), '浮层深度用单一 --shadow-float（1px 环负责边界，微阴影只补厚度）');

// ── 8. 截图证据 ──
console.log('');
for (const n of ['dark', 'light', 'compact']) {
  const p = path.join(SHOTS, '我们-v0-' + n + '.png');
  const exists = fs.existsSync(p);
  ok(exists, '截图证据：我们-v0-' + n + '.png' + (exists ? '  ' + Math.round(fs.statSync(p).size / 1024) + 'KB' : ''));
}

console.log('');
console.log('  ' + '─'.repeat(64));
console.log('  通过 ' + pass + '   待补 ' + warn + '   失败 ' + fail);
console.log('');
process.exit(fail ? 1 : warn ? 3 : 0);
