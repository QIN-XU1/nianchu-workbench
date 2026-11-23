// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { needsDayHeader, sessionDayKey } from './sessionDayGroup';

const NOW = new Date(2026, 10, 22, 15, 30, 0); // 2026-11-22 15:30 本地

describe('sessionDayKey', () => {
  it('今天（含几小时前）', () => {
    expect(sessionDayKey(new Date(2026, 10, 22, 9, 0).toISOString(), NOW)).toBe('today');
  });
  it('★跨零点：昨天 23:59 属于昨天，不是今天', () => {
    expect(sessionDayKey(new Date(2026, 10, 21, 23, 59).toISOString(), NOW)).toBe('yesterday');
  });
  it('★今天 00:01 属于今天', () => {
    expect(sessionDayKey(new Date(2026, 10, 22, 0, 1).toISOString(), NOW)).toBe('today');
  });
  it('前天及更早 → earlier', () => {
    expect(sessionDayKey(new Date(2026, 10, 20, 12, 0).toISOString(), NOW)).toBe('earlier');
  });
  it('未来时间（时钟漂移）→ 归今天，不出现负数天', () => {
    expect(sessionDayKey(new Date(2026, 10, 23, 9, 0).toISOString(), NOW)).toBe('today');
  });
  it('缺失 / 空串 / 非法 → earlier（不猜成今天）', () => {
    expect(sessionDayKey(undefined, NOW)).toBe('earlier');
    expect(sessionDayKey(null, NOW)).toBe('earlier');
    expect(sessionDayKey('', NOW)).toBe('earlier');
    expect(sessionDayKey('not-a-date', NOW)).toBe('earlier');
  });
});

describe('needsDayHeader', () => {
  const today = new Date(2026, 10, 22, 10, 0).toISOString();
  const yesterday = new Date(2026, 10, 21, 10, 0).toISOString();
  const earlier = new Date(2026, 10, 10, 10, 0).toISOString();

  it('第一条（无上一条）需要标题', () => {
    expect(needsDayHeader(today, null, NOW)).toBe(true);
  });
  it('同组之间不需要重复标题', () => {
    expect(needsDayHeader(today, today, NOW)).toBe(false);
  });
  it('跨组需要标题', () => {
    expect(needsDayHeader(yesterday, today, NOW)).toBe(true);
    expect(needsDayHeader(earlier, yesterday, NOW)).toBe(true);
  });
});
