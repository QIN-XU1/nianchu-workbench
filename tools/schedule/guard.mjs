#!/usr/bin/env node
/**
 * 调度 job 的停止判定 —— 把 tools/dispatch/stop.mjs 真正接进运行时。
 *
 * 背景（第 4 次独立审计 audit-c2 的原话）：
 *   「判定器真实存在、测试不是假绿，但**全仓零调用方**，产品运行时不用它做刹车」
 * 这是口径问题：模块为真但没接进链路，只能判「部分」。
 *
 * 这个文件让调度器在**每次 tick 前**用同一套刹车判定要不要继续跑，
 * 而不是各写一套 if。接入点：
 *   tools/schedule/tick.mjs → tickOnce() → guardTick()
 *
 * 判定语义（与 stop.mjs 一致，不做第二套逻辑）：
 *   · 连续失败 ≥ 阈值        ⇒ 停止本轮 tick（tool_failure_loop）
 *   · 距上次活动 ≥ 空闲阈值  ⇒ 停止（idle_timeout）
 *   · job 数 ≥ 预算          ⇒ 停止（budget_exhausted）
 *   · 其它                   ⇒ 继续
 *   · 状态不全（缺时钟等）   ⇒ unknown，且**默认放行**（不因判不了就阻塞调度）
 */
import { createStopPolicy, evaluateStop } from '../dispatch/stop.mjs';

/** 调度器的默认策略：比 agent 宽松（调度是分钟级，不是毫秒级） */
export function createSchedulePolicy(over = {}) {
  return createStopPolicy({
    // ── 对调度器**没有意义**的三类，显式关掉并写明理由 ──
    //   idle_timeout：调度器没活干是**健康**状态，不是故障。若按「多久没活动」判停，
    //                 夜间没有 job 就会误停。真正的「卡住」由 hard_max（单个 tick 时长）覆盖。
    //   max_turns：调度器没有「轮」的概念（tick 是时间驱动的，不是对话驱动的）。
    //   loop_*：job 的 cmd 固定、参数不变，不存在乒乓 / 参数 churn / 未知工具。
    maxTurns: Number.POSITIVE_INFINITY,
    idleTimeoutMs: Number.POSITIVE_INFINITY,
    // ── 对调度器**有意义**的三类 ──
    hardMaxMs: over.hardMaxMs ?? 30 * 60 * 1000,  // 单个 tick 不该超过 30 分钟
    // 连续失败阈值：生产只有 3 个 job，阈值必须 ≤ 3 才可达（第 5 次审计抓到过）
    toolFailureThreshold: over.toolFailureThreshold ?? 2,
    // 单个 tick 最多跑多少个 job —— 默认 50，防止一次到点几百个 job 把进程拖死
    budgetLimit: over.budgetLimit ?? 50,
    ...over,
  });
}

/**
 * 跑一次 tick 前问一句「该不该继续」。
 *
 * @param {object} ctx { consecutiveFailures, lastActivityAt, jobsDue, now, startedAt }
 * @param {object} policy
 * @returns {{allow:boolean, decision:object}}
 *   allow=false 只在**明确判定要停**时发生；unknown 一律放行（判不了不能变成阻塞）
 */
export function guardTick(ctx, policy = createSchedulePolicy()) {
  const decision = evaluateStop({
    now: ctx.now,
    // hard_max 用**真实**的 tick 开始时间（调用方传 tickStartedAt）
    startedAt: ctx.tickStartedAt,
    // idle_timeout 已显式关闭（策略里是 Infinity），这里不传 lastActivityAt，
    // 避免「每 tick 自刷新」这种假装可达
    lastActivityAt: undefined,
    // 调度器没有「轮」，显式不传 turnCount
    consecutiveFailures: ctx.consecutiveFailures,
    // 预算语义 = 「**本轮已跑数**」的上限，不是「到点数」。
    // （原来传 jobsDue ⇒ 6 个到点、预算 3 时入口就挡住，一个都不跑，语义错了。）
    budgetUsed: ctx.jobsRan ?? 0,
    // 调度器不做工具循环检测，显式不传 history
    history: undefined,
    turnCompleted: false,
  }, policy, {});

  // 判不了（unknown）不能阻塞调度 —— 如实记录，但放行
  const allow = decision.action !== 'stop';
  return { allow, decision };
}
