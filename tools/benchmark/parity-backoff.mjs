#!/usr/bin/env node
/**
 * 行为对照：我们的退避实现 vs openclaw 的实现
 *
 * ── 为什么这个比「数关键词」强 ─────────────────────────────
 * 之前我数「多少个文件提到 ttl/supersede」，那个数字测的是词汇密度，
 * 换分母就换答案（见第 30 轮）。**那不是对照，那是统计。**
 *
 * 这个文件做真对照：把 openclaw 的公式**逐字抄成参照实现**，
 * 用同一批输入（含边界）跑双方，**逐值比对**。
 *   · 全等 ⇒ 行为对等（有据可查）
 *   · 有差异 ⇒ 立刻知道差在哪一条输入上
 *
 * ── ⚠ 这份脚本的证据强度有限（独立复审指出，2026-11-15）──
 * 我们的 backoff.mjs 与参照实现**逐字相同**，所以「差异 0」是**构造性必然**。
 * 它证明的是「移植没走样」（回归护栏），**不是**「我们独立地做到了与 openclaw 等价」。
 * 真正支撑「与 openclaw 对等」的是**源码逐字核对**，不是这个脚本。
 *
 * ── 诚实声明 ──────────────────────────────────────────
 * 这是**借鉴**：我们的实现就是照它的语义写的（见 backoff.mjs 头注释）。
 * 所以「对等」是设计意图，不是我们的优势。
 * 它的价值在于：**把「借鉴」这件事变成了可验证的事实**，
 * 而不是一句「我们也有退避」。
 *
 * ── 参照来源 ──────────────────────────────────────────
 * openclaw-main/packages/retry/src/index.ts
 *   L106-110 computeBackoff
 *   L112-115 computeBackoffSchedule
 *   L117-121 resolveSleepDelayMs
 *   L1       MAX_TIMER_TIMEOUT_MS = 2_147_000_000
 */
import { computeBackoff, computeBackoffSchedule, resolveSleepDelayMs } from '../resilience/backoff.mjs';

// ── 参照实现：逐字抄自 openclaw，仅把 Math.random 换成注入的 rnd 以便复算 ──
const REF_MAX_TIMER_TIMEOUT_MS = 2_147_000_000;
function refComputeBackoff(policy, attempt, rnd) {
  const base = Math.min(policy.maxMs, policy.initialMs * policy.factor ** Math.max(attempt - 1, 0));
  const jitter = base * policy.jitter * rnd();
  return Math.min(policy.maxMs, Math.round(base + jitter));
}
function refComputeBackoffSchedule(scheduleMs, attempt) {
  const index = Math.min(attempt - 1, scheduleMs.length - 1);
  return attempt <= 0 ? 0 : (scheduleMs[index] ?? 0);
}
function refResolveSleepDelayMs(ms) {
  return Number.isFinite(ms) && ms > 0
    ? Math.min(Math.max(Math.floor(ms), 1), REF_MAX_TIMER_TIMEOUT_MS)
    : 0;
}

/** 跑对照，返回差异列表 */
export function parityRun(ours, ref, cases) {
  const diffs = [];
  for (const c of cases) {
    const a = ours(c);
    const b = ref(c);
    if (!Object.is(a, b)) diffs.push({ input: c, ours: a, ref: b });
  }
  return { total: cases.length, diffs, ok: diffs.length === 0 };
}

