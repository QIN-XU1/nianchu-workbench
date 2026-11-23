#!/usr/bin/env node
/**
 * 念初 · 停止条件（可判定、可审计）
 *
 * ══ 为什么要单独一个模块 ═════════════════════════════════════
 * 31 维矩阵里 C2「停止条件可判定」我们原来是**无** —— 这是全表最差的一项。
 * 现实里的表现是：agent 跑完了，但你分不清它是
 *   「真的做完了」 还是  「步数用完了 / token 用完了 / 工具一直失败，被迫停的」。
 * 分不清就等于不可判 —— 因为「跑完」和「做成」是两件事。
 *
 * ══ 判据（一张表，代码就是这张表）═════════════════════════════
 *   原因            触发条件                         终态？ 四态
 *   done            没有工具调用 + 有最终答复           是     PASS
 *   step_budget     撞到 maxSteps                      是     WARN
 *   token_budget    撞到输出 token 上限且无答复         是     WARN
 *   time_budget     撞到时间上限                        是     WARN
 *   tool_error      工具全部失败且无答复                是     FAIL
 *   model_error     网关/模型层失败                     是     FAIL
 *   empty_output    既没工具调用也没答复                是     UNKNOWN
 *   truncated       输出被截断但仍有答复                是     WARN
 *   user_abort      被显式取消                          是     WARN
 *
 * 关键纪律：**只要撞了预算，就不能算 PASS**。哪怕答复看起来很好。
 * 因为「好」不代表「完整」。
 *
 * ══ 诚实边界 ═════════════════════════════════════════════════
 * · 这是**判定层**，不阻止你继续跑：它只负责把「为什么停」说清楚。
 * · 时间预算靠调用方传入耗时；本模块不算时钟（避免隐藏的全局定时器）。
 * · 不认识的组合一律 UNKNOWN 并给出原因，不猜。
 */

export const STOP_REASONS = [
  'done', 'step_budget', 'token_budget', 'time_budget',
  'tool_error', 'model_error', 'empty_output', 'truncated', 'user_abort',
];

/** 每个原因的元信息：中文名、是否终态、对应四态 */
export const STOP_META = {
  done: { label: '正常完成', terminal: true, four: 'PASS' },
  step_budget: { label: '撞到步数上限', terminal: true, four: 'WARN' },
  token_budget: { label: '撞到 token 上限', terminal: true, four: 'WARN' },
  time_budget: { label: '撞到时间上限', terminal: true, four: 'WARN' },
  tool_error: { label: '工具全部失败', terminal: true, four: 'FAIL' },
  model_error: { label: '模型层失败', terminal: true, four: 'FAIL' },
  empty_output: { label: '既没工具调用也没答复', terminal: true, four: 'UNKNOWN' },
  truncated: { label: '输出被截断', terminal: true, four: 'WARN' },
  user_abort: { label: '被取消', terminal: true, four: 'WARN' },
};

/** 撞预算类原因（任何一条成立就不许 PASS） */
const BUDGET_REASONS = new Set(['step_budget', 'token_budget', 'time_budget', 'truncated']);

/**
 * 判定停止原因。
 *
 * @param {object} s
 * @param {string|null} [s.finalText]     最终答复（null = 没拿到）
 * @param {number} [s.toolCalls]          工具调用次数
 * @param {number} [s.failedToolCalls]    失败的工具调用次数
 * @param {boolean} [s.hitStepLimit]      是否撞到步数上限
 * @param {boolean} [s.hitTokenLimit]     是否撞到输出 token 上限
 * @param {boolean} [s.hitTimeLimit]      是否撞到时间上限
 * @param {boolean} [s.truncated]         输出是否被截断
 * @param {string|null} [s.modelError]    模型层错误（有值即失败）
 * @param {boolean} [s.userAbort]         是否被取消
 * @returns {{reason:string, label:string, four:string, terminal:boolean, detail:string, contradictory?:string}}
 */
export function classifyStop(s = {}) {
  const {
    finalText = null, toolCalls = 0, failedToolCalls = 0,
    hitStepLimit = false, hitTokenLimit = false, hitTimeLimit = false,
    truncated = false, modelError = null, userAbort = false,
  } = s;

  const hasAnswer = typeof finalText === 'string' && finalText.trim().length > 0;
  const base = (reason, detail, extra = {}) => ({
    reason,
    label: STOP_META[reason].label,
    four: STOP_META[reason].four,
    terminal: STOP_META[reason].terminal,
    detail,
    ...extra,
  });

  // 优先级：显式取消 > 模型错误 > 时间 > 步数 > token > 截断 > 工具全失败 > 空 > 完成
  if (userAbort) return base('user_abort', '调用方显式取消');

  if (modelError) return base('model_error', String(modelError).slice(0, 200));

  if (hitTimeLimit) {
    return base('time_budget', '撞到时间上限' + (hasAnswer ? '（已有答复，但不保证完整）' : '（无答复）'));
  }

  if (hitStepLimit) {
    /**
     * 关键判断：撞了步数上限却**还有答复** —— 这是最容易自欺的组合。
     * 「它给了个答案」不等于「它做完了」，所以判 step_budget / WARN，不判 done / PASS。
     */
    return base('step_budget', '撞到步数上限' + (hasAnswer ? '（有答复但可能未完成）' : '（无答复）'));
  }

  if (hitTokenLimit && !hasAnswer) return base('token_budget', '输出被 token 上限截断且无可用答复');

  if (truncated) return base('truncated', '输出被 token 上限截断' + (hasAnswer ? '（答复不完整）' : ''));

  if (toolCalls > 0 && failedToolCalls >= toolCalls && !hasAnswer) {
    return base('tool_error', '全部 ' + toolCalls + ' 次工具调用失败且无答复');
  }

  if (!hasAnswer && toolCalls === 0) return base('empty_output', '没有工具调用也没有答复');

  if (!hasAnswer) return base('empty_output', '有工具调用但没有最终答复');

  return base('done', '正常结束：' + toolCalls + ' 次工具调用，有最终答复', {
    // 有工具失败但最终有答复：仍算完成，但如实标出来
    contradictory: failedToolCalls > 0 ? (failedToolCalls + ' 次工具调用失败（不影响收尾，但值得看）') : undefined,
  });
}

/** 撞了预算就不许 PASS —— 这条单独导出一个断言，方便上游直接调 */
export function assertNotFalseGreen(stop) {
  if (!stop) return { ok: false, problem: '没有停止判定' };
  if (BUDGET_REASONS.has(stop.reason) && stop.four === 'PASS') {
    return { ok: false, problem: '撞了预算却判 PASS（' + stop.reason + '）' };
  }
  if (stop.reason === 'done' && stop.four !== 'PASS') {
    return { ok: false, problem: 'done 却不是 PASS' };
  }
  return { ok: true };
}

/** 给界面/审计看的一句话 */
export function describeStop(stop) {
  if (!stop) return '（未判定）';
  return stop.label + '[' + stop.reason + '] → ' + stop.four + (stop.detail ? ' · ' + stop.detail : '');
}