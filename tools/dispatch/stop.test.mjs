#!/usr/bin/env node
/**
 * 停止条件族（C2）的反例测试。
 *
 * 纪律：**每条刹车必须同时证明「该停时停」和「不该停时不停」**。
 * 只测「该停时停」是假检查 —— 一个永远 return stop 的实现也能全过。
 *
 * 另有 3 条「判不了就说判不了」：缺时钟 / stopHook 抛错 / 无状态。
 */
import { createStopPolicy, evaluateStop, detectLoop, TERMINAL } from './stop.mjs';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  ← ' + detail : '')); }
};

const P = createStopPolicy();
const NOW = 1_800_000_000_000;
const base = () => ({
  now: NOW,
  startedAt: NOW - 1000,
  lastActivityAt: NOW - 1000,
  turnCount: 1,
  history: [],
  consecutiveFailures: 0,
  turnCompleted: false,
});

const r = (over = {}, hooks = {}) => evaluateStop({ ...base(), ...over }, P, hooks);

// ── 0. 基线：什么都不该触发 ──
{
  const x = r();
  t('★反例：干净状态必须「继续」（防止实现变成永远 stop）', x.action === 'continue', JSON.stringify(x));
}

// ── 1. 轮数 ──
{
  const x = r({ turnCount: P.maxTurns });
  t('正例：轮数到达上限 → max_turns', x.action === 'stop' && x.reason === TERMINAL.MAX_TURNS, JSON.stringify(x));
  const y = r({ turnCount: P.maxTurns - 1 });
  t('★反例：轮数差 1 时必须继续', y.action === 'continue', JSON.stringify(y));
}

// ── 2. 时间刹车 ──
{
  const x = r({ startedAt: NOW - P.hardMaxMs });
  t('正例：总时长到硬上限 → hard_max', x.action === 'stop' && x.reason === TERMINAL.HARD_MAX, JSON.stringify(x));
  const y = r({ startedAt: NOW - P.hardMaxMs + 1000 });
  t('★反例：硬上限差 1s 必须继续', y.action === 'continue', JSON.stringify(y));
}
{
  const x = r({ lastActivityAt: NOW - P.idleTimeoutMs });
  t('正例：空闲到阈值 → idle_timeout', x.action === 'stop' && x.reason === TERMINAL.IDLE_TIMEOUT, JSON.stringify(x));
  const y = r({ lastActivityAt: NOW - P.idleTimeoutMs + 1000 });
  t('★反例：空闲差 1s 必须继续', y.action === 'continue', JSON.stringify(y));
}

// ── 3. 预算 ──
{
  const Pb = createStopPolicy({ budgetLimit: 100 });
  const x = evaluateStop({ ...base(), budgetUsed: 100 }, Pb, {});
  t('正例：预算耗尽 → budget_exhausted', x.action === 'stop' && x.reason === TERMINAL.BUDGET_EXHAUSTED, JSON.stringify(x));
  const y = evaluateStop({ ...base(), budgetUsed: 99 }, Pb, {});
  t('★反例：预算差 1 必须继续', y.action === 'continue', JSON.stringify(y));
  const z = evaluateStop({ ...base(), budgetUsed: 999 }, P, {});
  t('★反例：未设预算上限时不能因为 budgetUsed 大就停', z.action === 'continue', JSON.stringify(z));
}

// ── 4. 连续工具失败 ──
{
  const x = r({ consecutiveFailures: P.toolFailureThreshold });
  t('正例：连续失败到阈值 → tool_failure_loop', x.action === 'stop' && x.reason === TERMINAL.TOOL_FAILURE_LOOP, JSON.stringify(x));
  const y = r({ consecutiveFailures: P.toolFailureThreshold - 1 });
  t('★反例：失败次数差 1 必须继续', y.action === 'continue', JSON.stringify(y));
}

