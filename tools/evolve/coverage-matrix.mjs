#!/usr/bin/env node
/**
 * 覆盖率热力表 —— 14 家 × 31 维，每格标状态，一眼看出还剩哪些格子要填。
 *
 * 图例： R=REAL（对方源码可复算）  o=OWN（我们自己的二手分析）  ?=判不了  - =非目标(A10/A15)  ·=无源码
 *
 * 为什么需要它：fair-compare 只给「可比 N 维」，但看不出**具体是哪几维缺**。
 * 这个表把缺口摊开，且给出每家/每维的覆盖率，作为下一轮的工作清单。
 *
 * 用法：node tools/evolve/coverage-matrix.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyEvidence, hasSource } from './lib/evidence-provenance.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const mx = JSON.parse(readFileSync(join(ROOT, 'prototype/hermes-agents/matrix-data.json'), 'utf8'));

const NON_GOAL = new Set(['A10', 'A15']);
const NON_IMPL = new Set((mx._nonImplementation && mx._nonImplementation.ids) || []);
const NO_SOURCE = ['chatgpt', 'claude', 'cursor', 'trae', 'workbuddy', 'codebuddy', 'qoder', 'pi-main', 'WeKnora'];

const dims = [];
for (const g of mx.dimensions) for (const it of g.items) dims.push(it);

const opponents = Object.keys(dims[0]).filter((k) => !['id', 'name', 'us'].includes(k));

const cell = (it, oid) => {
  const v = it[oid];
  if (!v) return ' ';
  const score = Array.isArray(v) ? v[0] : v;
  const ev = Array.isArray(v) && v.length > 1 ? v[1] : '';
  if (NON_IMPL.has(oid)) return '·';
  if (!hasSource(oid)) return '.';
  if (score === '判不了') return '?';
  return classifyEvidence(oid, ev) === 'REAL' ? 'R' : 'o';
};

console.log('');
console.log('  覆盖率热力表（R=可复算 o=二手 ?=判不了 -=非目标 ·=无源码）');
  console.log('  ⚠ 本表的 "x/14" 是 **REAL 家数**（证据能指向对方源码的家数），不是「有+部分」的家数。');
  console.log('    两个口径都要看：REAL 高 = 证据硬；有+部分 高 = 功能面覆盖广。混用会说错话。');
console.log('  ' + '─'.repeat(96));
// 表头（维度 id 两行显示）
let h1 = '  ' + '对手'.padEnd(18);
for (const it of dims) h1 += it.id.padEnd(3);
console.log(h1 + '  覆盖');
for (const oid of opponents) {
  if (NO_SOURCE.includes(oid)) continue;
  let row = '  ' + oid.padEnd(18);
  let real = 0, eligible = 0;
  for (const it of dims) {
    const c = cell(it, oid);
    row += c.padEnd(3);
    if (!NON_GOAL.has(it.id) && c !== '·' && c !== '.') eligible++;
    if (c === 'R') real++;
  }
  const pct = eligible ? Math.round((real / eligible) * 100) : 0;
  console.log(row + '  ' + String(real).padStart(2) + '/' + String(eligible).padStart(2) + ' ' + String(pct).padStart(3) + '%');
}
console.log('  ' + '─'.repeat(96));
console.log('  维度顺序：' + dims.map((d) => d.id).join(' '));
console.log('');

// 按维度统计：多少家已 REAL（找「最缺的维」）
console.log('  按维度看缺口（已REAL家数 / 有源码家数）：');
let line = '   ';
for (const it of dims) {
  let r = 0, tot = 0;
  for (const oid of opponents) {
    if (NON_IMPL.has(oid) || !hasSource(oid)) continue;
    tot++;
    if (cell(it, oid) === 'R') r++;
  }
  line += it.id + ':' + r + '/' + tot + '  ';
  if (line.length > 92) { console.log(line); line = '   '; }
}
if (line.trim()) console.log(line);
console.log('');
