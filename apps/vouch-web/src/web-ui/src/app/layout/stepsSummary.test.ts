// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { stepsSummaryLabel, summarizeSteps } from './stepsSummary';

describe('summarizeSteps', () => {
  it('★计步 + 失败 + 总耗时', () => {
    expect(summarizeSteps([{ ok: true, ms: 400 }, { ok: false, ms: 350 }, { ok: true, ms: 250 }]))
      .toEqual({ total: 3, failed: 1, totalMs: 1000 });
  });
  it('ok 缺省不算失败', () => {
    expect(summarizeSteps([{ ms: 10 }, {}])).toEqual({ total: 2, failed: 0, totalMs: 10 });
  });
  it('ms 非数字/负数/NaN 不计', () => {
    expect(summarizeSteps([{ ms: NaN }, { ms: -5 }, { ms: 20 }])).toEqual({ total: 3, failed: 0, totalMs: 20 });
  });
  it('空 / null / undefined → 全 0', () => {
    expect(summarizeSteps([])).toEqual({ total: 0, failed: 0, totalMs: 0 });
    expect(summarizeSteps(null)).toEqual({ total: 0, failed: 0, totalMs: 0 });
    expect(summarizeSteps(undefined)).toEqual({ total: 0, failed: 0, totalMs: 0 });
  });
});

describe('stepsSummaryLabel', () => {
  it('★全部成功', () => {
    expect(stepsSummaryLabel([{ ok: true, ms: 600 }, { ok: true, ms: 600 }])).toBe('工具调用 · 2 步 · 共 1.2s');
  });
  it('★有失败', () => {
    expect(stepsSummaryLabel([{ ok: false, ms: 180 }, { ok: true, ms: 120 }])).toBe('工具调用 · 2 步 · 1 失败 · 共 300ms');
  });
  it('毫秒小于 1s 用 ms', () => {
    expect(stepsSummaryLabel([{ ok: true, ms: 820 }])).toBe('工具调用 · 1 步 · 共 820ms');
  });
  it('没有耗时就不提耗时', () => {
    expect(stepsSummaryLabel([{ ok: true }, { ok: true }])).toBe('工具调用 · 2 步');
  });
  it('0 步返回空串（不渲染表头）', () => {
    expect(stepsSummaryLabel([])).toBe('');
  });
});
