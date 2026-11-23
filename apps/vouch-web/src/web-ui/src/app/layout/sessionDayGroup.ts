/**
 * 会话历史按「天」分组（对标 dsh-claude-style 的 date-groups）。
 *
 * 为什么需要：历史里有几百条会话时，一长串平铺的名字很难扫；按「今天 / 昨天 / 更早」
 * 分段后，用户能先定位到「最近在弄的」，再往回翻。
 *
 * 纯函数、只按本地日历日切分（不引入时区库）：跨天判断用「同一天 00:00」的毫秒差，
 * 因此 23:59 与次日 00:01 会被正确分成两天。
 */

export type SessionDayKey = 'today' | 'yesterday' | 'earlier';

export const SESSION_DAY_LABEL: Record<SessionDayKey, string> = {
  today: '今天',
  yesterday: '昨天',
  earlier: '更早',
};

/** 把时间戳截到「当天 00:00 本地时间」的毫秒数。 */
function startOfLocalDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

/**
 * 一条会话属于哪一天组。
 *
 * @param iso 会话的 updatedAt（可能缺失/非法 → 归到「更早」，不猜成今天）
 * @param now 参照时刻（测试可注入）
 */
export function sessionDayKey(iso: string | undefined | null, now: Date = new Date()): SessionDayKey {
  if (!iso) return 'earlier';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return 'earlier';
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(t)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return 'earlier';
}

/** 便于渲染：给出「这一条之前是否需要一个分组标题」（与上一条不同组时才需要）。 */
export function needsDayHeader(
  current: string | undefined | null,
  previous: string | undefined | null,
  now: Date = new Date(),
): boolean {
  return sessionDayKey(current, now) !== sessionDayKey(previous, now);
}
