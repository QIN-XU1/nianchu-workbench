/**
 * 消息 id 的作用域（批次 Z.21）。
 *
 * 【为什么单独一层】历史消息原本用 `'h' + 下标` 当 id —— **纯位置型**。
 * 而「展开全文」这类视图状态是按 id 记在 `Set<string>` 里的：
 * A 会话展开过第 3 条，切到 B 会话，B 的第 3 条会莫名其妙也是展开的（id 撞了）。
 * id 必须**带上会话作用域**才谈得上唯一。
 *
 * 另外这些 id 会进 `[data-mid="…"]` 选择器（滚动定位/跳转都用它），
 * 所以作用域只保留安全字符：引号和反斜杠会把选择器打断，必须去掉。
 */

/** 把会话 id 收敛成可安全放进属性选择器的片段（去掉引号与反斜杠，空白折成 -）。 */
export function scopedSessionToken(sessionId: unknown): string {
  const raw = typeof sessionId === 'string' ? sessionId : String(sessionId ?? '');
  return raw.replace(/["\\]/g, '').replace(/\s+/g, '-');
}

/**
 * 历史消息 id：`h:<会话片段>:<下标>`。
 * - 同一会话内下标不同 → 不同 id
 * - 不同会话同一下标 → 不同 id（这正是旧实现丢掉的那条）
 * - 下标非法（NaN/负数/小数）按 0 处理，不产出 `h:x:NaN` 这种不可查询的 id
 */
export function historyMessageId(sessionId: unknown, index: unknown): string {
  const n = Number(index);
  const safeIndex = Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
  return 'h:' + scopedSessionToken(sessionId) + ':' + safeIndex;
}