// ── 5. 循环检测（5 类）──
{
  const rep = Array.from({ length: P.loop.repeatTimes }, () => ({ name: 'read', args: { p: 'a' }, ok: true }));
  const x = r({ history: rep });
  t('正例：同名同参重复 → generic_repeat', x.action === 'stop' && x.reason === TERMINAL.LOOP_GENERIC_REPEAT, JSON.stringify(x));

  const repLess = rep.slice(0, P.loop.repeatTimes - 1);
  const y = r({ history: repLess });
  t('★反例：重复次数差 1 必须继续', y.action === 'continue', JSON.stringify(y));
}
{
  const poll = Array.from({ length: P.loop.repeatTimes }, () => ({ name: 'poll', args: { id: 1 }, ok: false }));
  const x = r({ history: poll });
  t('正例：失败型重复 → poll_no_progress', x.action === 'stop' && x.reason === TERMINAL.LOOP_POLL_NO_PROGRESS, JSON.stringify(x));
}
{
  // 【2026-11-17 按审计修正】真正的乒乓是「同样两个动作、同样参数」反复来回；
  // 原来这里每轮 args 都带 i（参数不同），那是「有进展的交替」，不该算乒乓。
  const pp = [];
  for (let i = 0; i < P.loop.pingPongCycles; i++) { pp.push({ name: 'a', args: { k: 1 } }, { name: 'b', args: { k: 2 } }); }
  const x = r({ history: pp });
  t('正例：A/B 乒乓 → loop_ping_pong', x.action === 'stop' && x.reason === TERMINAL.LOOP_PING_PONG, JSON.stringify(x));

  const ppLess = pp.slice(0, pp.length - 2);
  const y = r({ history: ppLess });
  t('★反例：乒乓少一轮必须继续', y.action === 'continue', JSON.stringify(y));
}
{
  const unk = Array.from({ length: P.loop.repeatTimes }, () => ({ name: 'nope', args: { i: Math.random() }, unknown: true }));
  const x = r({ history: unk });
  t('正例：未知工具反复 → loop_unknown_tool_repeat', x.action === 'stop' && x.reason === TERMINAL.LOOP_UNKNOWN_TOOL_REPEAT, JSON.stringify(x));
}
{
  // 【2026-11-17 按 openclaw 搬来的语义重写】
  // openclaw 的 argument_churn 判据很窄（tool-loop-argument-churn.ts:33-44）：
  //   · 每次调用必须 noProgress=true（没进展）
  //   · 每个参数变体至少重复 3 次
  //   · 各变体的 resultHash 必须相同
  // 我原来用「成功调用 + 参数一直变」构造，按新语义那**是有进展**，不该判 churn ——
  // 所以旧测试是错的，不是实现错了。
  const variants = 7;   // 7 x 3 = 21 > churnTimes 默认 20
  const perVariant = 3;
  const churn = [];
  for (let round = 0; round < perVariant; round++) {
    for (let v = 0; v < variants; v++) {
      churn.push({ name: 'edit', args: { n: v }, ok: false, resultHash: 'same-failure' });
    }
  }
  const x = r({ history: churn });
  t('正例：多参数变体但结果都一样 → loop_argument_churn',
    x.action === 'stop' && x.reason === TERMINAL.LOOP_ARGUMENT_CHURN, JSON.stringify(x));

  // 负向：同样多变体，但结果**各不相同** ⇒ 有进展，不得判 churn
  const progressing = [];
  for (let round = 0; round < perVariant; round++) {
    for (let v = 0; v < variants; v++) {
      progressing.push({ name: 'edit', args: { n: v }, ok: true, resultHash: 'r' + round + '-' + v });
    }
  }
  const y = r({ history: progressing });
  t('★反例：参数变体多但结果各不同 ⇒ 有进展，不得判 churn',
    !(y.action === 'stop' && y.reason === TERMINAL.LOOP_ARGUMENT_CHURN), JSON.stringify(y));
}

// ── 6. 自然完成 ──
{
  const x = r({ history: [{ name: 'read', args: {}, ok: true }], turnStartIndex: 1, turnCompleted: true });
  t('正例：本轮无工具调用且已结束 → completed', x.action === 'stop' && x.reason === TERMINAL.COMPLETED, JSON.stringify(x));
  const y = r({ history: [{ name: 'read', args: {}, ok: true }], turnStartIndex: 0, turnCompleted: true });
  t('★反例：本轮有工具调用时不能判 completed', y.action === 'continue', JSON.stringify(y));
}

// ── 7. Stop hook 可否决（语义关键：否决 = 继续，不是停）──
{
  const x = r({}, { stopHook: () => ({ prevented: true, why: '目标未达成' }) });
  t('正例：Stop hook 否决 → action=continue（不是 stop）', x.action === 'continue' && x.reason === TERMINAL.STOP_HOOK_PREVENTED, JSON.stringify(x));
  const y = r({}, { stopHook: () => ({ prevented: false }) });
  t('★反例：hook 不否决时不该带 stop_hook 理由', y.reason !== TERMINAL.STOP_HOOK_PREVENTED, JSON.stringify(y));
}

// ── 8. 判不了就说判不了 ──
{
  const x = evaluateStop(null, P, {});
  t('反例：没有运行态 → unknown（不是 continue，也不是 stop）', x.action === 'unknown', JSON.stringify(x));
  const y = evaluateStop({ ...base(), now: undefined }, P, {});
  t('反例：缺时钟 → unknown（超时类条件判不了）', y.action === 'unknown', JSON.stringify(y));
  const z = r({}, { stopHook: () => { throw new Error('boom'); } });
  t('反例：stopHook 抛错 → unknown（不吞成 continue）', z.action === 'unknown', JSON.stringify(z));
}

// ── 9. detectLoop 自身边界 ──
{
  const x = detectLoop([], P.loop);
  t('反例：空历史 → 不命中', x.hit === false, JSON.stringify(x));
  const y = detectLoop(null, P.loop);
  t('反例：非数组 → 不命中（不抛）', y.hit === false, JSON.stringify(y));
}


// ══════════════════════════════════════════════════════════════
// 以下 6 条由 2026-11-17 独立审计 audit-c2 点名的缺口补上。
// 它原话：「Stop hook 在最常见路径上是死的」「阈值是自引用的」
//        「真实误杀无覆盖」「loop_unknown_tool_repeat / poll_no_progress 各仅 1 正例 0 反例」
// ══════════════════════════════════════════════════════════════

