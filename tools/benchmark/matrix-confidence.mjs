#!/usr/bin/env node
/**
 * 矩阵可信度分解 —— 把「我们领先」这句话拆成能证明和不能证明的两半
 *
 * ── 为什么需要它 ────────────────────────────────────────
 * T5 说「31 维矩阵上我们的覆盖率高于全部参照系统，每格有自己实现或如实标注借力，无假绿」。
 *
 * 这句话其实是**两个不同的主张**拼在一起：
 *   主张 A：「我们有 X」        —— 我们这格的证据是可解析的本地路径 ⇒ **可核验**
 *   主张 B：「他们没有 X」      —— 对手那格的证据是 prose ⇒ **不可核验**
 *
 * 只要把 A 和 B 分开看，就会发现「领先」这个词是**从 B 推出来的**，
 * 而 B 恰恰是唯一不可核验的一半。
 *
 * ── 这个脚本怎么分（三态，逐维给）──────────────────────
 *   both   我们这格可核验 + 至少一个对手这格也可核验 ⇒ 这一维的对比**可以下结论**
 *   ours   只有我们这格可核验，对手全是 prose        ⇒ 只能证明「我们有」
 *   none   两边都不可核验                            ⇒ 这一维**什么都不能说**
 *
 * ── 输入 ──────────────────────────────────────────────
 * evidence/evolve/evidence-grade.json（由 evidence-grade.mjs 生成）
 *
 * 用法：node tools/benchmark/matrix-confidence.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(REPO, 'evidence/evolve/evidence-grade.json');

/**
 * 判定一维的可信度等级
 * @param row evidence-grade 的 rows[i]  { id, name, cells: { us:{verified}, chatgpt:{verified,state}, ... } }
 */
export function gradeDim(row) {
  const cells = row.cells || {};
  const ours = cells.us;
  const others = Object.entries(cells).filter(([k]) => k !== 'us');

  const oursOk = !!(ours && ours.verified);
  const othersHave = others.filter(([, v]) => v && v.state === '有');
  const othersOk = othersHave.filter(([, v]) => v && v.verified);

  // 【2026-11-15 收紧】原来「双方都可核验」就算 both，但实测 4 维里
  // 我们的证据是**可运行文件路径**，对手的是**官方文档 URL** —— 不是同一种证据。
  //   path 证明「我们有这段代码」
  //   url  证明「文档写了这个功能」
  // 两者不能直接比出「谁更强」。所以 both 必须**双方证据同类**才算可比。
  const sameKind = oursOk
    ? othersOk.filter(([, v]) => v.kind === ours.kind)
    : [];

  if (oursOk && sameKind.length > 0) {
    return {
      level: 'both', oursOk, othersOk: othersOk.length, othersHave: othersHave.length,
      sameKind: sameKind.length, ourKind: ours.kind,
    };
  }
  if (oursOk && othersOk.length > 0) {
    // 双方都能核验，但**证据种类不同** ⇒ 仍不可比
    return {
      level: 'mixed', oursOk, othersOk: othersOk.length, othersHave: othersHave.length,
      sameKind: 0, ourKind: ours.kind,
      theirKinds: [...new Set(othersOk.map(([, v]) => v.kind))],
    };
  }
  if (oursOk) {
    return { level: 'ours', oursOk, othersOk: 0, othersHave: othersHave.length, sameKind: 0 };
  }
  return { level: 'none', oursOk, othersOk: othersOk.length, othersHave: othersHave.length, sameKind: 0 };
}

/** 汇总 */
export function summarize(rows) {
  const out = { both: [], mixed: [], ours: [], none: [] };
  for (const r of rows) {
    const g = gradeDim(r);
    out[g.level].push({ ...r, g });
  }
  return {
    ...out,
    total: rows.length,
    pct: {
      both: rows.length ? Math.round((out.both.length / rows.length) * 100) : 0,
      mixed: rows.length ? Math.round((out.mixed.length / rows.length) * 100) : 0,
      ours: rows.length ? Math.round((out.ours.length / rows.length) * 100) : 0,
      none: rows.length ? Math.round((out.none.length / rows.length) * 100) : 0,
    },
  };
}

