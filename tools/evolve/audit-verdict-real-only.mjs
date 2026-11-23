#!/usr/bin/env node
/**
 * 判定在「仅 REAL」口径下是否仍成立 —— 反查我自己的结论有没有被二手证据撑起来。
 *
 * 起因（第 98 轮）：`project-verdict` 判「实质超越」时用的是**全部可比维度**，
 * 其中含「OWN」——那些格子的对手证据是我们的分析文档，不是对方源码。
 * 于是自然要问：**如果把 OWN 全部踢掉，只看 REAL 可复算的维度，判定还成立吗？**
 *
 * 本工具对每个对手重算：仅 REAL 维度的 领先/平/落后、可比维数、覆盖率，
 * 再用与 project-verdict **相同的判定标准**给出「REAL-only 判定」，
 * 并与原判定并排显示 —— 若两者不一致，原判定就是被二手撑起来的。
 *
 * 四态：0 全部一致 · 1 有不一致（需人工复核）· 2 工具自检失败
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyEvidence } from './lib/evidence-provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mx = JSON.parse(readFileSync(path.join(ROOT, 'prototype/hermes-agents/matrix-data.json'), 'utf8'));
const pv = JSON.parse(readFileSync(path.join(ROOT, 'evidence/evolve/project-verdict.json'), 'utf8'));

const dims = []; for (const g of mx.dimensions) for (const it of g.items) dims.push(it);
const nonGoal = new Set(((mx._deliberateGaps && mx._deliberateGaps.items) || []).map((x) => String(x.dim)));
const v0 = (it, s) => (Array.isArray(it[s]) ? it[s][0] : '?');
const score = (x) => (x === '有' ? 1 : x === '部分' ? 0.5 : x === '无' ? 0 : null);

// 与 project-verdict 相同的判定标准
const CRIT = { minComparable: 10, maxLag: 0, minNet: 2, minCoverage: 0.6 };

function judge({ comparable, lead, lag, coverage }) {
  const net = lead - lag;
  const ok = comparable >= CRIT.minComparable && lag <= CRIT.maxLag && net >= CRIT.minNet && coverage >= CRIT.minCoverage;
  return { ok, net, reason: ok ? '成立' : (comparable < CRIT.minComparable ? '可比维不足' : lag > CRIT.maxLag ? '有落后维' : net < CRIT.minNet ? '净胜不足' : '覆盖率不足') };
}

/** 计算某个对手在指定口径（realOnly?）下的净结果 */
function tally(oid, realOnly) {
  let lead = 0, tie = 0, lag = 0, comparable = 0;
  for (const it of dims) {
    if (nonGoal.has(it.id)) continue;         // 非目标维不计
    const us = v0(it, 'us'), them = v0(it, oid);
    if (us === '判不了' || them === '判不了') continue;
    const raw = it[oid];
    const ev = Array.isArray(raw) && raw.length > 1 ? raw[1] : '';
    const prov = classifyEvidence(oid, ev);
    if (prov === 'NONE') continue;             // 对方根本没有该能力 → 不构成可比
    if (realOnly && prov !== 'REAL') continue; // 仅 REAL 口径
    const a = score(us), b = score(them);
    if (a == null || b == null) continue;
    comparable++;
    if (a > b) lead++; else if (a < b) lag++; else tie++;
  }
  return { comparable, lead, tie, lag, coverage: comparable / (dims.length - nonGoal.size) };
}

// ── 自检：只含 OWN 的对手，REAL-only 可比维必须为 0（否则口径错）──
{
  const t = tally('__no_such_opponent__', true);
  if (t.comparable !== 0) { console.error('  ✗ 自检失败：不存在的对手 REAL-only 可比维应为 0，实得 ' + t.comparable); process.exit(2); }
  if (judge({ comparable: 0, lead: 0, lag: 0, coverage: 0 }).ok) { console.error('  ✗ 自检失败：0 可比维不该判「成立」'); process.exit(2); }
  if (!judge({ comparable: 20, lead: 10, lag: 0, coverage: 0.9 }).ok) { console.error('  ✗ 自检失败：充足领先应判「成立」'); process.exit(2); }
}

const rows = [];
let mismatch = 0;
for (const r of pv.rows) {
  if (/^不可比/.test(r.verdict || '')) continue;
  const all = tally(r.opponent, false);
  const real = tally(r.opponent, true);
  const jAll = judge(all), jReal = judge(real);
  // ★只有原判定是「实质超越」的，才用该标准去核验；
  //   对「基本超越 / 可比不足 / 不及」套用「实质超越」标准是**类别错误**（第 98 轮自己踩到并修正）。
  const applies = r.verdict === '实质超越';
  const same = !applies || jAll.ok === jReal.ok;
  if (!same) mismatch++;
  rows.push({ opponent: r.opponent, name: r.name, verdict: r.verdict, appliesRealCheck: applies, all: { ...all, ...jAll }, real: { ...real, ...jReal }, consistent: same });
}

rows.sort((a, b) => (b.all.lead - b.all.lag) - (a.all.lead - a.all.lag));

console.log('');
console.log('  判定在「仅 REAL」口径下是否仍成立（反查二手证据有没有撑起结论）');
console.log('  ' + '─'.repeat(88));
console.log('  ' + '对手'.padEnd(20) + '原判定'.padEnd(7) + '全可比 领先/平/落后'.padEnd(22) + '仅REAL 领先/平/落后'.padEnd(22) + 'REAL判定');
console.log('  ' + '─'.repeat(88));
for (const r of rows) {
  const a = `${r.all.lead}/${r.all.tie}/${r.all.lag}(${r.all.comparable})`;
  const b = `${r.real.lead}/${r.real.tie}/${r.real.lag}(${r.real.comparable})`;
  const realCol = r.appliesRealCheck ? (r.real.ok ? '成立' : '✗ ' + r.real.reason) : '—（非实质超越，不适用）';
  console.log('  ' + String(r.name || r.opponent).slice(0, 18).padEnd(20) + String(r.verdict).padEnd(7)
    + a.padEnd(22) + b.padEnd(22) + realCol + (r.consistent ? '' : '  ⚠与原判定不一致'));
}
console.log('  ' + '─'.repeat(88));
const applied = rows.filter((r) => r.appliesRealCheck).length;
console.log('  适用核验 ' + applied + ' 家（原判定=实质超越）· 不一致 ' + mismatch + ' 家');
console.log('  说明：非「实质超越」的对手不套用该标准（避免类别错误）；其余行仅列出 REAL-only 数据供参考。');

mkdirSync(path.join(ROOT, 'evidence/evolve'), { recursive: true });
writeFileSync(path.join(ROOT, 'evidence/evolve/verdict-real-only.json'), JSON.stringify({ at: new Date().toISOString(), crit: CRIT, rows }, null, 2) + '\n', 'utf8');
console.log('  四态: ' + (mismatch === 0 ? 'PASS' : 'FAIL'));
process.exit(mismatch === 0 ? 0 : 1);