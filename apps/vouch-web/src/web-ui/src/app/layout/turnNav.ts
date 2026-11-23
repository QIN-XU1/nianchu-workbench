/**
 * 提问跳转（turn-nav）的纯计算。
 *
 * 为什么抽出来：`activeTurn`（当前在第几条提问）与「下一条该跳到第几条」是两个
 * 容易写错的边界逻辑——特别是「滚动到两条提问之间算哪条」「第一条按上一条」
 * 「最后一条按下一条」。埋在滚动事件里既测不了，也最容易在边界处跳错。
 */

/** 从当前条跳到上/下一条，钳在 [0, total-1]。 */
export function clampTurnIndex(current: number, dir: number, total: number): number {
  if (total <= 0) return 0;
  const base = Number.isFinite(current) ? Math.trunc(current) : 0;
  const next = base + (Number.isFinite(dir) ? Math.trunc(dir) : 0);
  return Math.min(total - 1, Math.max(0, next));
}

/**
 * 由「每条提问相对滚动容器顶部的偏移」+ 当前 scrollTop 推导当前在第几条。
 *
 * 规则：**已经滚过视口顶部（含 slack 余量）的最后一条**就是当前条。
 * - 还没滚到第一条 → 0
 * - 落在两条之间 → 取上一条（用户正在看的那一段）
 * - **已经滚到底 → 最后一条**：最后一条提问往往滚不到顶部（后面还有回答，
 *   内容高度不够），只按偏移推会让计数器永远停在倒数第二条 —— 用户明明在看最后一条。
 *
 * @param offsets 每条提问的绝对偏移（升序；相对滚动容器内容顶部）
 * @param scrollTop 当前滚动位置
 * @param slack 认为「到顶」的容差像素
 * @param atBottom 是否已滚到底（由调用方按 scrollHeight - scrollTop - clientHeight 判定）
 */
export function activeTurnFromOffsets(
  offsets: readonly number[],
  scrollTop: number,
  slack = 24,
  atBottom = false,
): number {
  if (offsets.length === 0) return 0;
  if (atBottom) return offsets.length - 1;
  const threshold = (Number.isFinite(scrollTop) ? scrollTop : 0) + Math.max(0, slack);
  let active = 0;
  for (let k = 0; k < offsets.length; k++) {
    if (offsets[k] <= threshold) active = k;
    else break;
  }
  return active;
}
