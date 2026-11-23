#!/usr/bin/env node
/**
 * 公平比较：只在「双方都可核验」的维度上比。
 *
 * 为什么需要：我们能完整看自己（0 个判不了），别人只能通过拆解报告看（大量判不了）。
 * 直接比「有」的个数，等于拿放大镜看自己、拿望远镜看别人 —— 不公平。
 *
 * 公平口径：对每个对手，只取「我们不是判不了 且 对手不是判不了」的维度，
 * 在这些维度上数各自有几个「有」。再算净胜。
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

const opponents = mx.subjects.filter((s) => s.id !== 'us').map((s) => s.id);

/**
 * ══ 非目标维度不计入输赢（2026-11-19）═══════════════════════════
 *
 * 矩阵里 `_deliberateGaps` 早就声明了「这些『无』是明确不做的，不是漏做」，
 * 但本脚本**从来没读过它** —— 结果是已声明的非目标（如 A10 IM 多通道）
 * 照样在扣我们的分。这不是"能力差距"，是**口径错**。
 *
 * 正确做法不是偷偷改分，而是：
 *   · 显式排除 _deliberateGaps 里声明过的维度；
 *   · **把它报出来**（excludedNonGoal），让人看得见排除了什么、为什么；
 *   · 只排除**声明过**的维度，没声明的一律照算（防止用"非目标"当挡箭牌）。
 */
const nonGoal = new Set(
  ((mx._deliberateGaps && mx._deliberateGaps.items) || []).map((x) => String(x.dim)),
);
const nonGoalWhy = new Map(
  ((mx._deliberateGaps && mx._deliberateGaps.items) || []).map((x) => [String(x.dim), String(x.why || '')]),
);

const rows = opponents.map((oid) => {
  /**
   * ══ 硬约束（2026-11-19）：只在**对方证据可复算**的维度上比 ══
   *
   * 之前只要「双方都不是判不了」就算可比 —— 但实测对手侧 95% 的证据是我们自己的分析文档。
   * 那种「可比」是假的可比。现在要求对方那一格能指到对方仓库里真实存在的文件。
   * 达不到的维度**不进分母、不判输赢**，单独计数为 coverageGap，公开报出。
   *
   * ══ 2026-11-20 修正（第 127 轮）══════════════════════════════════
   * 加入 MIXED 分类后，这里**必须同时接受 REAL 与 MIXED**。
   * 否则会出严重 bug：A12 因为证据里混了我方文档变成 MIXED，
   * 就从「可比」里掉出去 → ecc/openclaw/hermes 突然变成「零落后」。
   * 那不是我们变强了，是**比较集缩小了**。这种"改善"是假的。
   *
   * MIXED 的含义是「有对方真实路径，但也引了我方分析」——它仍然可复算到对方源码，
   * 只是不够纯。所以它**可以参与比较**，但要在输出里标注「该维证据是半硬的」。
   */
  const comparable = allDims.filter((it) => v(it, 'us') !== '判不了' && v(it, oid) !== '判不了');
  const excluded = comparable.filter((it) => nonGoal.has(it.id));
  const notNonGoal = comparable.filter((it) => !nonGoal.has(it.id));
  const verifiedByOpp = notNonGoal.filter((it) => {
    const raw = it[oid];
    const ev = Array.isArray(raw) && raw.length > 1 ? raw[1] : '';
    const st = classifyEvidence(oid, ev);
    return st === 'REAL' || st === 'MIXED';
  });
  const mixedDims = verifiedByOpp.filter((it) => {
    const raw = it[oid];
    const ev = Array.isArray(raw) && raw.length > 1 ? raw[1] : '';
    return classifyEvidence(oid, ev) === 'MIXED';
  }).map((it) => it.id);
  const coverageGap = notNonGoal.filter((it) => !verifiedByOpp.includes(it));
  const common = verifiedByOpp;
  let usS = 0, themS = 0, usWin = 0, themWin = 0, tie = 0;
  const usOnly = [], themOnly = [];
  for (const it of common) {
    const a = v(it, 'us'), b = v(it, oid);
    usS += score(a); themS += score(b);
    if (score(a) > score(b)) { usWin++; usOnly.push(it.id + '(' + a + '>' + b + ')'); }
    else if (score(a) < score(b)) { themWin++; themOnly.push(it.id + '(' + a + '<' + b + ')'); }
    else tie++;
  }
  const name = (mx.subjects.find((s) => s.id === oid) || {}).name || oid;
  return {
    opponent: oid,
    name,
    commonDims: common.length,
    usScore: Math.round(usS * 10) / 10,
    themScore: Math.round(themS * 10) / 10,
    delta: Math.round((usS - themS) * 10) / 10,
    usWin, themWin, tie,
    usOnly, themOnly,
    // 被排除的非目标维度（可见，不是静默丢弃）
    excludedNonGoal: excluded.map((it) => it.id + '(' + String(it.name) + ')'),
    // 因**对方证据不可复算**而未参与比较的维度（可见）
    coverageGap: coverageGap.map((it) => it.id),
    hasSource: hasSource(oid),
  };
});

rows.sort((a, b) => b.delta - a.delta);

