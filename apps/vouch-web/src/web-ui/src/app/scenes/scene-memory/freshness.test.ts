import { describe, it, expect } from 'vitest';
import { applyFreshness, canClaimCurrent, DEFAULT_STALE_MS } from './freshness';

const NOW = Date.parse('2026-11-16T20:00:00.000Z');
const H = 3600000;

describe('applyFreshness —— 防「历史快照冒充此刻」', () => {
  it('新鲜（1 小时前）⇒ 沿用源 PASS', () => {
    const f = applyFreshness('PASS', new Date(NOW - 1 * H).toISOString(), NOW);
    expect(f.verdict).toBe('PASS');
    expect(f.stale).toBe(false);
    expect(canClaimCurrent(f)).toBe(true);
  });

  it('陈旧（34.9 小时前）⇒ 降为 WARN（反例：这正是本轮发现的假绿）', () => {
    const f = applyFreshness('PASS', new Date(NOW - 34.9 * H).toISOString(), NOW);
    expect(f.verdict).toBe('WARN');
    expect(f.stale).toBe(true);
    expect(canClaimCurrent(f)).toBe(false);
    expect(f.reason).toContain('快照');
  });

  it('恰好超过阈值 ⇒ WARN', () => {
    const f = applyFreshness('PASS', new Date(NOW - DEFAULT_STALE_MS - 1).toISOString(), NOW);
    expect(f.verdict).toBe('WARN');
  });

  it('恰好等于阈值 ⇒ 仍算新鲜（边界不误伤）', () => {
    const f = applyFreshness('PASS', new Date(NOW - DEFAULT_STALE_MS).toISOString(), NOW);
    expect(f.verdict).toBe('PASS');
    expect(f.stale).toBe(false);
  });

  it('没有时间戳 ⇒ UNKNOWN（判不了，不猜 PASS）', () => {
    expect(applyFreshness('PASS', null, NOW).verdict).toBe('UNKNOWN');
    expect(applyFreshness('PASS', undefined, NOW).verdict).toBe('UNKNOWN');
    expect(applyFreshness('PASS', '', NOW).verdict).toBe('UNKNOWN');
  });

  it('时间戳非法 ⇒ UNKNOWN', () => {
    expect(applyFreshness('PASS', 'not-a-date', NOW).verdict).toBe('UNKNOWN');
  });

  it('源 FAIL 即使很新鲜也保持 FAIL（不被新鲜度掩盖）', () => {
    const f = applyFreshness('FAIL', new Date(NOW - 1 * H).toISOString(), NOW);
    expect(f.verdict).toBe('FAIL');
  });

  it('源 FAIL 且陈旧 ⇒ 仍是 FAIL（失败优先于陈旧）', () => {
    const f = applyFreshness('FAIL', new Date(NOW - 100 * H).toISOString(), NOW);
    expect(f.verdict).toBe('FAIL');
  });

  it('源 UNKNOWN + 陈旧 ⇒ WARN（陈旧本身是可报告的已知问题）', () => {
    const f = applyFreshness('UNKNOWN', new Date(NOW - 50 * H).toISOString(), NOW);
    expect(f.verdict).toBe('WARN');
    expect(f.stale).toBe(true);
  });

  it('可复算：同输入两次结果一致', () => {
    const a = applyFreshness('PASS', new Date(NOW - 5 * H).toISOString(), NOW);
    const b = applyFreshness('PASS', new Date(NOW - 5 * H).toISOString(), NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('未来时间戳 ⇒ 年龄按 0 算，不出现负年龄', () => {
    const f = applyFreshness('PASS', new Date(NOW + 5 * H).toISOString(), NOW);
    expect(f.ageMs).toBe(0);
    expect(f.verdict).toBe('PASS');
  });
});
