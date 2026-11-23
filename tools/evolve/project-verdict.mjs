#!/usr/bin/env node
/**
 * 逐项目结项判定 —— 把 31 维 × 22 家的数据收敛成「念初对每个项目是否实质超越」。
 *
 * 为什么需要：目标原话是「使念初在每个维度实质超越对方后再进入下一个项目，
 * 直到超越全部参照项目」。前面 59 轮一直在填矩阵，但从没输出过「**逐项目的结项判定**」，
 * 也就无法回答「现在能进入下一个项目了吗」。
 *
 * 判定标准（写死在这里，避免事后改口）：
 *   实质超越 = 可比维 ≥ 10  且  落后维 = 0  且  净胜 ≥ 2  且  覆盖率 ≥ 60%
 *   基本超越 = 可比维 ≥ 10  且  落后维 = 0  且  净胜 ≥ 0
 *   不及     = 存在落后维
 *   可比不足 = 可比维 < 10（样本太小，结论不可靠）
 *   不可比   = 无源码（纯 SaaS）或非实现（资料集）
 *
 * 用法：
 *   node tools/evolve/project-verdict.mjs            # 人读
 *   node tools/evolve/project-verdict.mjs --json     # 机读
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const { classifyEvidence, hasSource } = await import('./lib/evidence-provenance.mjs');

const mx = JSON.parse(readFileSync(join(ROOT, 'prototype/hermes-agents/matrix-data.json'), 'utf8'));
const allDims = [];
for (const g of mx.dimensions) for (const it of g.items) allDims.push(it);

const v = (it, sid) => (Array.isArray(it[sid]) ? it[sid][0] : null);
const score = (x) => (x === '有' ? 1 : x === '部分' ? 0.5 : 0);
const nonGoal = new Set(((mx._deliberateGaps && mx._deliberateGaps.items) || []).map((x) => String(x.dim)));
const nonImpl = new Set(((mx._nonImplementation && mx._nonImplementation.ids) || []).map(String));

const opponents = mx.subjects.filter((s) => s.id !== 'us').map((s) => s.id);

/** 判定阈值（改这里就是改标准，会写进 json 便于回溯） */
const CRIT = { minCommon: 10, minNetForReal: 2, minCoverageForReal: 60 };

const rows = [];
for (const oid of opponents) {
  const name = (mx.subjects.find((s) => s.id === oid) || {}).name || oid;

  // 不可比分类
  if (nonImpl.has(oid)) { rows.push({ opponent: oid, name, verdict: '不可比-非实现', why: '资料集，不参与实现比较' }); continue; }
  if (!hasSource(oid)) { rows.push({ opponent: oid, name, verdict: '不可比-无源码', why: '纯 SaaS/闭源，拿不到证据' }); continue; }

  const comparable = allDims.filter((it) => v(it, 'us') !== '判不了' && v(it, oid) !== '判不了' && !nonGoal.has(it.id));
  const verified = comparable.filter((it) => {
    const raw = it[oid];
    return classifyEvidence(oid, Array.isArray(raw) && raw.length > 1 ? raw[1] : '') === 'REAL';
  });

  let usS = 0, themS = 0, tie = 0;
  const lag = [], lead = [];
  for (const it of verified) {
    const a = v(it, 'us'), b = v(it, oid);
    usS += score(a); themS += score(b);
    if (score(a) > score(b)) lead.push(`${it.id}(${a}>${b})`);
    else if (score(a) < score(b)) lag.push(`${it.id}(${a}<${b})`);
    else tie++;
  }
  const net = Math.round((usS - themS) * 10) / 10;
  const coverage = comparable.length ? Math.round((verified.length / comparable.length) * 100) : 0;

  let verdict, why;
  if (lag.length > 0) { verdict = '不及'; why = `落后 ${lag.length} 维：${lag.join(' ')}`; }
  else if (verified.length < CRIT.minCommon) { verdict = '可比不足'; why = `可比维只有 ${verified.length} < ${CRIT.minCommon}`; }
  else if (net >= CRIT.minNetForReal && coverage >= CRIT.minCoverageForReal) { verdict = '实质超越'; why = `净胜 ${net}、覆盖 ${coverage}%、落后 0`; }
  else { verdict = '基本超越'; why = `净胜 ${net}、覆盖 ${coverage}%、落后 0（未达实质阈值）`; }

  rows.push({
    opponent: oid, name, verdict, why,
    commonDims: verified.length, coverage,
    usScore: Math.round(usS * 10) / 10, themScore: Math.round(themS * 10) / 10, net, tie,
    lag, lead,
  });
}

// 排序：实质超越 → 基本超越 → 可比不足 → 不及 → 不可比
const ORDER = { '实质超越': 0, '基本超越': 1, '可比不足': 2, '不及': 3, '不可比-无源码': 4, '不可比-非实现': 5 };
rows.sort((a, b) => (ORDER[a.verdict] - ORDER[b.verdict]) || ((b.net || 0) - (a.net || 0)));

const tally = rows.reduce((m, r) => { m[r.verdict] = (m[r.verdict] || 0) + 1; return m; }, {});

if (process.argv.includes('--json')) {
  const out = { at: new Date().toISOString(), criteria: CRIT, tally, rows };
  const p = join(ROOT, 'evidence/evolve/project-verdict.json');
  writeFileSync(p, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

console.log('');
console.log('  逐项目结项判定（念初 vs 每个参照项目）');
console.log('  标准：实质超越 = 可比维≥' + CRIT.minCommon + ' 且 落后维=0 且 净胜≥' + CRIT.minNetForReal + ' 且 覆盖≥' + CRIT.minCoverageForReal + '%');
console.log('  ' + '─'.repeat(96));
console.log('  对手'.padEnd(22) + '判定'.padEnd(12) + '可比  覆盖  净胜  我们  对方 | 说明');
console.log('  ' + '─'.repeat(96));
for (const r of rows) {
  if (r.verdict.startsWith('不可比')) {
    console.log('  ' + r.name.padEnd(22) + r.verdict.padEnd(12) + '—'.padEnd(20) + '| ' + r.why);
    continue;
  }
  console.log(
    '  ' + r.name.padEnd(22) + r.verdict.padEnd(12) +
    String(r.commonDims).padStart(3) + ' ' + (r.coverage + '%').padStart(5) + ' ' + String(r.net).padStart(5) +
    ' ' + String(r.usScore).padStart(5) + ' ' + String(r.themScore).padStart(5) + ' | ' + r.why.slice(0, 40)
  );
}
console.log('  ' + '─'.repeat(96));
console.log('  汇总：' + Object.entries(tally).map(([k, n]) => k + ' ' + n).join(' · '));
console.log('');
console.log('  ⚠ 判定只覆盖「对手证据可复算(REAL)」的维度。REAL 越低，判定越不可靠。');
console.log('');

// 写一份 json 供下一步使用
writeFileSync(join(ROOT, 'evidence/evolve/project-verdict.json'),
  JSON.stringify({ at: new Date().toISOString(), criteria: CRIT, tally, rows }, null, 2) + '\n', 'utf8');
