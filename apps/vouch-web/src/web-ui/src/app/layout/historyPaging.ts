/**
 * 历史会话列表的分页（批次 Z.22）。
 *
 * 【为什么要分页】本机会话可能上千条（实测 996）。一次全渲染会塞进上千个 DOM 节点，
 * 打开浮层就卡；之前是「硬截断 60 条 + 一句提示」，用户想找更早的会话只能靠搜索命中，
 * 翻不到底。这里把「截断」改成**可按需加载**，同时保持首屏只渲染 60 条。
 *
 * 纯函数，边界写死：
 *  - 已显示数永远不超过总数，也不小于 0
 *  - 总数未知/非法（NaN、负数）按 0 处理，不产出「加载更多（还有 NaN 条）」
 *  - 每次点击固定加一页；加到头就停在总数上（按钮随之消失）
 */

/** 每页条数（首屏与每次「加载更多」都加这么多）。 */
export const HISTORY_PAGE_SIZE = 60;

/** 当前应该渲染多少条：`min(limit, total)`，且两项都收敛到非负整数。 */
export function visibleHistoryCount(limit: unknown, total: unknown): number {
  const n = Number(total);
  const size = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  const l = Number(limit);
  const wanted = Number.isFinite(l) && l > 0 ? Math.trunc(l) : 0;
  return Math.min(wanted, size);
}

/** 点一次「加载更多」后的上限：当前 + 一页，不超过总数。 */
export function nextHistoryLimit(current: unknown, total: unknown, step = HISTORY_PAGE_SIZE): number {
  const n = Number(total);
  const size = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  const c = Number(current);
  const base = Number.isFinite(c) && c > 0 ? Math.trunc(c) : 0;
  const s = Number.isFinite(Number(step)) && Number(step) > 0 ? Math.trunc(Number(step)) : HISTORY_PAGE_SIZE;
  return Math.min(base + s, size);
}

/** 是否还有没渲染的条目（决定「加载更多」按钮显不显示）。 */
export function hasMoreHistory(shown: unknown, total: unknown): boolean {
  const n = Number(total);
  const size = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  const s = Number(shown);
  const shownCount = Number.isFinite(s) && s > 0 ? Math.trunc(s) : 0;
  return shownCount < size;
}

/** 脚注文案：`已显示 60 / 共 996 条`（两处数字都来自真实数据，不写死）。 */
export function historyCountLabel(shown: unknown, total: unknown): string {
  const n = Number(total);
  const size = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  const s = Number(shown);
  const shownCount = Math.min(Number.isFinite(s) && s > 0 ? Math.trunc(s) : 0, size);
  return '已显示 ' + shownCount + ' / 共 ' + size + ' 条';
}
