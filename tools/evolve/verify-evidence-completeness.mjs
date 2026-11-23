#!/usr/bin/env node
/**
 * 证据完整性验收器 —— 补 audit-matrix-honesty 漏掉的洞。
 *
 * 为什么需要它：audit-matrix-honesty 只检查「每个判定有没有证据文本」，
 * **不检查文本是否写完**。实测发现 20 个「部分」格子的证据被截断在半句话
 * （结尾是 `…】`），也就是说「为什么是部分而不是有」这个关键理由根本没写出来。
 * 那和「没有证据」等价 —— 看起来有实际是空。
 *
 * 判据（四态）：
 *   0 PASS     所有格子证据完整（以句末标点结尾，且不含截断标记）
 *   3 WARN     有格子证据可疑（短于阈值）
 *   1 FAIL     有格子证据被截断（含 `…】` 或结尾无标点）
 *   2 UNKNOWN  读不到矩阵
 *
 * 用法：node tools/evolve/verify-evidence-completeness.mjs [--json]
 */
import fs from 'node:fs';

const MATRIX = 'prototype/hermes-agents/matrix-data.json';
const TRUNC_MARK = /…】\s*$/;
const TRUNC_ANY = /（…】|…】/;
const END_PUNCT = /[。！？；：」』）)\].!?;:]\s*$/;
const MIN_LEN = 40;

let m;
try {
  m = JSON.parse(fs.readFileSync(MATRIX, 'utf8'));
} catch (e) {
  console.log('读不到矩阵：' + String(e && e.message));
  process.exit(2);
}

const items = m.dimensions.flatMap((g) => g.items || []);
const rows = [];

for (const d of items) {
  for (const [key, cell] of Object.entries(d)) {
    if (key === 'id' || key === 'name' || key === 'group') continue;
    if (!Array.isArray(cell)) continue;
    const verdict = cell[0];
    const evidence = String(cell[1] ?? '');
    if (!verdict) continue;
    // 「判不了」本来就没证据，跳过
    if (verdict === '判不了') continue;

    const problems = [];
    if (TRUNC_MARK.test(evidence) || TRUNC_ANY.test(evidence)) problems.push('截断标记');
    else if (!END_PUNCT.test(evidence)) problems.push('结尾无标点');
    if (evidence.length < MIN_LEN) problems.push('过短(' + evidence.length + ')');

    if (problems.length) rows.push({ dim: d.id, subject: key, verdict, problems, tail: evidence.slice(-60) });
  }
}

const truncated = rows.filter((r) => r.problems.includes('截断标记'));
const short = rows.filter((r) => !r.problems.includes('截断标记') && r.problems.length);
const ours = rows.filter((r) => r.subject === 'us');

const out = {
  total: items.length,
  bad: rows.length,
  truncated: truncated.length,
  oursBad: ours.length,
  oursTruncated: ours.filter((r) => r.problems.includes('截断标记')).length,
  rows,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log('证据完整性检查 · 矩阵 ' + items.length + ' 维');
  console.log('  有问题的格子: ' + rows.length + '（其中截断 ' + truncated.length + '）');
  console.log('  我们的格子里有问题: ' + ours.length + '（其中截断 ' + out.oursTruncated + '）');
  if (ours.length) {
    console.log('  我们被截断的: ' + ours.filter((r) => r.problems.includes('截断标记')).map((r) => r.dim).join(', '));
  }
}

if (truncated.length) {
  console.log('\n  判定 FAIL：有证据被截断 ⇒ 降级理由缺失 ⇒ 该格应视为 UNKNOWN，不能算「部分」');
  process.exit(1);
}
if (short.length) {
  console.log('\n  判定 WARN：有证据过短/无句末标点');
  process.exit(3);
}
console.log('\n  判定 PASS：所有格子证据完整');
process.exit(0);