// ── A. Stop hook 必须在「自然结束→completed」之前被调用（真 bug 回归）──
{
  let hookCalled = 0;
  const x = r(
    { history: [{ name: 'read', args: {}, ok: true }], turnStartIndex: 1, turnCompleted: true },
    { stopHook: () => { hookCalled++; return { prevented: true, why: '目标未达成' }; } },
  );
  t('★反例（审计抓的真 bug）：自然结束路径上 stopHook 必须被调用',
    hookCalled === 1, 'hookCalled=' + hookCalled);
  t('★反例：hook 否决时，即使模型认为做完也不许停（continue）',
    x.action === 'continue' && x.reason === TERMINAL.STOP_HOOK_PREVENTED, JSON.stringify(x));
}
{
  const x = r(
    { history: [{ name: 'read', args: {}, ok: true }], turnStartIndex: 1, turnCompleted: true },
    { stopHook: () => ({ prevented: false }) },
  );
  t('★反例：hook 不否决时，自然结束仍应 completed', x.action === 'stop' && x.reason === TERMINAL.COMPLETED, JSON.stringify(x));
}

// ── B. 阈值不自引用：显式给不同阈值，行为必须跟着变 ──
{
  const tight = createStopPolicy({ maxTurns: 3 });
  const loose = createStopPolicy({ maxTurns: 99 });
  const st = { ...base(), turnCount: 5 };
  const a = evaluateStop(st, tight, {});
  const b = evaluateStop(st, loose, {});
  t('★反例（审计点名）：maxTurns=3 时轮数 5 该停', a.action === 'stop' && a.reason === TERMINAL.MAX_TURNS, JSON.stringify(a));
  t('★反例（审计点名）：同一状态下 maxTurns=99 不该停', b.action === 'continue', JSON.stringify(b));
}
{
  // 循环阈值同理：同一历史，阈值不同结论必须不同。
  // 按 openclaw 语义构造：2 个变体 × 3 次、结果都相同、都无进展 ⇒ 共 6 条。
  const hist = [];
  for (let round = 0; round < 3; round++) {
    for (let v = 0; v < 2; v++) {
      hist.push({ name: 'x', args: { v }, ok: false, resultHash: 'same' });
    }
  }
  const a = evaluateStop({ ...base(), history: hist }, createStopPolicy({ loop: { churnTimes: 6 } }), {});
  const b = evaluateStop({ ...base(), history: hist }, createStopPolicy({ loop: { churnTimes: 500 } }), {});
  t('★反例：churnTimes=6 命中 argument_churn',
    a.action === 'stop' && a.reason === TERMINAL.LOOP_ARGUMENT_CHURN, JSON.stringify(a));
  t('★反例：churnTimes=500 同一历史不该命中', b.action === 'continue', JSON.stringify(b));
}

// ── C. 合法交替不得被误杀（审计点名的真实误杀）──
{
  // read/edit 交替 6 次，但每次参数都不同 —— 这是有进展的正常工作
  const hist = [];
  for (let i = 0; i < 6; i++) {
    hist.push({ name: 'read', args: { file: 'f' + i }, ok: true });
    hist.push({ name: 'edit', args: { file: 'f' + i, line: i }, ok: true });
  }
  const x = evaluateStop({ ...base(), history: hist }, P, {});
  t('★反例（审计点名）：合法 read/edit 交替且参数不同，**不得**被判 ping_pong',
    !(x.action === 'stop' && x.reason === TERMINAL.LOOP_PING_PONG), JSON.stringify(x));
}
{
  // 真乒乓：同样两个动作、同样参数，反复来回
  const hist = [];
  for (let i = 0; i < 4; i++) {
    hist.push({ name: 'a', args: { k: 1 }, ok: true });
    hist.push({ name: 'b', args: { k: 2 }, ok: true });
  }
  const x = evaluateStop({ ...base(), history: hist }, P, {});
  t('正例：同参来回才算 ping_pong', x.action === 'stop' && x.reason === TERMINAL.LOOP_PING_PONG, JSON.stringify(x));
}

// ── D. unknown_tool_repeat / poll_no_progress 的负向反例（审计说各只有 1 正例 0 反例）──
{
  const unk = Array.from({ length: P.loop.repeatTimes - 1 }, () => ({ name: 'nope', args: {}, unknown: true }));
  const x = evaluateStop({ ...base(), history: unk }, P, {});
  t('★反例：未知工具差 1 次不该命中 unknown_tool_repeat',
    !(x.action === 'stop' && x.reason === TERMINAL.LOOP_UNKNOWN_TOOL_REPEAT), JSON.stringify(x));
}
{
  const poll = Array.from({ length: P.loop.repeatTimes - 1 }, () => ({ name: 'poll', args: { id: 1 }, ok: false }));
  const x = evaluateStop({ ...base(), history: poll }, P, {});
  t('★反例：失败型重复差 1 次不该命中 poll_no_progress',
    !(x.action === 'stop' && x.reason === TERMINAL.LOOP_POLL_NO_PROGRESS), JSON.stringify(x));
}

console.log('');
console.log('  停止条件族反例测试：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
