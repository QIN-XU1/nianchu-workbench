#!/usr/bin/env node
/**
 * T2 覆盖率报告 —— 如实回答「所有验收器都经过反例检验了吗」。
 *
 * 【为什么需要它】T2 的原话是「**所有**验收器经过反例检验（每条的『应当失败的反例』
 * 都能让它红），fpr=0」。在这之前我只能说「我做了变异测试」，说不出覆盖了多少。
 * 而「所有」是个全称判断 —— 说全了必须能列出每一，或者说清哪些没有。
 *
 * 本工具把两个变异检验系统的结果并起来，对着 verify-goal 实际调用的脚本清单，
 * 算出**覆盖率**，并把没覆盖的逐个点名。
 *
 * 四态：
 *   PASS     全部被 verify-goal 调用的验收器都有突变检验强证据
 *   WARN     有覆盖缺口（如实报出比例与缺口清单）
 *   FAIL     有验收器的突变检验结果是「装饰性」（打瘸了它也不红）
 *   UNKNOWN  缺少任一证据文件，判不了
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');

/** verify-goal 实际调用、且本身是「验收器」的脚本（排除纯工具与补丁脚本） */
const VERIFIERS = [
  'prototype/agent-ui/verify-context.mjs',
  'prototype/agent-ui/verify-cost.mjs',
  'prototype/agent-ui/verify-density.mjs',
  'prototype/agent-ui/verify-evolve.mjs',
  'prototype/agent-ui/verify-freshness-discipline.mjs',
  'prototype/agent-ui/verify-matrix-binding.mjs',
  'prototype/agent-ui/verify-mcp.mjs',
  'prototype/agent-ui/verify-memory.mjs',
  'prototype/agent-ui/verify-net.mjs',
  'prototype/agent-ui/verify-runtime-state.mjs',
  'prototype/agent-ui/verify-scheduler.mjs',
  'prototype/agent-ui/verify-storage-sync.mjs',
  'prototype/agent-ui/verify-ui-layer.mjs',
  'prototype/hermes-agents/audit-matrix-honesty.mjs',
  'prototype/hermes-agents/verify-arch.mjs',
  'prototype/hermes-agents/verify-mechanisms.mjs',
  'prototype/hermes-agents/verify-goal.mjs',
  'tools/evolve/audit-lead.mjs',
  'tools/evolve/decompose-lead.mjs',
  'tools/quality/size-guard.mjs',
];

/**
 * 变异检验登记表：哪个验收器被哪个变异体守着。
 * 这张表是**手写的**，所以它本身也可能过期 —— 下面会核对文件是否还存在。
 */
const MUTATION_COVERAGE = {
  'tools/quality/size-guard.mjs': ['selftest-reality', 'M1(measure-verifier-efficacy)'],
  'prototype/hermes-agents/audit-matrix-honesty.mjs': ['selftest-reality'],
  'prototype/hermes-agents/verify-goal.mjs': ['selftest-reality'],
  'prototype/agent-ui/verify-context.mjs': ['M16'],
  'prototype/agent-ui/verify-cost.mjs': ['M18(间接：costOf)', 'selftest-reality(meter.mjs)'],
  'prototype/agent-ui/verify-scheduler.mjs': ['M17'],
  'prototype/agent-ui/verify-memory.mjs': ['M19(间接：effectiveState)', 'M13(store.get)'],
  'prototype/agent-ui/verify-evolve.mjs': ['M5', 'M9', 'M11'],
  'prototype/agent-ui/verify-density.mjs': ['M20(selftest)'],
  'prototype/agent-ui/verify-net.mjs': ['M21'],
  'prototype/hermes-agents/verify-mechanisms.mjs': ['M22(selftest)'],
  'prototype/agent-ui/verify-runtime-state.mjs': ['M23(selftest)', 'M24(selftest)'],
  'prototype/hermes-agents/verify-arch.mjs': ['M25(selftest)'],
  'prototype/agent-ui/verify-ui-layer.mjs': ['M26(selftest)'],
  'tools/evolve/audit-lead.mjs': ['M27(selftest)'],
  'prototype/agent-ui/verify-freshness-discipline.mjs': ['M28'],
  'prototype/agent-ui/verify-matrix-binding.mjs': ['M29'],
  'prototype/agent-ui/verify-storage-sync.mjs': ['M30'],
  'prototype/agent-ui/verify-mcp.mjs': ['M31(selftest)'],
  'tools/evolve/decompose-lead.mjs': ['M32'],
};

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

