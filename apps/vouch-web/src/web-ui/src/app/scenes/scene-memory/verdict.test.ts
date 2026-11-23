import { describe, it, expect } from 'vitest';
import { verdictFromValidation, verdictForMemory, isGreen, tally, allGreen, type Verdict } from './verdict';
import { buildSkeleton } from './memoryEngine';

const V = (issues: { level: 'error' | 'warn' }[]): { ok: boolean; issues: { level: 'error' | 'warn'; code: string; message: string }[] } => ({
  ok: issues.every((i) => i.level !== 'error'),
  issues: issues.map((i, n) => ({ ...i, code: 'c' + n, message: 'm' })),
});

describe('verdict · 四态贯通（UNKNOWN 永不并入通过）', () => {
  it('无问题 ⇒ PASS', () => {
    expect(verdictFromValidation(V([]))).toBe('PASS');
    expect(verdictForMemory(buildSkeleton('调研'))).toBe('PASS');
  });

  it('只有告警 ⇒ WARN（不绿）', () => {
    const v = verdictFromValidation(V([{ level: 'warn' }]));
    expect(v).toBe('WARN');
    expect(isGreen(v)).toBe(false);
  });

  it('有错误 ⇒ FAIL（不绿）', () => {
    const v = verdictFromValidation(V([{ level: 'error' }]));
    expect(v).toBe('FAIL');
    expect(isGreen(v)).toBe(false);
  });

  it('反例·核心：读不到内容 ⇒ UNKNOWN，且绝不算绿', () => {
    expect(verdictFromValidation(null)).toBe('UNKNOWN');
    expect(verdictFromValidation(undefined)).toBe('UNKNOWN');
    expect(verdictForMemory('')).toBe('UNKNOWN');
    expect(verdictForMemory('   ')).toBe('UNKNOWN');
    expect(isGreen('UNKNOWN')).toBe(false);
    expect(isGreen(verdictForMemory(''))).toBe(false);
  });

  it('反例·核心：UNKNOWN 不被 PASS 吞并（tally 单列 + allGreen 为假）', () => {
    const vs: Verdict[] = ['PASS', 'PASS', 'UNKNOWN'];
    const t = tally(vs);
    expect(t.PASS).toBe(2);
    expect(t.UNKNOWN).toBe(1);
    // 3 条里 2 通过 1 判不了 —— 不是全绿
    expect(allGreen(vs)).toBe(false);
  });

  it('反例：混入 UNKNOWN 时，绝不能报告为「全绿」', () => {
    expect(allGreen(['PASS', 'UNKNOWN'])).toBe(false);
    expect(allGreen(['PASS', 'WARN'])).toBe(false);
    expect(allGreen(['PASS', 'PASS'])).toBe(true);
    expect(allGreen([])).toBe(false);
  });

  it('空骨架是 PASS（不是 UNKNOWN）—— UNKNOWN 只给「判不了」', () => {
    // 有内容但合规 ⇒ PASS；不因为"没填真实数据"就判 UNKNOWN
    expect(verdictForMemory(buildSkeleton('X'))).toBe('PASS');
  });
});