/** 生成输入空间（含边界） */
export function makeCases() {
  const policies = [
    { initialMs: 100, maxMs: 5000, factor: 2, jitter: 0 },
    { initialMs: 100, maxMs: 5000, factor: 2, jitter: 0.5 },
    { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
    { initialMs: 0, maxMs: 100, factor: 3, jitter: 1 },
    { initialMs: 250, maxMs: 60_000, factor: 1.5, jitter: 0.2 },
  ];
  const attempts = [-1, 0, 1, 2, 3, 4, 5, 10, 20, 100];
  const rnds = [0, 0.001, 0.5, 0.999, 1];
  const out = [];
  for (const p of policies) for (const a of attempts) for (const r of rnds) out.push({ p, a, r });
  return out;
}

/** 自检 —— 3 条反例（证明这个对照真能抓到差异） */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);
  const cs = makeCases();

  // ── 正例：我们的实现与参照全等 ──
  const r1 = parityRun((c) => computeBackoff(c.p, c.a, () => c.r), (c) => refComputeBackoff(c.p, c.a, () => c.r), cs);
  T('正例 · computeBackoff 与 openclaw 参照全等（' + cs.length + ' 个输入）', r1.ok,
    r1.diffs.slice(0, 2).map((d) => JSON.stringify(d)).join(' | '));

  const scheds = [[], [1000], [1000, 2000, 4000]];
  const cs2 = [];
  for (const s of scheds) for (const a of [-2, -1, 0, 1, 2, 3, 4, 99]) cs2.push({ s, a });
  const r2 = parityRun((c) => computeBackoffSchedule(c.s, c.a), (c) => refComputeBackoffSchedule(c.s, c.a), cs2);
  T('正例 · computeBackoffSchedule 与参照全等（含空表/越界）', r2.ok,
    r2.diffs.slice(0, 2).map((d) => JSON.stringify(d)).join(' | '));

  // 必须含**非整数**（1.6/2.5/10.7）—— 否则 floor 与 round 结果恰好相同，反例抓不住
  const msVals = [NaN, -1, 0, 0.4, 1, 1.6, 2.5, 10.7, 999, 1e9, 9e18, Infinity, -Infinity, 2_147_000_000, 2_147_000_001];
  const r3 = parityRun((x) => resolveSleepDelayMs(x), (x) => refResolveSleepDelayMs(x), msVals);
  T('正例 · resolveSleepDelayMs 与参照全等（含 NaN/Infinity/上限边界）', r3.ok,
    r3.diffs.slice(0, 3).map((d) => JSON.stringify(d)).join(' | '));

  // ── 反例 1（核心）：去掉 maxMs 截断 ⇒ 对照必须报差异 ──
  const noClamp = (c) => {
    const base = c.p.initialMs * c.p.factor ** Math.max(c.a - 1, 0);
    const jitter = base * c.p.jitter * c.r;
    return Math.round(base + jitter);
  };
  const r4 = parityRun(noClamp, (c) => refComputeBackoff(c.p, c.a, () => c.r), cs);
  T('反例 · 去掉 maxMs 截断 ⇒ 对照必须报差异（证明它抓得住）', r4.diffs.length > 0,
    'diffs=' + r4.diffs.length);

  // ── 反例 2：floor 写成 round ⇒ 对照必须报差异 ──
  const roundInstead = (ms) => (Number.isFinite(ms) && ms > 0
    ? Math.min(Math.max(Math.round(ms), 1), REF_MAX_TIMER_TIMEOUT_MS) : 0);
  const r5 = parityRun(roundInstead, refResolveSleepDelayMs, msVals);
  T('反例 · floor 写成 round ⇒ 对照必须报差异', r5.diffs.length > 0, 'diffs=' + r5.diffs.length);

  // ── 反例 3：去掉**越界夹取** ⇒ 对照必须报差异 ──
  // 【2026-11-15 修 · 独立复审指出标签错误】
  // 原来这条叫「attempt<=0 不返回 0」，但实测：单独删掉 `attempt <= 0 ? 0 :` 守卫后差异是 **0**
  // —— 因为负数下标返回 undefined，被 `?? 0` 兜成 0，那个分支**行为不可达**。
  // 它之所以会红，是因为 `s[a-1]` 同时去掉了越界夹取（a=99 时取 undefined→0，而参照夹到末档）。
  // 所以如实改名：它验的是「越界夹取」。
  const noClampIdx = (c) => (c.s[c.a - 1] ?? 0);
  const r6 = parityRun(noClampIdx, (c) => refComputeBackoffSchedule(c.s, c.a), cs2);
  T('反例 · 去掉越界夹取 ⇒ 对照必须报差异（a=99 应夹到末档）', r6.diffs.length > 0, 'diffs=' + r6.diffs.length);

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  行为对照（退避）· 自检（3 正例 + 3 反例）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

// 直接跑：打印对照结论
{
  const cs = makeCases();
  const r = parityRun((c) => computeBackoff(c.p, c.a, () => c.r), (c) => refComputeBackoff(c.p, c.a, () => c.r), cs);
  console.log('');
  console.log('  行为对照：我们的 backoff vs openclaw packages/retry/src/index.ts L106-121');
  console.log('  ' + '='.repeat(72));
  console.log('  computeBackoff          ' + cs.length + ' 个输入 · 差异 ' + r.diffs.length
    + (r.ok ? '  ✓ 行为对等' : '  ✗ 有差异'));
  console.log('');
  console.log('  四态: ' + (r.ok ? 'PASS' : 'FAIL') + ' —— ' + (r.ok
    ? '同一批输入下逐值全等，不是「我们也有」而是「行为一致」'
    : '有 ' + r.diffs.length + ' 处行为差异'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}
