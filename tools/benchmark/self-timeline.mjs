#!/usr/bin/env node
/**
 * 我们自己的迭代画像 —— 用**和竞品完全相同的分类器与口径**
 *
 * ── 为什么要用同一个分类器 ──────────────────────────────
 * 如果对竞品用一套标准、对自己用另一套，那对比就是自欺。
 * 这里直接 import repo-timeline 的 classify()，保证口径一致。
 *
 * ── 口径声明（必须和竞品一致，否则不可比）──
 *   · 竞品：默认分支最近 100 条提交（GitHub API 单页上限）
 *   · 我们：最近 100 条提交（git log -100）—— **同样取最近 100 条**
 *   · 分类：conventional commit 前缀优先，否则关键词，认不出归 other
 *
 * 用法：node tools/benchmark/self-timeline.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { classify } from './repo-timeline.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const N = 100;   // 与竞品同口径

function ourCommits(n = N) {
  const raw = execFileSync('git', [
    '--no-pager', 'log', '--pretty=format:%ad|%s', '--date=short', '-' + n,
  ], { cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return raw.split('\n').filter(Boolean).map((l) => {
    const i = l.indexOf('|');
    return { date: l.slice(0, i), message: l.slice(i + 1) };
  });
}

export function summarizeOurs(rows) {
  const byKind = {};
  const byMonth = {};
  for (const r of rows) {
    const k = classify(r.message);
    byKind[k] = (byKind[k] || 0) + 1;
    const m = (r.date || '').slice(0, 7);
    if (m) byMonth[m] = (byMonth[m] || 0) + 1;
  }
  const dates = rows.map((r) => r.date).filter(Boolean).sort();
  return {
    count: rows.length,
    first: dates[0] || null,
    last: dates[dates.length - 1] || null,
    byKind, byMonth,
    recent: rows.slice(0, 6).map((r) => ({ date: r.date, message: r.message, kind: classify(r.message) })),
  };
}

const KINDS = ['fix', 'feat', 'refactor', 'docs', 'test', 'chore', 'other'];

function pct(n, tot) {
  return tot ? Math.round((n / tot) * 100) : 0;
}

const ours = summarizeOurs(ourCommits(N));

// 读竞品数据（repo-timeline.json），同样只取各自前 100 条
let theirs = [];
try {
  const j = JSON.parse(fs.readFileSync(path.join(REPO, 'evidence/evolve/repo-timeline.json'), 'utf8'));
  theirs = (j.repos || []).filter((r) => r.summary);
} catch { theirs = []; }

console.log('');
console.log('  迭代画像对比 —— 同一分类器、同一「最近 100 条」口径');
console.log('  ' + '='.repeat(80));
console.log('  ' + '主体'.padEnd(18) + '提交  跨度  ' + KINDS.map((k) => k.padStart(9)).join(''));
console.log('  ' + '-'.repeat(80));

function row(label, count, span, byKind) {
  const cells = KINDS.map((k) => (pct(byKind[k] || 0, count) + '%').padStart(9)).join('');
  console.log('  ' + label.padEnd(18) + String(count).padStart(4) + String(span).padStart(6) + '  ' + cells);
}

row('我们（念初）', ours.count, (ours.first && ours.last)
  ? Math.round((Date.parse(ours.last) - Date.parse(ours.first)) / 86400000) + 'd' : '?', ours.byKind);
for (const r of theirs) {
  row(r.label, r.summary.count, r.summary.spanDays + 'd', r.summary.byKind);
}
console.log('  ' + '-'.repeat(80));
console.log('  注：竞品「跨度 0d」是 100 条截断假象，不代表它一天干完所有活。');
console.log('      竞品 other 占比高 = 它不用 conventional commits，不是分类错。');
console.log('');

// ── 我们自己的三处值得注意的地方（只报事实，不下「好不好」的结论）──
const t = ours.count;
const facts = [
  ['other 占比', pct(ours.byKind.other || 0, t) + '%',
    '提交信息机器读不懂 ⇒ 历史无法一眼审计'],
  ['test 占比', pct(ours.byKind.test || 0, t) + '%',
    'craft-anything 12% · omp-studio 8% · ECC 7%'],
  ['refactor 占比', pct(ours.byKind.refactor || 0, t) + '%',
    'omp-studio 19% · openclaw 10%'],
];
console.log('  我们自己的三个数字（只报事实，不判好坏）：');
for (const [k, v, note] of facts) console.log('    ' + k.padEnd(14) + v.padStart(5) + '   ' + note);
console.log('');
console.log('  最近 6 条提交（看分类是否合理）：');
for (const r of ours.recent) {
  console.log('    ' + r.date + '  [' + r.kind.padEnd(8) + ']  ' + r.message.slice(0, 58));
}
console.log('');