/** 自检 —— 4 条反例 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  T('反例 · 我们可核验 + 对手也可核验 ⇒ both',
    gradeDim({ id: 'x', cells: { us: { verified: true }, a: { state: '有', verified: true } } }).level === 'both', '');
  T('反例 · 只有我们可核验 ⇒ ours（不许升成 both）',
    gradeDim({ id: 'x', cells: { us: { verified: true }, a: { state: '有', verified: false } } }).level === 'ours', '');
  // 2026-11-15 收紧后新增：双方都能核验但证据种类不同 => mixed，不许算 both
  T('反例 · 我们=path 对手=url（都能核验但不同类）⇒ mixed（不许当 both）',
    gradeDim({ id: 'x', cells: { us: { verified: true, kind: 'path' }, a: { state: '有', verified: true, kind: 'url' } } }).level === 'mixed',
    JSON.stringify(gradeDim({ id: 'x', cells: { us: { verified: true, kind: 'path' }, a: { state: '有', verified: true, kind: 'url' } } }).level));
  T('正例 · 双方都是 path ⇒ both',
    gradeDim({ id: 'x', cells: { us: { verified: true, kind: 'path' }, a: { state: '有', verified: true, kind: 'path' } } }).level === 'both', '');
  T('反例 · 两边都不可核验 ⇒ none（不许当 ours）',
    gradeDim({ id: 'x', cells: { us: { verified: false }, a: { state: '有', verified: false } } }).level === 'none', '');
  T('反例 · 我们这格缺失 ⇒ 不许算 ours',
    gradeDim({ id: 'x', cells: { a: { state: '有', verified: true } } }).level === 'none', '');

  const s = summarize([
    { id: 'a', cells: { us: { verified: true }, x: { state: '有', verified: true } } },
    { id: 'b', cells: { us: { verified: true }, x: { state: '有', verified: false } } },
    { id: 'c', cells: { us: { verified: false }, x: { state: '有', verified: false } } },
  ]);
  T('正例 · 三档计数正确', s.both.length === 1 && s.ours.length === 1 && s.none.length === 1,
    JSON.stringify({ both: s.both.length, ours: s.ours.length, none: s.none.length }));

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  矩阵可信度分解 · 自检（1 正例 + 4 反例）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

if (!fs.existsSync(SRC)) {
  console.log('  ❔ 缺 evidence/evolve/evidence-grade.json —— 先跑 node tools/benchmark/evidence-grade.mjs');
  process.exit(2);
}
const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const rows = data.rows || [];
const s = summarize(rows);

const LABEL = {
  both: '双方可核验**且证据同类** —— 这一维的对比能下结论',
  mixed: '双方都能核验但**证据种类不同**（我们=文件路径，对手=文档 URL）—— 仍不可比',
  ours: '只有我们能核验 —— 只能证明「我们有」，不能证明「他们没有」',
  none: '两边都不可核验 —— 这一维什么都不能说',
};

console.log('');
console.log('  矩阵可信度分解 —— 把「我们领先」拆成能证明的与不能证明的');
console.log('  ' + '='.repeat(80));
for (const k of ['both', 'mixed', 'ours', 'none']) {
  const arr = s[k];
  console.log('');
  console.log('  ' + arr.length + '/' + s.total + ' 维（' + s.pct[k] + '%）  ' + LABEL[k]);
  if (arr.length) {
    const names = arr.map((r) => r.id + ' ' + String(r.name).slice(0, 12)).slice(0, 8);
    console.log('    ' + names.join(' · ') + (arr.length > 8 ? ' …' : ''));
  }
}
console.log('');
console.log('  ' + '─'.repeat(80));
console.log('  结论：「T5 领先」这个主张的可核验部分是 ' + s.pct.both + '%，');
console.log('        另有 ' + s.pct.ours + '% 只能证明我们这边，' + s.pct.none + '% 什么都不能说。');
console.log('');
const op = path.join(REPO, 'evidence/evolve/matrix-confidence.json');
fs.writeFileSync(op, JSON.stringify({
  at: new Date().toISOString(),
  total: s.total, pct: s.pct,
  both: s.both.map((r) => ({ id: r.id, name: r.name })),
  mixed: s.mixed.map((r) => ({ id: r.id, name: r.name })),
  ours: s.ours.map((r) => ({ id: r.id, name: r.name })),
  none: s.none.map((r) => ({ id: r.id, name: r.name })),
}, null, 2) + '\n', 'utf8');
console.log('  → ' + path.relative(REPO, op));
console.log('');
