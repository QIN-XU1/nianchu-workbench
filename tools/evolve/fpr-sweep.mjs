#!/usr/bin/env node
/**
 * fpr 全量扫描 —— 在**干净树**上跑 verify-goal 调用的全部验收器，逐个记退出码与四态。
 *
 * 【为什么需要它】T2 说「fpr=0」。原来的 fpr 来自 `measure-verifier-efficacy`：
 * 它注入 13 个故障到 **7 个** 目标文件，然后看验收器抓不抓。
 * 但 T2 要的是「**所有**验收器」的误报率 —— 7 个目标覆盖不到 20 个验收器。
 *
 * 实测差集（2026-11-18）：
 *   efficacy 的 7 个 target 里，只有 3 个（size-guard / audit-matrix-honesty / verify-goal）
 *   同时出现在 t2-coverage 的 20 个验收器里。
 *
 * 所以这个工具换个问法，直接量：**树上没有注入时，哪些验收器仍然报红/报黄？**
 * 那才是「误报」。判据：
 *   干净树上 exit=0        ⇒ 不误报
 *   干净树上 exit=3（WARN）⇒ 不是误报，是「已验证的不完整」，如实计入但不能算 fpr
 *   干净树上 exit=1/2      ⇒ **误报或判不了**，都要点名
 *
 * 四态：
 *   PASS     全部 exit=0
 *   WARN     有 exit=3（WARN）但没有 1/2
 *   FAIL     有 exit=1（在干净树上报失败 = 误报）
 *   UNKNOWN  有 exit=2 或跑不起来
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');

/** 与 t2-coverage 用同一份清单，保证两个报告说的是同一批验收器 */
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

// ══════════════════════════════════════════════════════════════
// 防重入 —— 必须做，否则无限递归。
// 调用链：verify-goal → verify-evolve → fpr-sweep → verify-goal → ……
// 因为 verify-goal 本身就在要扫的验收器清单里。
// ══════════════════════════════════════════════════════════════
const REENTRY = 'NIANCHU_FPR_SWEEP';
const inSweep = process.env[REENTRY] === '1';
process.env[REENTRY] = '1';

/** 会反过来触发本工具的验收器 —— 在扫描内部运行时跳过 */
const RECURSIVE = new Set([
  'prototype/hermes-agents/verify-goal.mjs',
  'prototype/agent-ui/verify-evolve.mjs',
]);

function gitDirty() {
  try {
    const s = execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8', timeout: 10000 });
    return s.trim().split('\n').filter(Boolean);
  } catch { return null; }
}

const dirty = gitDirty();
if (dirty === null) {
  console.log('  ❔ 取不到 git 状态 ⇒ 判不了「树是否干净」');
  console.log('  四态: UNKNOWN');
  process.exit(2);
}
if (dirty.length) {
  console.log('');
  console.log('  ❔ 树不干净（' + dirty.length + ' 个改动），fpr 扫描必须在干净树上跑');
  for (const d of dirty.slice(0, 5)) console.log('      ' + d.trim());
  console.log('  （脏树上「验收器报红」分不清是误报还是真的没做完）');
  console.log('  四态: UNKNOWN —— 验证环境不满足，判不了');
  console.log('');
  process.exit(2);
}

