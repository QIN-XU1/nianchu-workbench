#!/usr/bin/env node
/**
 * 退避/重试延迟 —— 我们的实现
 *
 * ── 为什么有这个文件 ────────────────────────────────────
 * 原先我们没有成形的退避策略：重试要么立刻重来，要么写死 sleep。
 * 这在真实世界里是**会打垮下游**的：没有指数退避 + 上限 + 抖动，
 * 一次上游抖动会引来一群同时重试的客户端（惊群）。
 *
 * ── 与 openclaw 的关系（如实标注）──
 * 语义对齐 openclaw `packages/retry/src/index.ts` L106-121 的
 * computeBackoff / computeBackoffSchedule / resolveSleepDelayMs。
 * 这是**借鉴**，不是自创 —— 但行为是否真的一致，不靠说，靠
 * tools/benchmark/parity-backoff.mjs 跑出来。
 *
 * 唯一的差异（也是改进）：jitter 的随机源可注入，
 * 这样对照测试与回归都能**复算**（Math.random 直接调用是不可复算的）。
 */
const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;

/**
 * 指数退避 + 上限 + 抖动
 *
 * @param policy {initialMs, maxMs, factor, jitter}
 * @param attempt 第几次重试（1 起）
 * @param rnd 随机源（0..1］，默认 Math.random —— 注入固定值即可复算）
 */
export function computeBackoff(policy, attempt, rnd = Math.random) {
  const base = Math.min(policy.maxMs, policy.initialMs * policy.factor ** Math.max(attempt - 1, 0));
  const jitter = base * policy.jitter * rnd();
  return Math.min(policy.maxMs, Math.round(base + jitter));
}

/** 固定档位表退避 */
export function computeBackoffSchedule(scheduleMs, attempt) {
  const index = Math.min(attempt - 1, scheduleMs.length - 1);
  return attempt <= 0 ? 0 : (scheduleMs[index] ?? 0);
}

/** 把任意 ms 收敛到合法定时器范围（NaN/负数 → 0；过大 → 上限） */
export function resolveSleepDelayMs(ms) {
  return Number.isFinite(ms) && ms > 0
    ? Math.min(Math.max(Math.floor(ms), 1), MAX_TIMER_TIMEOUT_MS)
    : 0;
}

/** 自检 —— 4 条反例（钉住最容易写错的地方） */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  // ── 正例：必须算出**精确的期望值**，不只是「不超上限」──────────────
  // 为什么需要它：如果 computeBackoff 永远返回 0 或永远返回 maxMs，
  // 「不许无限增长」「不许超过上限」这类反例都会通过。
  // 必须显式断言它确实按指数增长，且截断后等于上限本身。
  const pol = { initialMs: 100, factor: 2, maxMs: 5000, jitter: 0 };
  T('正例 · 指数退避（jitter=0 时可取精确值）：第1次=100、第2次=200、第3次=400',
    computeBackoff(pol, 1, () => 0.5) === 100
    && computeBackoff(pol, 2, () => 0.5) === 200
    && computeBackoff(pol, 3, () => 0.5) === 400,
    [1, 2, 3].map((n) => computeBackoff(pol, n, () => 0.5)).join(','));

  T('正例 · 超过 maxMs 时必须**正好等于** maxMs（不是小于它）',
    computeBackoff(pol, 20, () => 0.5) === 5000,
    String(computeBackoff(pol, 20, () => 0.5)));

  T('正例 · 档位表：attempt=1 取第一档、attempt=2 取第二档（精确值）',
    computeBackoffSchedule([100, 300, 700], 1) === 100
    && computeBackoffSchedule([100, 300, 700], 2) === 300,
    [1, 2].map((n) => computeBackoffSchedule([100, 300, 700], n)).join(','));

  T('正例 · resolveSleepDelayMs 对合法输入原样返回',
    resolveSleepDelayMs(250) === 250, String(resolveSleepDelayMs(250)));
  const P = { initialMs: 100, maxMs: 5000, factor: 2, jitter: 0 };  // jitter=0 便于确定性判断

  // ── 反例 1：指数增长必须真的翻倍 ──
  T('反例 · 第1次100、第2次200、第3次400（指数增长）',
    computeBackoff(P, 1, () => 0) === 100 && computeBackoff(P, 2, () => 0) === 200 && computeBackoff(P, 3, () => 0) === 400,
    JSON.stringify([1, 2, 3].map((a) => computeBackoff(P, a, () => 0))));

  // ── 反例 2（核心）：必须被 maxMs 截住，不许无限增长 ──
  const big = computeBackoff(P, 20, () => 0);
  T('反例 · 第20次必须被 maxMs=5000 截住（不许无限增长）', big === 5000, 'got ' + big);

  // ── 反例 3：resolveSleepDelayMs 必须收敛非法值 ──
  T('反例 · NaN/负数/0 → 0；0.4 → 1；超大 → 上限',
    resolveSleepDelayMs(NaN) === 0 && resolveSleepDelayMs(-5) === 0
    && resolveSleepDelayMs(0) === 0 && resolveSleepDelayMs(0.4) === 1
    && resolveSleepDelayMs(9e18) === MAX_TIMER_TIMEOUT_MS,
    JSON.stringify([NaN, -5, 0, 0.4, 9e18].map(resolveSleepDelayMs)));

  // ── 反例 4：档位表越界必须夹到最后一档，attempt<=0 必须是 0 ──
  const sched = [1000, 2000, 4000];
  T('反例 · 档位表 attempt 越界夹到最后一档，attempt<=0 返回 0',
    computeBackoffSchedule(sched, 0) === 0 && computeBackoffSchedule(sched, 1) === 1000
    && computeBackoffSchedule(sched, 3) === 4000 && computeBackoffSchedule(sched, 99) === 4000,
    JSON.stringify([0, 1, 3, 99].map((a) => computeBackoffSchedule(sched, a))));

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

// 必须精确到文件名 —— 用 endsWith 会把 parity-backoff.mjs 也匹配上，导入时就跑 CLI 并 exit
const isMain = process.argv[1] && /[\\\\/]backoff\.mjs$/.test(process.argv[1]);
if (isMain) {
  if (process.argv.includes('--selftest')) {
    const r = selfTest();
    console.log('');
    console.log('  退避策略 · 自检（4 反例）');
    console.log('  ' + '─'.repeat(70));
    console.log(r.lines);
    console.log('');
    console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
    console.log('');
    process.exit(r.ok ? 0 : 1);
  }
}
