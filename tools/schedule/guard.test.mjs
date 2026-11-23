#!/usr/bin/env node
/**
 * guard.mjs 的反例测试 —— 调度器里「该不该继续跑」的判定。
 *
 * 这套测试存在的意义（第 4 次独立审计 audit-c2 的原话）：
 *   「判定器真实存在、测试不是假绿，但**全仓零调用方**」
 * 现在它有调用方了（tools/schedule/tick.mjs），这里锁住三件事：
 *   ① 该停时能停（连续失败 / 空闲超时 / 预算）
 *   ② **不该停时不能停**（差 1 次失败、差 1ms 空闲）
 *   ③ **判不了不能变成阻塞** —— unknown 一律放行，否则调度器会因为
 *      「缺个时钟」而永远停摆，那是比不停更糟的故障
 */
import { guardTick, createSchedulePolicy } from './guard.mjs';

let pass = 0, fail = 0;
const t = (n, ok, d) => { if (ok) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (d ? '  ← ' + d : '')); } };

const NOW = 1_800_000_000_000;
const P = createSchedulePolicy();
const base = () => ({
  now: NOW,
  startedAt: NOW - 1000,
  lastActivityAt: NOW - 1000,
  consecutiveFailures: 0,
  jobsDue: 1,
});

// ── ① 该停时停 ──
{
  const g = guardTick({ ...base(), consecutiveFailures: P.toolFailureThreshold }, P);
  t('正例：连续失败到阈值 ⇒ 不放行', g.allow === false && g.decision.reason === 'tool_failure_loop', JSON.stringify(g.decision));
}
// 【2026-11-17 设计判断】idle_timeout 对调度器**没有意义**：
// 调度器没活干是健康状态，不是故障。若按「多久没活动」判停，夜间没有 job 就会误停。
// 所以策略里显式关成 Infinity，这里断言它**永远不会**触发。
{
  const g = guardTick({ ...base(), lastActivityAt: 0 }, P);   // 极久没有活动
  t('★反例：调度器空闲再久也不能停（没活干是健康的，不是故障）',
    g.allow === true, JSON.stringify(g.decision));
}
{
  // 【2026-11-17 语义修正】预算 = 「本轮**已跑**数」的上限，不是「到点数」。
  // 原来传 jobsDue ⇒ 6 个到点、预算 3 时入口就挡住、一个都不跑，语义错了。
  const Pb = createSchedulePolicy({ budgetLimit: 3 });
  const g = guardTick({ ...base(), jobsRan: 3, jobsDue: 6 }, Pb);
  t('正例：本轮已跑 3 个到预算 ⇒ 不放行', g.allow === false && g.decision.reason === 'budget_exhausted', JSON.stringify(g.decision));
}

// ── ② 不该停时不能停（差 1）──
{
  const g = guardTick({ ...base(), consecutiveFailures: P.toolFailureThreshold - 1 }, P);
  t('★反例：连续失败差 1 ⇒ 必须放行', g.allow === true, JSON.stringify(g.decision));
}
{
  const g = guardTick({ ...base(), lastActivityAt: NOW - P.idleTimeoutMs + 1 }, P);
  t('★反例：空闲差 1ms ⇒ 必须放行', g.allow === true, JSON.stringify(g.decision));
}
{
  const Pb = createSchedulePolicy({ budgetLimit: 3 });
  const g = guardTick({ ...base(), jobsRan: 2, jobsDue: 6 }, Pb);
  t('★反例：本轮已跑 2 个、差 1 个到预算 ⇒ 必须放行', g.allow === true, JSON.stringify(g.decision));
  // 关键负向反例：到点数很大但还没跑，不能因此挡住（否则一个都不跑）
  const g2 = guardTick({ ...base(), jobsRan: 0, jobsDue: 99 }, Pb);
  t('★反例：到点 99 个但本轮还没跑 ⇒ 必须放行（预算按已跑数，不按到点数）',
    g2.allow === true, JSON.stringify(g2.decision));
}
{
  const g = guardTick(base(), P);
  t('★反例：干净状态 ⇒ 必须放行（防止实现退化成永远阻塞）', g.allow === true, JSON.stringify(g.decision));
}

// ── ③ 判不了不能变成阻塞（这条最重要）──
{
  const g = guardTick({ ...base(), now: undefined }, P);
  t('★反例：缺时钟 ⇒ decision 是 unknown，但**必须放行**',
    g.decision.action === 'unknown' && g.allow === true, JSON.stringify(g));
}
{
  const g = guardTick({}, undefined); // 用默认策略，且 ctx 只有空对象
  t('★反例：ctx 几乎为空 ⇒ 仍必须放行（判不了 ≠ 阻塞）', g.allow === true, JSON.stringify(g.decision));
}

// ── ④ 策略必须真的生效（不要自引用）──
{
  const tight = createSchedulePolicy({ toolFailureThreshold: 2 });
  const loose = createSchedulePolicy({ toolFailureThreshold: 10 });
  const a = guardTick({ ...base(), consecutiveFailures: 3 }, tight);
  const b = guardTick({ ...base(), consecutiveFailures: 3 }, loose);
  t('★反例：阈值 2 时失败 3 次该停', a.allow === false, JSON.stringify(a.decision));
  t('★反例：阈值 10 时同样失败 3 次不该停', b.allow === true, JSON.stringify(b.decision));
}

// ── ⑤ 默认策略是给调度用的量级（不是 agent 的毫秒级）──
{
  // 【2026-11-17 第 6 次审计后重定】调度器只保留 3 类有意义的刹车：
  //   tool_failure_loop（连续失败 2 次）/ budget_exhausted（单 tick 最多 50 job）/
  //   hard_max（单 tick 不超过 30 分钟）
  // 显式关闭 3 类不适用的：idle_timeout / max_turns / loop_*
  t('正例：调度策略只开有意义的 3 类（失败 2 / 预算 50 / 单 tick 30min）',
    P.toolFailureThreshold === 2 && P.budgetLimit === 50 && P.hardMaxMs === 30 * 60 * 1000,
    JSON.stringify({ th: P.toolFailureThreshold, budget: P.budgetLimit, hard: P.hardMaxMs }));
  t('★反例：不适用的 3 类必须显式关闭（idle/maxTurns 为 Infinity）',
    P.idleTimeoutMs === Number.POSITIVE_INFINITY && P.maxTurns === Number.POSITIVE_INFINITY,
    JSON.stringify({ idle: String(P.idleTimeoutMs), maxTurns: String(P.maxTurns) }));
  t('★反例：阈值必须在生产规模下可达（job 数 ≥ 阈值）',
    P.toolFailureThreshold <= 3, 'threshold=' + P.toolFailureThreshold);
}

console.log('');
console.log('  调度停止判定反例测试：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
