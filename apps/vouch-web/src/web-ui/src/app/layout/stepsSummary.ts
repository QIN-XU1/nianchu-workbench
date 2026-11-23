/**
 * 工具步骤汇总（对标 dsh-claude-style 的 process-column：把一次回复里的工具调用
 * 收成「竖列时间线 + 一行摘要」）。
 *
 * 为什么需要：展开的步骤卡一条条看还行，但折叠时用户想知道「这次到底跑了多少步、
 * 有没有失败、总共花了多久」——现在只能一条条数。摘要只做**事实聚合**，
 * 不推断成功原因。
 */

export type StepLike = { ok?: boolean; ms?: number; tool?: string };

export type StepsSummary = {
  /** 总步数（含失败的）。 */
  total: number;
  /** 失败步数。 */
  failed: number;
  /** 总耗时（毫秒，非数字按 0 计）。 */
  totalMs: number;
};

export function summarizeSteps(steps: readonly StepLike[] | null | undefined): StepsSummary {
  const list = Array.isArray(steps) ? steps : [];
  let failed = 0;
  let totalMs = 0;
  for (const s of list) {
    if (s?.ok === false) failed += 1;
    if (typeof s?.ms === 'number' && Number.isFinite(s.ms) && s.ms > 0) totalMs += s.ms;
  }
  return { total: list.length, failed, totalMs };
}

/** 摘要文案：`工具调用 · 3 步 · 1 失败 · 共 1.2s`；0 步返回空串（不渲染表头）。 */
export function stepsSummaryLabel(steps: readonly StepLike[] | null | undefined): string {
  const { total, failed, totalMs } = summarizeSteps(steps);
  if (total === 0) return '';
  const parts = [total + ' 步'];
  if (failed > 0) parts.push(failed + ' 失败');
  if (totalMs > 0) parts.push('共 ' + (totalMs >= 1000 ? (totalMs / 1000).toFixed(1) + 's' : totalMs + 'ms'));
  return '工具调用 · ' + parts.join(' · ');
}