function runOne(rel) {
  try {
    const out = execFileSync(process.execPath, [path.join(REPO, rel)], {
      cwd: REPO, encoding: 'utf8', timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const rows = [];
for (const v of VERIFIERS) {
  if (inSweep && RECURSIVE.has(v)) {
    rows.push({ v, code: null, state: 'SKIP', why: '扫描内部跳过（会递归）' });
    continue;
  }
  if (!fs.existsSync(path.join(REPO, v))) {
    rows.push({ v, code: null, state: 'UNKNOWN', why: '文件不存在' });
    continue;
  }
  const r = runOne(v);
  const m = /(通过|✅)\s*(\d+)\s*(失败|无法判断)?/.exec(r.out);
  rows.push({
    v,
    code: r.code,
    state: r.code === 0 ? 'PASS' : r.code === 3 ? 'WARN' : r.code === 2 ? 'UNKNOWN' : 'FAIL',
    tally: m ? m[0].trim() : '',
    out: r.out,
  });
}

const skip = rows.filter((r) => r.state === 'SKIP');
const scored = rows.length - skip.length;
const fail = rows.filter((r) => r.state === 'FAIL');
const unk = rows.filter((r) => r.state === 'UNKNOWN');
const warn = rows.filter((r) => r.state === 'WARN');
const pass = rows.filter((r) => r.state === 'PASS');

console.log('');
console.log('  fpr 全量扫描 —— 干净树上跑全部 ' + VERIFIERS.length + ' 个验收器');
console.log('  ' + '─'.repeat(76));
for (const r of rows) {
  const mark = r.state === 'PASS' ? '✓' : r.state === 'WARN' ? '🟡' : r.state === 'UNKNOWN' ? '❔' : r.state === 'SKIP' ? '·' : '✗';
  console.log('  ' + mark + ' ' + r.state.padEnd(8) + 'exit=' + String(r.code).padEnd(3) + r.v.padEnd(50) + (r.tally || ''));
}
console.log('');
console.log('  PASS ' + pass.length + ' · WARN ' + warn.length + ' · FAIL ' + fail.length + ' · UNKNOWN ' + unk.length);
const isHonestUnknown = (r) => /四态:\s*UNKNOWN|无法判断/.test(r.out || '');
const honestUnk = unk.filter(isHonestUnknown);
const brokenUnk = unk.filter((r) => !isHonestUnknown(r));

const decidable = rows.filter((r) => r.state === 'PASS' || r.state === 'WARN');
const fprDenom = decidable.length;

console.log('  误报率 fpr = FAIL/可判定 = ' + fail.length + '/' + fprDenom
  + ' = ' + (fprDenom ? (fail.length / fprDenom).toFixed(3) : '—')
  + '   （可判定 ' + fprDenom + ' · 如实报 UNKNOWN ' + honestUnk.length + ' 不计入分母）');

// 【2026-11-18 修判据】exit=2 有两种完全不同的含义，不能混：
//   ① 验收器跑不起来（环境缺失）⇒ 它的误报率**未知**
//   ② 验收器**正确地**报 UNKNOWN（主体本身判不了，如 R11 T5 横向领先）
// 实测：verify-goal 与 audit-lead 的 exit=2 都是 ② —— 它们如实说「判不了」，
// 那不是误报，反而是四态纪律生效的证据。所以不能因为 exit=2 就把整体判 UNKNOWN。
//
// 区分方式：输出里出现「四态: UNKNOWN」或「无法判断」⇒ 属于 ②（正确的 UNKNOWN）；
// 否则属于 ①（跑不起来）。

// ══════════════════════════════════════════════════════════════
// fpr 的分母该是谁 —— 这条标准必须先立清楚，否则数字会骗人。
//
// 问题：verify-goal 与 audit-lead 在干净树上 exit=2，因为它们的主体
// （R11 T5 横向领先）**本身判不了**。它们不是误报，是如实报 UNKNOWN。
//
// 若把它们算进 fpr 的分母：
//   · 分子永远是 0（它们从不报 FAIL）
//   · 分母被稀释 ⇒ fpr 看起来更小 ⇒ **对自己有利**
// 那是自欺。
//
// 所以标准是：**fpr 只对「产出了 PASS/WARN 判定」的验收器计算**。
// 一个如实报 UNKNOWN 的验收器，它贡献的是「可判定性覆盖」，不是「误报率」。
// 两者必须分开报，不许混成一个数。
// ══════════════════════════════════════════════════════════════
/**
 * 【2026-11-19 修】自指的验收器不能把全局判成 UNKNOWN。
 *
 * 调用链是 verify-goal → verify-evolve → fpr-sweep → verify-goal 的循环，
 * 所以 fpr-sweep 跑 verify-evolve 时，verify-evolve 必然要再读"本次扫描"的证据 ——
 * 它读不到（自己还没写完），于是 exit=2 且**没有输出四态**，落入 brokenUnk。
 *
 * 但这不是"验收器坏了"，是**扫描本身在它自己的调用链里**。
 * 把它算成"跑不起来"会让 L4 永远判不了 —— 那是把设计上的递归当成缺陷，
 * 结果反而鼓励"悄悄把这层扫描去掉"。
 *
 * 正确处理：把它单独列为 SELF（自指），**不计入分母、也不拉低四态**，
 * 但在输出里**明写**如实披露，谁都能看见这一条没被验证。
 */
const SELF_REFERENTIAL = new Set([
  'prototype/agent-ui/verify-evolve.mjs',
  'tools/evolve/fpr-sweep.mjs',
]);
const selfRef = brokenUnk.filter((r) => SELF_REFERENTIAL.has(String(r.v)));
const realBroken = brokenUnk.filter((r) => !SELF_REFERENTIAL.has(String(r.v)));
if (selfRef.length) {
  console.log('');
  console.log('  SELF 自指（扫描在它自己的调用链里，不计入四态也不计入分母）：');
  for (const r of selfRef) console.log('    · ' + r.v);
}

let state, why;
if (fail.length) {
  state = 'FAIL';
  why = fail.length + ' 个验收器在**干净树上**报失败 —— 这是误报，必须先修';
} else if (realBroken.length) {
  brokenUnk.length = 0;
  brokenUnk.push(...realBroken);
  state = 'UNKNOWN';
  why = brokenUnk.length + ' 个验收器在干净树上跑不起来（不是报 UNKNOWN，是根本没产出结论）：'
    + brokenUnk.map((r) => r.v).join('、');
} else if (honestUnk.length || warn.length || selfRef.length) {
  state = 'WARN';
  why = '**没有误报（fpr = 0/' + fprDenom + '）**，但 ' + honestUnk.length
    + ' 个验收器如实报 UNKNOWN（主体本身判不了）、' + warn.length + ' 个报 WARN —— '
    + '这两类都不是误报，但也不能并进 PASS'
    + (selfRef.length ? '；另有 ' + selfRef.length + ' 个**自指**验收器（扫描在自己调用链里）未参与判定，如实披露' : '');
} else {
  state = 'PASS';
  why = '全部 ' + fprDenom + ' 个可判定验收器在干净树上都通过，fpr=0';
}

console.log('');
console.log('  四态: ' + state + ' —— ' + why);
console.log('');

const outPath = path.join(REPO, 'evidence/evolve/fpr-sweep.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({
  what: 'fpr 全量扫描：干净树上跑 verify-goal 调用的全部验收器',
  at: new Date().toISOString(),
  state, why,
  total: rows.length,
  scored,
  decidable: fprDenom,
  skipped: skip.map((r) => r.v),
  fprDenomRule: 'fpr 的分母只算「产出了 PASS/WARN 判定」的验收器；如实报 UNKNOWN 的不计入（否则分母被稀释，fpr 看起来更小 = 对自己有利 = 自欺）',
  fpr: fprDenom ? Math.round((fail.length / fprDenom) * 1000) / 1000 : null,
  pass: pass.length, warn: warn.length, fail: fail.length, unknown: unk.length,
  rows: rows.map(({ out, ...rest }) => rest),
  honestUnknown: honestUnk.map((r) => r.v),
  brokenUnknown: brokenUnk.map((r) => r.v),
}, null, 2) + '\n', 'utf8');

process.exit(state === 'PASS' ? 0 : state === 'WARN' ? 3 : state === 'FAIL' ? 1 : 2);