console.log('  公平比较（只在双方都可核验的维度上）：');
console.log('  ' + '对手'.padEnd(22) + '可比/31'.padStart(9) + '覆盖'.padStart(7) + '我们分'.padStart(8) + '对方分'.padStart(8) + '净胜'.padStart(7) + '我们赢'.padStart(7) + '对方赢'.padStart(7) + '平'.padStart(5));
for (const r of rows) {
  const cov = Math.round((r.commonDims / allDims.length) * 100);
  console.log('  ' + r.opponent.padEnd(22) + (r.commonDims + '/' + allDims.length).padStart(9) + (cov + '%').padStart(7) + String(r.usScore).padStart(8) + String(r.themScore).padStart(8) + String(r.delta).padStart(7) + String(r.usWin).padStart(7) + String(r.themWin).padStart(7) + String(r.tie).padStart(5));
}

const ahead = rows.filter((r) => r.commonDims > 0 && r.delta > 0);
const behind = rows.filter((r) => r.commonDims > 0 && r.delta < 0);
    const tied = rows.filter((r) => r.commonDims > 0 && r.delta === 0);
    const incomparable = rows.filter((r) => r.commonDims === 0);
console.log('');
console.log('  ★可比对手：净胜为正 ' + ahead.length + ' / 净负 ' + behind.length + ' / 净平 ' + tied.length);
/**
 * ★2026-11-21 加：区分「净胜为正」与「一维都没落后」。
 *
 * 原来只说「领先 14 / 落后 0」，但表格里明明有 `对方赢` 列 —— 因为原来按**净分**算，
 * 只要总分领先就叫「领先」，哪怕有 2 个维度被对方赢。这会让人误读成「全面压制」。
 * 现在额外报出「零落后」的家数，才是「每个维度都实质超过」的严格口径。
 */
const zeroLag = ahead.filter((r) => (r.themWin || 0) === 0);
const someLag = ahead.filter((r) => (r.themWin || 0) > 0);
console.log('    其中【零落后】（严格每维不输）: ' + zeroLag.length + ' 家；【有维度落后】: ' + someLag.length + ' 家');
if (someLag.length) {
  console.log('    有维度落后的净胜方：' + someLag.map((r) => r.opponent + '(输' + r.themWin + '维)').join(' · '));
}
const noSrc = incomparable.filter((r) => !r.hasSource);
const unverified = incomparable.filter((r) => r.hasSource);
console.log('  ★不可比-A 无源码（纯 SaaS/闭源，拿不到证据）：' + noSrc.length + ' 个 → ' + noSrc.map((r) => r.opponent).join(' · '));
const nonImpl = new Set((mx._nonImplementation && mx._nonImplementation.ids) || []);
const unverifiedImpl = unverified.filter((r) => !nonImpl.has(r.opponent));
const nonImplementation = unverified.filter((r) => nonImpl.has(r.opponent));
console.log('  ★不可比-B1 有实现但证据未复算（待办）：' + unverifiedImpl.length + ' 个 → ' + unverifiedImpl.map((r) => r.opponent).join(' · '));
console.log('  ★不可比-B2 非实现（资料集，不参与实现比较）：' + nonImplementation.length + ' 个 → ' + nonImplementation.map((r) => r.opponent).join(' · '));
console.log('  平均净胜 ' + (Math.round(rows.reduce((a, r) => a + r.delta, 0) / rows.length * 10) / 10));

/**
 * ══ 证据溯源警告（2026-11-19）═══════════════════════════════
 * 「领先 N 个」是建立在对手侧证据之上的。而 audit-evidence-provenance 实测：
 * 692 格对手证据里只有 30 格（4.3%）能复算到对方仓库真实路径，其余是**我们自己的分析文档**。
 * 所以这个结论只能读作「暂定」，不能当已核实。不打印这句，就是在误导读者。
 */
{
  const prov = mx._evidenceProvenance;
  if (prov && prov.pctReal < 100) {
    console.log('');
    console.log('  ⚠ 证据溯源：对手侧证据仅 ' + prov.pctReal + '% 可复算到对方源码（'
      + prov.real + '/' + prov.totalCells + '），其余 ' + prov.own + ' 格是**我们自己的分析文档**。');
    console.log('     → 上面的「领先/落后」只能读作**暂定结论**，不是已核实。');
    console.log('     → 复核工具：node tools/evolve/audit-evidence-provenance.mjs');
  }
}

/**
 * 把「排除了哪些非目标维度、为什么」打到台面上。
 * 不打印的话，排除就成了隐形加分 —— 那就和"偷偷改分"没区别。
 */
if (nonGoal.size > 0) {
  console.log('');
  console.log('  已排除的非目标维度（不计入输赢，但**不代表没差距**）：');
  for (const d of nonGoal) console.log('    · ' + d + ' — ' + (nonGoalWhy.get(d) || '（未写原因）'));
}

const out = {
  _what: '公平比较：只在双方都可核验（非判不了）的维度上，按 有=1 / 部分=0.5 / 无=0 计分',
  at: new Date().toISOString(),
  subjects: mx.subjects.length,
  opponents: rows.length,
  ahead: ahead.length,
      incomparable: incomparable.length,
  behind: behind.length,
  avgDelta: Math.round(rows.reduce((a, r) => a + r.delta, 0) / rows.length * 10) / 10,
  // 被排除的非目标维度（顶层可见，避免「排除」变成隐形加分）
  excludedNonGoal: [...nonGoal],
  rows,
};
writeFileSync(join(ROOT, 'evidence/evolve/matrix-fair-compare.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log('  ✓ 写出 evidence/evolve/matrix-fair-compare.json');
