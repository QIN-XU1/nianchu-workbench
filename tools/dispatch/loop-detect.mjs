#!/usr/bin/env node
/**
 * 工具循环检测 —— **直接搬自 openclaw**（不是重写）。
 *
 * 出处（逐字对照，只做 TS→JS 与数据形状适配）：
 *   D:/refs/openclaw/openclaw-main/src/agents/tool-loop-no-progress.ts:4-90
 *   D:/refs/openclaw/openclaw-main/src/agents/tool-loop-argument-churn.ts:5-50
 *   D:/refs/openclaw/openclaw-main/src/agents/tool-loop-call-kind.ts:3-12
 *   D:/refs/openclaw/openclaw-main/src/agents/tool-loop-thresholds.ts:1
 *
 * 为什么搬而不写：我此前手写的 detectLoop 只比「名字+参数相等」，
 * 而 openclaw 的实现区分了
 *   · 结果哈希（同参但结果不同 ⇒ 有进展，不算循环）
 *   · argument churn（参数在变但结果稳定 ⇒ 也是卡住）
 *   · poll 类工具的例外（轮询本来就是重复的）
 * 这些区分是踩过坑才有的，重写一遍只会退回到更弱的版本。
 *
 * 数据形状（我们这边的 record）：
 *   { name, args, ok, resultHash?, outcomeKind?, failureIdentityHash? }
 * 与 openclaw 的 ToolCallRecord 字段对应关系：
 *   toolName -> name, argsHash -> 由 args 算, resultHash -> resultHash
 */

import { createHash } from 'node:crypto';

/** 来自 openclaw tool-loop-thresholds.ts:1 —— 警告阈值 */
export const TOOL_LOOP_WARNING_THRESHOLD = 10;
/** 来自 openclaw tool-loop-argument-churn.ts:3 */
const MIN_STABLE_CALLS_PER_VARIANT = 3;

/** 稳定序列化 + sha256（对应 openclaw 的 sha256StableValue） */
export function stableHash(value) {
  const seen = new WeakSet();
  const canon = (v) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    if (seen.has(v)) return '"[circular]"';
    seen.add(v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  };
  return createHash('sha256').update(canon(value), 'utf8').digest('hex');
}

/** 对应 openclaw hashToolCall（tool-loop-detection.ts:73） */
export function hashToolCall(toolName, params) {
  return stableHash({ toolName, params });
}

/**
 * 搬自 tool-loop-call-kind.ts:3-12 —— 轮询类工具不算循环。
 */
export function isKnownPollToolCall(toolName, params) {
  if (toolName === 'command_status' || toolName === 'wait') return true;
  if (toolName !== 'process') return false;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  const action = params.action;
  return action === 'poll' || action === 'log';
}

/**
 * 搬自 tool-loop-no-progress.ts:4-90 —— 连续「同参同结果」的条数。
 * 结果一变就断（说明有进展）。
 */
export function getNoProgressStreak(history, toolName, argsHash) {
  const repeatedArguments = countNoProgressStreak(history, toolName, argsHash, false);
  if (toolName !== 'exec') return repeatedArguments;
  const terminalFailures = countNoProgressStreak(history, toolName, argsHash, true);
  return terminalFailures.count > repeatedArguments.count ? terminalFailures : repeatedArguments;
}

function countNoProgressStreak(history, toolName, argsHash, terminalExecFailuresOnly) {
  let streak = 0;
  let latestOutcome;
  let crossedArgumentBoundary = false;
  let pendingLoopVetoes = 0;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const record = history[i];
    if (!record) continue;
    if (terminalExecFailuresOnly && record.outcomeKind === 'argument-validation') continue;
    if (record.name !== toolName) {
      if (terminalExecFailuresOnly) break;
      continue;
    }
    if (!terminalExecFailuresOnly && record.argsHash !== argsHash) continue;
    if (record.outcomeKind === 'tool-loop-veto') { pendingLoopVetoes += 1; continue; }
    if (typeof record.resultHash !== 'string' || !record.resultHash) continue;
    if (terminalExecFailuresOnly && record.outcomeKind !== 'terminal-exec-failure') break;
    if (!latestOutcome) {
      latestOutcome = record;
      crossedArgumentBoundary = record.argsHash !== argsHash;
      streak = pendingLoopVetoes + 1;
      pendingLoopVetoes = 0;
      continue;
    }
    if (terminalExecFailuresOnly) {
      if (crossedArgumentBoundary && record.argsHash === argsHash) break;
      if (record.argsHash !== argsHash) crossedArgumentBoundary = true;
    }
    const repeatsSameFailure =
      terminalExecFailuresOnly &&
      record.failureIdentityHash !== undefined &&
      record.failureIdentityHash === latestOutcome.failureIdentityHash;
    if (record.resultHash !== latestOutcome.resultHash && !repeatsSameFailure) break;
    streak += pendingLoopVetoes + 1;
    pendingLoopVetoes = 0;
  }

  return {
    count: latestOutcome ? streak : terminalExecFailuresOnly ? 0 : pendingLoopVetoes,
    latestResultHash: latestOutcome?.resultHash,
  };
}

/**
 * 搬自 tool-loop-argument-churn.ts:5-50 —— 参数在变但结果稳定。
 * 注意原文注释：这是 warning-only，判据很窄 ——
 * 尾部每次调用都必须属于「重复的稳定变体」，且新调用必须延续其中一个变体。
 */
export function getArgumentChurnNoProgressStreak(history, toolName, currentArgsHash) {
  const outcomes = new Map();
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const record = history[i];
    if (!record || record.name !== toolName) break;
    if (!record.resultHash) continue;
    if (record.noProgress !== true) break;
    const previous = outcomes.get(record.argsHash);
    if (previous && previous.resultHash !== record.resultHash) break;
    outcomes.set(record.argsHash, {
      resultHash: record.resultHash,
      count: (previous?.count ?? 0) + 1,
    });
  }

  const allOutcomes = Array.from(outcomes.values());
  const hasStableChurn =
    allOutcomes.length > 1 &&
    outcomes.has(currentArgsHash) &&
    allOutcomes.every(
      (o) => o.count >= MIN_STABLE_CALLS_PER_VARIANT && o.resultHash === allOutcomes[0]?.resultHash,
    );

  return hasStableChurn
    ? { count: allOutcomes.reduce((s, o) => s + o.count, 0), variantCount: allOutcomes.length }
    : { count: 0, variantCount: 0 };
}

/**
 * 给我们的 record 补齐哈希（openclaw 的记录由 recordToolCall 维护，
 * 我们这里做一个等价的「就地补全」，方便直接喂给上面两个函数）。
 */
export function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.map((r) => {
    const argsHash = r.argsHash ?? hashToolCall(r.name, r.args ?? {});
    const resultHash =
      r.resultHash ??
      (r.ok === false ? stableHash({ failed: true, name: r.name }) : stableHash({ ok: true, name: r.name }));
    return {
      ...r,
      argsHash,
      resultHash,
      noProgress: r.noProgress ?? r.ok === false,
    };
  });
}
