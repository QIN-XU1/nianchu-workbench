/**
 * 会话置顶（批次 Z.23，对标 Qoder / WorkBuddy 侧栏的置顶区）。
 *
 * 【为什么放本地】宿主 `list_sessions` 没有「置顶」字段，这一版不改宿主协议：
 * 置顶只是**本机视图偏好**，存 localStorage，刷新/重开仍在，但换机器不跟随。
 * 这是刻意的边界 —— 假装它跨设备同步才是欺骗。
 *
 * 纯函数，边界写死：
 *  - 只收非空字符串 id，去重（保持首次出现的顺序）
 *  - 上限 50 条：再多就不像「置顶」了，且 localStorage 也有配额
 *  - 存储损坏 / 非数组 / 含非字符串项 → 尽量救回合法项，救不回就空数组
 */

/** localStorage 键名。 */
export const PINNED_STORAGE_KEY = 'ncc_pinned_sessions';

/** 最多能置顶多少条。 */
export const PINNED_LIMIT = 50;

/** 归一化：过滤非字符串/空串、去重、截断到上限。 */
export function normalizePinned(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= PINNED_LIMIT) break;
  }
  return out;
}

/** 读置顶列表；无存储/损坏 → 空数组（不抛）。 */
export function readPinned(storage?: Pick<Storage, 'getItem'> | null): string[] {
  try {
    const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    const raw = store?.getItem(PINNED_STORAGE_KEY);
    if (!raw) return [];
    return normalizePinned(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** 写置顶列表（先归一化再落盘），返回实际写入的值。 */
export function writePinned(ids: unknown, storage?: Pick<Storage, 'setItem'> | null): string[] {
  const next = normalizePinned(ids);
  try {
    const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    store?.setItem(PINNED_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式写不进：内存态仍生效，下次打开回到空 */
  }
  return next;
}

/**
 * 切换某条会话的置顶状态：已置顶 → 移除；未置顶 → 插到**最前面**
 * （刚置顶的那条应该最显眼，而不是排到队尾）。
 */
export function togglePinned(ids: readonly string[], sessionId: string): string[] {
  const list = normalizePinned(ids);
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return list;
  return list.includes(id) ? list.filter((x) => x !== id) : normalizePinned([id, ...list]);
}

/** 是否已置顶。 */
export function isPinned(ids: readonly string[], sessionId: string): boolean {
  return normalizePinned(ids).includes(String(sessionId || '').trim());
}

/**
 * 把 `fromId` 移到 `toId` **前面**（批次 Z.27：置顶项拖动排序）。
 *
 * 边界写死：
 * - 任一边不在列表里 → 原样返回（拖到列表外不产生新顺序，也不清空）
 * - `fromId === toId` → 原样返回（拖回原位不算改动）
 * - 结果仍过 `normalizePinned`（顺序合法、去重、截断）
 *
 * 为什么是「插到前面」而不是「交换」：拖动时用户看到的是插入线，
 * 交换会让中间项全部跳位，不符合直觉。
 */
export function movePinned(ids: readonly string[], fromId: string, toId: string): string[] {
  const list = normalizePinned(ids);
  const from = typeof fromId === 'string' ? fromId.trim() : '';
  const to = typeof toId === 'string' ? toId.trim() : '';
  if (!from || !to || from === to) return list;
  const fromIdx = list.indexOf(from);
  const toIdx = list.indexOf(to);
  if (fromIdx < 0 || toIdx < 0) return list;
  // 先移除再插：`from` 在 `to` 前面时，移除后 `to` 的左移一位
  return movePinnedToIndex(list, from, fromIdx < toIdx ? toIdx - 1 : toIdx);
}

/**
 * 把 `fromId` 移到**最终下标** `toIndex`（键盘 Alt+↑/↓ 用）。
 * 越界自动夹到 [0, len-1]；`fromId` 不在列表里原样返回。
 */
export function movePinnedToIndex(ids: readonly string[], fromId: string, toIndex: number): string[] {
  const list = normalizePinned(ids);
  const from = typeof fromId === 'string' ? fromId.trim() : '';
  const fromIdx = list.indexOf(from);
  if (!from || fromIdx < 0 || !Number.isFinite(toIndex)) return list;
  const clamped = Math.max(0, Math.min(list.length - 1, Math.trunc(toIndex)));
  if (clamped === fromIdx) return list;
  const next = list.slice();
  next.splice(fromIdx, 1);
  next.splice(clamped, 0, from);
  return normalizePinned(next);
}

/**
 * 按置顶顺序把会话排到前面：置顶项按「置顶列表顺序」，其余保持原顺序。
 * 置顶列表里已不存在的 id（会话被删了）自然被跳过。
 */
export function orderSessionsWithPinned<T extends { sessionId: string }>(
  sessions: readonly T[],
  pinned: readonly string[],
): { pinned: T[]; rest: T[] } {
  const list = normalizePinned(pinned);
  const byId = new Map<string, T>();
  for (const s of sessions) if (!byId.has(s.sessionId)) byId.set(s.sessionId, s);
  const pinnedRows: T[] = [];
  const used = new Set<string>();
  for (const id of list) {
    const row = byId.get(id);
    if (row && !used.has(id)) {
      pinnedRows.push(row);
      used.add(id);
    }
  }
  const rest = sessions.filter((s) => !used.has(s.sessionId));
  return { pinned: pinnedRows, rest };
}
