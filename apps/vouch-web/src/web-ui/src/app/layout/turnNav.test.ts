// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { activeTurnFromOffsets, clampTurnIndex } from './turnNav';

describe('clampTurnIndex', () => {
  it('中间前进/后退', () => {
    expect(clampTurnIndex(1, 1, 4)).toBe(2);
    expect(clampTurnIndex(2, -1, 4)).toBe(1);
  });
  it('第一条按上一条 → 仍在 0（不越界）', () => {
    expect(clampTurnIndex(0, -1, 4)).toBe(0);
  });
  it('最后一条按下一条 → 仍在末位', () => {
    expect(clampTurnIndex(3, 1, 4)).toBe(3);
  });
  it('total=0 → 0（空对话不崩）', () => {
    expect(clampTurnIndex(0, 1, 0)).toBe(0);
  });
  it('非数字 current 兜底为 0', () => {
    expect(clampTurnIndex(Number.NaN, 1, 4)).toBe(1);
  });
});

describe('activeTurnFromOffsets', () => {
  const offsets = [0, 900, 1800, 2700];
  it('在顶部 → 第 0 条', () => {
    expect(activeTurnFromOffsets(offsets, 0)).toBe(0);
  });
  it('★两条之间 → 取上一条（看的是上一段）', () => {
    expect(activeTurnFromOffsets(offsets, 1200)).toBe(1);
  });
  it('正好到某条偏移（含 slack）→ 该条', () => {
    expect(activeTurnFromOffsets(offsets, 1800)).toBe(2);
  });
  it('★刚好差 1px 到某条 → 仍是上一条（slack 之外）', () => {
    expect(activeTurnFromOffsets(offsets, 1770)).toBe(1);
  });
  it('滚到底 → 最后一条', () => {
    expect(activeTurnFromOffsets(offsets, 99999)).toBe(3);
  });
  it('空列表 → 0', () => {
    expect(activeTurnFromOffsets([], 500)).toBe(0);
  });
  it('负 scrollTop → 按 0 处理', () => {
    expect(activeTurnFromOffsets(offsets, -100)).toBe(0);
  });
  it('★滚到底 → 最后一条（末条提问滚不到顶也认）', () => {
    // 真实数据：末条提问偏移 5840，但内容只能滚到 5338，只按偏移会停在倒数第二条
    expect(activeTurnFromOffsets([16, 4759, 5840], 5338, 24, false)).toBe(1);
    expect(activeTurnFromOffsets([16, 4759, 5840], 5338, 24, true)).toBe(2);
  });
  it('★atBottom 只在真的到底时生效：中途传入也不改变按偏移的结果', () => {
    expect(activeTurnFromOffsets(offsets, 0, 24, false)).toBe(0);
    expect(activeTurnFromOffsets(offsets, 1200, 24, false)).toBe(1);
  });
  it('空 offsets + atBottom → 仍是 0（不返回 -1）', () => {
    expect(activeTurnFromOffsets([], 0, 24, true)).toBe(0);
  });
});
