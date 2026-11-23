#!/usr/bin/env node
/**
 * 停止条件族（C2）—— 我们自己的可判定实现。
 *
 * 为什么现在做：verify-goal 里 R3 的两个真缺口之一是「C2 停止条件可判定」，
 * 而我们此前只有 `maxTurns?: number`（AgentAPI.ts:65）一个刹车。
 * 四份拆解独立印证：成熟实现的停止条件都是**一族可独立判定的刹车**，不是一个数字。
 *
 * 出处（每条都在拆解报告里核过行号）：
 *   · openclaude `src/query/transitions.ts:1-18` —— 12 个 Terminal 终态
 *   · openhands 7 态 + 三并行刹车（max_iterations / budget / stuck_detection）
 *   · learn-claude-code s01:106-111（无 tool_use）+ s04:235-240（Stop hook 可否决）
 *     + s17:360-428（goal 评估器 6 分支 + block_cap=8）
 *   · openclaw `src/agents/tool-loop-detection.ts:548-685` —— 5 类循环检测器
 *     （unknown_tool_repeat / global_circuit_breaker / poll_no_progress / ping_pong / generic_repeat+argument_churn）
 *
 * 设计原则：
 *   · **每个条件都能独立判定**，且能单独测出「该停」与「不该停」
 *   · **判不了就 UNKNOWN，不猜**：参数缺失时返回 unknown 而不是默认放行/默认停
 *   · 不做越界拦截类机制：这里只决定「要不要停」，不决定「允不允许做」
 */

/** 终态（对齐 openclaude transitions.ts:1-18，按我们的形态裁剪） */
export const TERMINAL = Object.freeze({
  COMPLETED: 'completed',
  MAX_TURNS: 'max_turns',
  IDLE_TIMEOUT: 'idle_timeout',
  HARD_MAX: 'hard_max',
  TOOL_FAILURE_LOOP: 'tool_failure_loop',
  BUDGET_EXHAUSTED: 'budget_exhausted',
  STOP_HOOK_PREVENTED: 'stop_hook_prevented',
  MODEL_ERROR: 'model_error',
  ABORTED: 'aborted',
  PROMPT_TOO_LONG: 'prompt_too_long',
  LOOP_UNKNOWN_TOOL_REPEAT: 'loop_unknown_tool_repeat',
  LOOP_PING_PONG: 'loop_ping_pong',
  LOOP_POLL_NO_PROGRESS: 'loop_poll_no_progress',
  LOOP_GENERIC_REPEAT: 'loop_generic_repeat',
  LOOP_ARGUMENT_CHURN: 'loop_argument_churn',
});

/** 默认策略 —— 数值来自拆解里各家的量级，不是拍脑袋 */
export function createStopPolicy(over = {}) {
  return {
    maxTurns: over.maxTurns ?? 50,
    idleTimeoutMs: over.idleTimeoutMs ?? 5 * 60 * 1000,
    hardMaxMs: over.hardMaxMs ?? 30 * 60 * 1000,
    toolFailureThreshold: over.toolFailureThreshold ?? 3,
    /** 循环检测阈值：对齐 openclaw 的 10 / 20 / 30 三档 */
    loop: {
      repeatTimes: over.loop?.repeatTimes ?? 10,
      pingPongCycles: over.loop?.pingPongCycles ?? 3,
      churnTimes: over.loop?.churnTimes ?? 20,
      ...(over.loop || {}),
    },
    budgetLimit: over.budgetLimit ?? null,
  };
}

// 【2026-11-17 直接搬】循环检测改用 openclaw 的实现，不再手写。
// 出处：tools/dispatch/loop-detect.mjs 头部注释列了逐字对照的行号。
import {
  normalizeHistory,
  getNoProgressStreak,
  getArgumentChurnNoProgressStreak,
  isKnownPollToolCall,
  hashToolCall,
} from './loop-detect.mjs';

const same = (a, b) => {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
};

/**
 * 工具调用循环检测 —— **算法搬自 openclaw**，不再手写。
 *
 * 相比我原来的实现（只比「名字+参数相等」），搬来的版本多做了两件事：
 *   · 比**结果哈希**：同参但结果不同 ⇒ 有进展，不算循环（避免误杀）
 *   · argument churn：参数在变但结果稳定 ⇒ 也是卡住
 *
 * 保留原来的返回形状 {hit, kind, detail}，调用方不用改。
 *
 * @param {Array<{name:string, args?:any, ok?:boolean}>} history
 * @param {object} th 阈值
 */
