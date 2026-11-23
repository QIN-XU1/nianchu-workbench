// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  HISTORY_PAGE_SIZE,
  hasMoreHistory,
  historyCountLabel,
  nextHistoryLimit,
  visibleHistoryCount,
} from './historyPaging';

describe('visibleHistoryCount', () => {
  it('首屏只渲染一页（不一次塞进上千条）', () => {
    expect(visibleHistoryCount(HISTORY_PAGE_SIZE, 996)).toBe(60);
  });
  it('★总数比上限小 → 取总数（不会渲染出空行）', () => {
    expect(visibleHistoryCount(60, 12)).toBe(12);
  });
  it('★上限超过总数 → 收敛到总数', () => {
    expect(visibleHistoryCount(1000, 996)).toBe(996);
  });
  it('非法输入不抛（NaN/负数/null/字符串数字）', () => {
    expect(visibleHistoryCount(Number.NaN, 10)).toBe(0);
    expect(visibleHistoryCount(-5, 10)).toBe(0);
    expect(visibleHistoryCount(60, Number.NaN)).toBe(0);
    expect(visibleHistoryCount('60', '12')).toBe(12);
  });
  it('小数向下取整（不渲染半个条目）', () => {
    expect(visibleHistoryCount(60.9, 100)).toBe(60);
  });
});

describe('nextHistoryLimit', () => {
  it('点一次加一页', () => {
    expect(nextHistoryLimit(60, 996)).toBe(120);
  });
  it('★加过头就停在总数上（不会超过）', () => {
    expect(nextHistoryLimit(960, 996)).toBe(996);
    expect(nextHistoryLimit(996, 996)).toBe(996);
  });
  it('自定义步长', () => {
    expect(nextHistoryLimit(60, 996, 30)).toBe(90);
  });
  it('非法步长回落默认页大小（不卡死）', () => {
    expect(nextHistoryLimit(60, 996, Number.NaN)).toBe(120);
    expect(nextHistoryLimit(60, 996, 0)).toBe(120);
  });
  it('总数非法 → 0（按钮消失而不是乱加）', () => {
    expect(nextHistoryLimit(60, Number.NaN)).toBe(0);
  });
});

describe('hasMoreHistory', () => {
  it('还有更多 → true；已到底 → false', () => {
    expect(hasMoreHistory(60, 996)).toBe(true);
    expect(hasMoreHistory(996, 996)).toBe(false);
  });
  it('总数小于一页 → false（不显示加载更多）', () => {
    expect(hasMoreHistory(60, 12)).toBe(false);
  });
  it('★非法输入：已显示数非法按 0（还有更多 → true）；总数非法按 0（→ false）', () => {
    expect(hasMoreHistory(Number.NaN, 996)).toBe(true);
    expect(hasMoreHistory(60, Number.NaN)).toBe(false);
  });
});

describe('historyCountLabel', () => {
  it('★文案里两个数字都来自真实数据', () => {
    expect(historyCountLabel(60, 996)).toBe('已显示 60 / 共 996 条');
  });
  it('显示数不会超过总数', () => {
    expect(historyCountLabel(5000, 12)).toBe('已显示 12 / 共 12 条');
  });
  it('非法输入 → 0 而不是 NaN', () => {
    expect(historyCountLabel(Number.NaN, Number.NaN)).toBe('已显示 0 / 共 0 条');
  });
});
