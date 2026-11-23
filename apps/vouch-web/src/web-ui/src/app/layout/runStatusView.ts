/**
 * 运行状态条：把一次「动手」运行的四件事翻成人话——
 *   它在做什么（状态）/ 为什么停（停止原因）/ 花了多久（耗时）/ 怎么复盘（trace）/ 花了多少（用量）
 *
 * 为什么单独抽出来：这些字段是**判定层**（`tools/agent/stop.mjs` 的 STOP_REASONS）的投影，
 * 前端的键集合必须与后端严格一致——多一个少一个都会让界面显示英文 reason 或错标签。
 * 抽成纯函数，判据脚本就能直接 import 这一份（不重写等价逻辑），键一改名立刻红。
 *
 * 诚实边界：这里的标签是**展示用**；真正「为什么停」由后端 stop.mjs 判定，前端不改判。
 */

/** 与 `tools/agent/stop.mjs` 的 STOP_REASONS 必须逐字一致（判据脚本会比对）。 */
export const STOP_LABEL: Record<string, string> = {
  done: '正常完成',
  step_budget: '撞到步数上限',
  token_budget: '撞到 token 上限',
  time_budget: '撞到时间上限',
  tool_error: '工具全部失败',
  model_error: '模型层失败',
  empty_output: '既没工具调用也没答复',
  truncated: '输出被截断',
  user_abort: '被取消',
};

export interface RunUsageLike {
  calls?: number;
  input?: number;
  output?: number;
}

/** `run_task` 回包里与状态条相关的字段（其余字段这里不关心）。 */
export interface RunStatusInput {
  state?: string;
  stopReason?: string;
  /** 后端已给的中文标签；给了就优先用，保证与判定层一致。 */
  stopLabel?: string;
  traceId?: string;
  elapsedMs?: number;
  usage?: RunUsageLike | null;
}

export interface RunStatusView {
  /** 无运行记录时是「空闲」——不把状态藏起来。 */
  stateLabel: string;
  stopLabel: string;
  elapsedLabel: string;
  /** 已经是「trace：xxx」整句，没有则「trace：—」。 */
  traceLabel: string;
  usageLabel: string;
}

const DASH = '—';

function formatElapsed(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return DASH;
  if (ms < 1000) return Math.round(ms) + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

function formatUsage(usage: RunUsageLike | null | undefined): string {
  if (!usage || typeof usage.calls !== 'number' || usage.calls <= 0) return DASH;
  const calls = usage.calls + ' 次调用';
  if (typeof usage.input !== 'number' && typeof usage.output !== 'number') return calls;
  return calls + '（in ' + (usage.input ?? 0) + ' / out ' + (usage.output ?? 0) + '）';
}

/**
 * 把一次运行翻成状态条。
 *
 * @param run 最近一次运行为 null 时表示「还没有跑过」→ 空闲。
 */
export function buildRunStatusView(run: RunStatusInput | null | undefined): RunStatusView {
  if (!run) {
    return {
      stateLabel: '空闲',
      stopLabel: DASH,
      elapsedLabel: DASH,
      traceLabel: 'trace：' + DASH,
      usageLabel: DASH,
    };
  }
  // 后端给了 stopLabel 就用它；否则按 STOP_LABEL 翻译；再不行**原样显示** stopReason，
  // 绝不显示一个假的「正常完成」。
  const stopLabel = run.stopLabel
    || (run.stopReason ? (STOP_LABEL[run.stopReason] ?? run.stopReason) : DASH);
  return {
    stateLabel: String(run.state || 'UNKNOWN'),
    stopLabel,
    elapsedLabel: formatElapsed(run.elapsedMs),
    traceLabel: 'trace：' + (typeof run.traceId === 'string' && run.traceId.trim() ? run.traceId.trim() : DASH),
    usageLabel: formatUsage(run.usage),
  };
}
