// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  PINNED_LIMIT,
  PINNED_STORAGE_KEY,
  isPinned,
  movePinned,
  movePinnedToIndex,
  normalizePinned,
  orderSessionsWithPinned,
  readPinned,
  togglePinned,
  writePinned,
} from './pinnedSessions';

function memStore(): Pick<Storage, 'getItem'> & Pick<Storage, 'setItem'> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  } as never;
}

describe('normalizePinned', () => {
  it('★过滤非字符串/空串，去重并保持首次出现顺序', () => {
    expect(normalizePinned(['a', 'b', 'a', '', '  ', 1, null, 'c'])).toEqual(['a', 'b', 'c']);
  });
  it('★不是数组 → 空数组（不抛）', () => {
    expect(normalizePinned(null)).toEqual([]);
    expect(normalizePinned('a,b')).toEqual([]);
    expect(normalizePinned({ 0: 'a' })).toEqual([]);
  });
  it('★超过上限截断（置顶太多就不像置顶了）', () => {
    const many = Array.from({ length: 80 }, (_, i) => 's' + i);
    expect(normalizePinned(many)).toHaveLength(PINNED_LIMIT);
  });
});

describe('读写持久化', () => {
  it('未写过 → 空数组', () => {
    expect(readPinned(memStore())).toEqual([]);
  });
  it('★写入后能读回（真的落盘）', () => {
    const s = memStore();
    writePinned(['x', 'y'], s);
    expect(s.map.get(PINNED_STORAGE_KEY)).toBe('["x","y"]');
    expect(readPinned(s)).toEqual(['x', 'y']);
  });
  it('★存储损坏 → 空数组，不抛', () => {
    const s = memStore();
    s.setItem(PINNED_STORAGE_KEY, '{oops');
    expect(readPinned(s)).toEqual([]);
  });
  it('★存储抛错（隐私模式）→ 读空、写不抛且返回归一化结果', () => {
    const boom = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    } as never;
    expect(readPinned(boom)).toEqual([]);
    expect(writePinned(['a', 'a', 2], boom)).toEqual(['a']);
  });
});

describe('togglePinned', () => {
  it('★未置顶 → 插到最前面（刚置顶的最显眼）', () => {
    expect(togglePinned(['b'], 'a')).toEqual(['a', 'b']);
  });
  it('★已置顶 → 移除', () => {
    expect(togglePinned(['a', 'b'], 'a')).toEqual(['b']);
  });
  it('空 id 不改动（不产生空字符串项）', () => {
    expect(togglePinned(['a'], '   ')).toEqual(['a']);
  });
  it('重复 id 不会写进去（归一化兜底）', () => {
    expect(togglePinned(['a', 'a'], 'b')).toEqual(['b', 'a']);
  });
  it('isPinned 只认完全相同的 id', () => {
    expect(isPinned(['a'], 'a')).toBe(true);
    expect(isPinned(['a'], 'A')).toBe(false);
    expect(isPinned(['a'], '')).toBe(false);
  });
});

describe('orderSessionsWithPinned', () => {
  const sessions = [
    { sessionId: 's1', name: '一' },
    { sessionId: 's2', name: '二' },
    { sessionId: 's3', name: '三' },
  ];
  it('★置顶项按置顶顺序在前，其余保持原顺序', () => {
    const r = orderSessionsWithPinned(sessions, ['s3', 's1']);
    expect(r.pinned.map((s) => s.sessionId)).toEqual(['s3', 's1']);
    expect(r.rest.map((s) => s.sessionId)).toEqual(['s2']);
  });
  it('★置顶列表里有已被删除的会话 → 自然跳过，不产出空行', () => {
    const r = orderSessionsWithPinned(sessions, ['ghost', 's2']);
    expect(r.pinned.map((s) => s.sessionId)).toEqual(['s2']);
    expect(r.rest.map((s) => s.sessionId)).toEqual(['s1', 's3']);
  });
  it('没有置顶 → 全部落在 rest，顺序不变', () => {
    const r = orderSessionsWithPinned(sessions, []);
    expect(r.pinned).toEqual([]);
    expect(r.rest.map((s) => s.sessionId)).toEqual(['s1', 's2', 's3']);
  });
  it('★重复 id 的会话只出现一次（不重复渲染）', () => {
    const dup = [{ sessionId: 's1' }, { sessionId: 's1' }, { sessionId: 's2' }];
    const r = orderSessionsWithPinned(dup, ['s1']);
    expect(r.pinned.map((s) => s.sessionId)).toEqual(['s1']);
    expect(r.rest.map((s) => s.sessionId)).toEqual(['s2']);
  });
});

describe('movePinned（置顶拖动排序，批次 Z.27）', () => {
  const base = ['a', 'b', 'c'];

  it('★把后面的拖到前面 → 插到目标前面', () => {
    expect(movePinned(base, 'c', 'a')).toEqual(['c', 'a', 'b']);
  });

  it('★把前面的拖到后面 → 插到目标之前（与拖到行上的插入线一致）', () => {
    // a 拖到 c 上：a 落在 c 前面，b 仍是第一项
    expect(movePinned(base, 'a', 'c')).toEqual(['b', 'a', 'c']);
  });

  it('★拖回原位 / 自己拖自己 → 不变', () => {
    expect(movePinned(base, 'b', 'b')).toEqual(base);
  });

  it('★任一边不在列表里 → 原样返回（不凭空造 id、不清空）', () => {
    expect(movePinned(base, 'x', 'a')).toEqual(base);
    expect(movePinned(base, 'a', 'x')).toEqual(base);
    expect(movePinned(base, '', 'a')).toEqual(base);
  });

  it('★输入本身不合法（非数组）→ 空数组，不抛', () => {
    expect(movePinned(null as unknown as string[], 'a', 'b')).toEqual([]);
  });
});

describe('movePinnedToIndex（键盘 Alt+↑/↓）', () => {
  const base = ['a', 'b', 'c'];

  it('★上移一位', () => {
    expect(movePinnedToIndex(base, 'b', 0)).toEqual(['b', 'a', 'c']);
  });

  it('★下移一位', () => {
    expect(movePinnedToIndex(base, 'b', 2)).toEqual(['a', 'c', 'b']);
  });

  it('★越界夹到两端（不抛、不丢项）', () => {
    expect(movePinnedToIndex(base, 'a', -5)).toEqual(['a', 'b', 'c']);
    expect(movePinnedToIndex(base, 'a', 99)).toEqual(['b', 'c', 'a']);
  });

  it('★目标下标等于当前下标 → 不变', () => {
    expect(movePinnedToIndex(base, 'b', 1)).toEqual(base);
  });
});