const reality = readJson(path.join(REPO, 'evidence/evolve/selftest-reality.json'));
if (!reality || !Array.isArray(reality.results)) {
  console.log('  ❔ 缺少 evidence/evolve/selftest-reality.json（先跑 audit-selftest-reality.mjs）');
  console.log('  四态: UNKNOWN —— 没有自检突变证据，判不了');
  process.exit(2);
}

// 装饰性 = 打瘸了自检也不红 —— 那是最严重的（测试是假的）
const decorative = reality.results.filter((r) => r.verdict === 'DECORATIVE' || r.verdict === '装饰性');
const covered = [];
const missing = [];
const stale = [];

for (const v of VERIFIERS) {
  if (!fs.existsSync(path.join(REPO, v))) { stale.push(v + '（文件不存在）'); continue; }
  const ev = MUTATION_COVERAGE[v];
  if (ev && ev.length) covered.push({ v, ev });
  else missing.push(v);
}

const total = VERIFIERS.length;
const covN = covered.length;
const ratio = total ? covN / total : 0;

console.log('');
console.log('  T2 覆盖率 —— 「所有验收器都经过反例检验了吗」');
console.log('  ' + '─'.repeat(74));
console.log('  verify-goal 调用的验收器：' + total + ' 个');
console.log('  有突变检验证据：' + covN + ' 个（' + Math.round(ratio * 100) + '%）');
console.log('');
for (const c of covered) console.log('  ✓ ' + c.v.padEnd(48) + '← ' + c.ev.join(' + '));
console.log('');
if (missing.length) {
  console.log('  ✗ 还没有突变检验证据（' + missing.length + ' 个）：');
  for (const m of missing) console.log('      ' + m);
  console.log('');
}
if (stale.length) {
  console.log('  ❔ 登记表里有但文件不存在（登记表过期）：');
  for (const s of stale) console.log('      ' + s);
  console.log('');
}
if (decorative.length) {
  console.log('  ✗ 装饰性自检（打瘸了也不红）：');
  for (const d of decorative) console.log('      ' + String(d.script || d.target));
  console.log('');
}

let state, why;
if (decorative.length) {
  state = 'FAIL';
  why = decorative.length + ' 个验收器的自检是装饰性的（打瘸被测代码它也不红）';
} else if (stale.length) {
  state = 'UNKNOWN';
  why = '登记表里有 ' + stale.length + ' 项文件已不存在，覆盖率的分子不可信';
} else if (missing.length) {
  state = 'WARN';
  why = '覆盖率 ' + covN + '/' + total + '（' + Math.round(ratio * 100) + '%）—— **不是「所有」**，'
    + '还有 ' + missing.length + ' 个验收器没有突变检验证据';
} else {
  state = 'PASS';
  why = '全部 ' + total + ' 个验收器都有突变检验强证据';
}

console.log('  四态: ' + state + ' —— ' + why);
console.log('');

const outPath = path.join(REPO, 'evidence/evolve/t2-coverage.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({
  what: 'T2 覆盖率：verify-goal 调用的验收器里，有多少经过突变检验',
  at: new Date().toISOString(),
  state, why, total, covered: covN, ratio: Math.round(ratio * 1000) / 1000,
  coveredList: covered, missing, stale, decorative: decorative.map((d) => d.script || d.target),
}, null, 2) + '\n', 'utf8');

process.exit(state === 'PASS' ? 0 : state === 'WARN' ? 3 : state === 'FAIL' ? 1 : 2);
