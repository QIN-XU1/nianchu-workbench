#!/usr/bin/env node
/**
 * 复核期净变化报告 —— 量化「第 68-72 轮（A7/D2/A5/C2/A14 五轮实证复核）」到底改了什么。
 *
 * 为什么需要：连续五轮都在『修正对比准确性』，要回答两个问题：
 *   ① 这些复核让我们变强了，还是变弱了？（诚实：多半是对手被我们低估，所以是我们变弱）
 *   ② 净效果是判定的变化，还是仅证据质量的变化？
 *
 * 做法：取复核起点前一个提交的矩阵 vs 当前矩阵，逐对手、逐维度比对判定。
 * 用法：node tools/evolve/review-delta.mjs <fromCommit>
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FROM = process.argv[2] || 'HEAD~10';
const MATRIX = 'prototype/hermes-agents/matrix-data.json';

function loadFrom(git) {
  const raw = execSync(`git show ${git}:${MATRIX}`, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(raw);
}
const oldMx = loadFrom(FROM);
const newMx = JSON.parse(readFileSync(MATRIX, 'utf8'));

const idx = (mx) => { const m = {}; for (const g of mx.dimensions) for (const it of g.items) m[it.id] = it; return m; };
const o = idx(oldMx), n = idx(newMx);
const subjects = newMx.subjects.filter((s) => s.id !== 'us').map((s) => s.id);

const rank = { '有': 3, '部分': 2, '无': 1, '判不了': 0 };
const changes = [];
for (const id of Object.keys(n)) {
  for (const s of ['us', ...subjects]) {
    const ov = Array.isArray(o[id] && o[id][s]) ? o[id][s][0] : '?';
    const nv = Array.isArray(n[id] && n[id][s]) ? n[id][s][0] : '?';
    if (ov !== nv) changes.push({ dim: id, who: s, from: ov, to: nv, dir: (rank[nv] || 0) - (rank[ov] || 0) });
  }
}

console.log(`\n  复核期净变化（${FROM} → HEAD）  共 ${changes.length} 处判定变化`);
console.log('  ' + '─'.repeat(70));

// 按对手汇总：对手变强 = 我方相对变弱
const byWho = {};
for (const c of changes) { (byWho[c.who] = byWho[c.who] || []).push(c); }
// 对手（非 us）的净变化方向
const oppUp = changes.filter((c) => c.who !== 'us' && c.dir > 0).length;
const oppDown = changes.filter((c) => c.who !== 'us' && c.dir < 0).length;
const usUp = changes.filter((c) => c.who === 'us' && c.dir > 0).length;
const usDown = changes.filter((c) => c.who === 'us' && c.dir < 0).length;

console.log('  对手判定【上调】(变强，我方相对变弱): ' + oppUp + ' 处');
console.log('  对手判定【下调】(变弱，我方相对变强): ' + oppDown + ' 处');
console.log('  我方判定【上调】: ' + usUp + ' 处   我方【下调】: ' + usDown + ' 处');
console.log('');
console.log('  逐对手明细：');
for (const s of subjects) {
  const cs = byWho[s] || [];
  if (!cs.length) continue;
  const up = cs.filter((c) => c.dir > 0).length, dn = cs.filter((c) => c.dir < 0).length;
  const tag = up > dn ? '对手变强' : dn > up ? '对手变弱' : '平';
  console.log(`    ${s.padEnd(20)} 上调 ${up} 下调 ${dn}  [${tag}]  ${cs.map((c) => c.dim + ':' + c.from + '→' + c.to).join(' ')}`);
}
console.log('');
console.log('  结论：若「对手上调」远多于「对手下调」，说明这几轮复核**主要是把对手从低估中补正**，');
console.log('        我方相对地位是**变弱**的 —— 这不是坏事，是把虚高的「领先」打回真实。');