export function detectLoop(history, th) {
  if (!Array.isArray(history) || history.length === 0) return { hit: false };

  const norm = normalizeHistory(history);
  const last = norm[norm.length - 1];
  const argsHash = last.argsHash ?? hashToolCall(last.name, last.args ?? {});

  // 轮询类工具（command_status / wait / process poll|log）不算循环
  if (isKnownPollToolCall(last.name, last.args)) return { hit: false };

  // ① 连续「同参同结果」—— 搬自 tool-loop-no-progress.ts
  const np = getNoProgressStreak(norm, last.name, argsHash);
  if (np.count >= th.repeatTimes) {
    const kind = last.ok === false ? TERMINAL.LOOP_POLL_NO_PROGRESS : TERMINAL.LOOP_GENERIC_REPEAT;
    return { hit: true, kind, detail: last.name + ' 同参同结果连续 ' + np.count + ' 次' };
  }

  // ② 未知工具反复出现
  const recent = norm.slice(-th.repeatTimes);
  if (recent.length >= th.repeatTimes && recent.every((h) => h.unknown === true)) {
    return { hit: true, kind: TERMINAL.LOOP_UNKNOWN_TOOL_REPEAT, detail: '未知工具连续 ' + recent.length + ' 次' };
  }

  // ③ 乒乓：相邻不同 + 只涉及两个名字 + 参数成对重复
  {
    const names = norm.map((h) => h.name);
    let runLen = 1;
    for (let i = names.length - 1; i >= 1; i--) {
      if (names[i] === names[i - 1]) break;
      const set = new Set(names.slice(i - 1, names.length));
      if (set.size > 2) break;
      runLen++;
    }
    if (runLen >= th.pingPongCycles * 2) {
      const seg = norm.slice(norm.length - runLen);
      const sig = (h) => h.name + '|' + h.argsHash;
      let repeatedPairs = 0;
      for (let i = 2; i + 1 < seg.length; i += 2) {
        if (sig(seg[i]) === sig(seg[i - 2]) && sig(seg[i + 1]) === sig(seg[i - 1])) repeatedPairs++;
      }
      if (repeatedPairs >= th.pingPongCycles - 1) {
        return { hit: true, kind: TERMINAL.LOOP_PING_PONG, detail: '两名工具同参来回 ' + Math.floor(runLen / 2) + ' 轮' };
      }
    }
  }

  // ④ argument churn —— 搬自 tool-loop-argument-churn.ts
  const churn = getArgumentChurnNoProgressStreak(norm, last.name, argsHash);
  if (churn.count >= th.churnTimes) {
    return {
      hit: true,
      kind: TERMINAL.LOOP_ARGUMENT_CHURN,
      detail: last.name + ' 在 ' + churn.variantCount + ' 个参数变体间循环 ' + churn.count + ' 次',
    };
  }

  return { hit: false };
}

/**
 * 判定是否该停。
 *
 * @param {object} state 运行态：
 *   turnCount, startedAt(ms), lastActivityAt(ms), now(ms),
 *   history[], consecutiveFailures, budgetUsed, modelError, aborted, promptTooLong
 * @param {object} policy createStopPolicy() 的结果
 * @param {object} [hooks] { stopHook?: () => ({prevented:boolean, why?:string}) }
 * @returns {{action:'stop'|'continue'|'unknown', reason:string, detail:string}}
 */
export function evaluateStop(state, policy = createStopPolicy(), hooks = {}) {
  // ── 判不了就先说判不了（缺关键状态不猜）──
  if (!state || typeof state !== 'object') {
    return { action: 'unknown', reason: 'unknown', detail: '没有运行态，判不了' };
  }
  const now = Number.isFinite(state.now) ? state.now : null;
  if (now === null) {
    return { action: 'unknown', reason: 'unknown', detail: '缺少 now（时钟），判不了超时类条件' };
  }

  // ── 1. 硬错误优先（这些不需要等阈值）──
  if (state.aborted) return { action: 'stop', reason: TERMINAL.ABORTED, detail: '被显式中止' };
  if (state.modelError) return { action: 'stop', reason: TERMINAL.MODEL_ERROR, detail: '模型错误：' + String(state.modelError).slice(0, 80) };
  if (state.promptTooLong) return { action: 'stop', reason: TERMINAL.PROMPT_TOO_LONG, detail: 'prompt 超长' };

  // ── 2. 时间刹车（两档：空闲 / 硬上限）──
  if (Number.isFinite(state.startedAt) && now - state.startedAt >= policy.hardMaxMs) {
    return { action: 'stop', reason: TERMINAL.HARD_MAX, detail: '总时长 ' + Math.round((now - state.startedAt) / 1000) + 's ≥ 硬上限 ' + Math.round(policy.hardMaxMs / 1000) + 's' };
  }
  if (Number.isFinite(state.lastActivityAt) && now - state.lastActivityAt >= policy.idleTimeoutMs) {
    return { action: 'stop', reason: TERMINAL.IDLE_TIMEOUT, detail: '空闲 ' + Math.round((now - state.lastActivityAt) / 1000) + 's ≥ ' + Math.round(policy.idleTimeoutMs / 1000) + 's' };
  }

  // ── 3. 轮数 / 预算 ──
  if (Number.isFinite(state.turnCount) && state.turnCount >= policy.maxTurns) {
    return { action: 'stop', reason: TERMINAL.MAX_TURNS, detail: '轮数 ' + state.turnCount + ' ≥ ' + policy.maxTurns };
  }
  if (policy.budgetLimit != null && Number.isFinite(state.budgetUsed) && state.budgetUsed >= policy.budgetLimit) {
    return { action: 'stop', reason: TERMINAL.BUDGET_EXHAUSTED, detail: '预算 ' + state.budgetUsed + ' ≥ ' + policy.budgetLimit };
  }

  // ── 4. 连续工具失败 ──
  if (Number.isFinite(state.consecutiveFailures) && state.consecutiveFailures >= policy.toolFailureThreshold) {
    return { action: 'stop', reason: TERMINAL.TOOL_FAILURE_LOOP, detail: '连续失败 ' + state.consecutiveFailures + ' 次' };
  }

  // ── 5. 循环检测 ──
  const loop = detectLoop(state.history, policy.loop);
  if (loop.hit) return { action: 'stop', reason: loop.kind, detail: loop.detail };

  // ── 6. Stop hook 可否决（外挂评估器，不改循环）──
  //
  // 【2026-11-17 独立审计 audit-c2 抓到的真 bug】原来这一步在「自然结束」之后，
  // 导致最常见的 completed 路径上 hook **根本没被调用**（实测 hookCalled=0）。
  // 语义上 hook 的意义正是「模型觉得做完了，但目标没达成 ⇒ 不许停」，
  // 所以必须先问 hook，再判 completed。
  const hookVerdict = (() => {
    if (typeof hooks.stopHook !== 'function') return null;
    try { return hooks.stopHook(); } catch (e) {
      return { __error: String(e && e.message).slice(0, 60) };
    }
  })();
  if (hookVerdict && hookVerdict.__error) {
    return { action: 'unknown', reason: 'unknown', detail: 'stopHook 抛错，判不了：' + hookVerdict.__error };
  }
  const hookPrevented = !!(hookVerdict && hookVerdict.prevented);

  // ── 7. 自然结束：本轮没有工具调用 ──
  const hist = Array.isArray(state.history) ? state.history : [];
  const turnStart = Number.isFinite(state.turnStartIndex) ? state.turnStartIndex : hist.length;
  const turnCalls = hist.slice(turnStart);
  if (Array.isArray(state.history) && turnCalls.length === 0 && state.turnCompleted === true) {
    if (hookPrevented) {
      return { action: 'continue', reason: TERMINAL.STOP_HOOK_PREVENTED, detail: '模型认为做完了，但目标未达成，不许停：' + String(hookVerdict.why || '').slice(0, 80) };
    }
    return { action: 'stop', reason: TERMINAL.COMPLETED, detail: '本轮没有工具调用（模型认为做完了）' };
  }

  if (hookPrevented) {
    return { action: 'continue', reason: TERMINAL.STOP_HOOK_PREVENTED, detail: '目标未达成，不许停：' + String(hookVerdict.why || '').slice(0, 80) };
  }

  return { action: 'continue', reason: 'continue', detail: '没有任何刹车触发' };
}

/** 一句话可读化（给界面/日志用） */
export function describe(r) {
  if (!r) return 'unknown';
  const tag = r.action === 'stop' ? '停' : r.action === 'continue' ? '继续' : '判不了';
  return tag + ' · ' + r.reason + ' · ' + r.detail;
}
