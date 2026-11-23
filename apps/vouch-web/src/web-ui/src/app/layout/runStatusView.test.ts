// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { STOP_LABEL, buildRunStatusView } from './runStatusView';

/** 与后端判定层一致：这九个键一个都不能少、也不能多。 */
const BACKEND_STOP_REASONS = [
  'done', 'step_budget', 'token_budget', 'time_budget',
  'tool_error', 'model_error', 'empty_output', 'truncated', 'user_abort',
];

describe('STOP_LABEL · 与后端判定表的键集合一致（防漂移）', () => {
  it('键数量一致', () => {
    expect(Object.keys(STOP_LABEL)).toHaveLength(BACKEND_STOP_REASONS.length);
  });

  it('后端的每个原因都有中文标签', () => {
    for (const reason of BACKEND_STOP_REASONS) {
      expect(STOP_LABEL[reason], reason).toBeTruthy();
    }
  });

  it('没有多出来的键', () => {
    for (const key of Object.keys(STOP_LABEL)) {
      expect(BACKEND_STOP_REASONS).toContain(key);
    }
  });
});

describe('buildRunStatusView · 空闲态不藏状态', () => {
  it('没有运行记录 → 状态：空闲，其余占位', () => {
    const view = buildRunStatusView(null);
    expect(view.stateLabel).toBe('空闲');
    expect(view.stopLabel).toBe('—');
    expect(view.elapsedLabel).toBe('—');
    expect(view.traceLabel).toBe('trace：—');
    expect(view.usageLabel).toBe('—');
  });
});

describe('buildRunStatusView · 正常一次运行', () => {
  it('后端给了 stopLabel 就优先用', () => {
    const view = buildRunStatusView({
      state: 'PASS', stopReason: 'done', stopLabel: '正常完成',
      traceId: 'tr-abc', elapsedMs: 1234, usage: { calls: 3, input: 100, output: 40 },
    });
    expect(view.stateLabel).toBe('PASS');
    expect(view.stopLabel).toBe('正常完成');
    expect(view.elapsedLabel).toBe('1.2s');
    expect(view.traceLabel).toBe('trace：tr-abc');
    expect(view.usageLabel).toBe('3 次调用（in 100 / out 40）');
  });

  it('没有 stopLabel 时按 STOP_LABEL 翻译 stopReason', () => {
    const view = buildRunStatusView({ state: 'WARN', stopReason: 'step_budget' });
    expect(view.stopLabel).toBe('撞到步数上限');
  });

  it('毫秒级耗时显示 ms', () => {
    expect(buildRunStatusView({ state: 'PASS', elapsedMs: 320 }).elapsedLabel).toBe('320ms');
  });
});

describe('buildRunStatusView · 反例（不许编数据）', () => {
  it('未知 stopReason 原样显示，不冒充「正常完成」', () => {
    const view = buildRunStatusView({ state: 'FAIL', stopReason: 'weird_reason' });
    expect(view.stopLabel).toBe('weird_reason');
  });

  it('elapsedMs 为 0 / 负数 / undefined → 占位，不显示 0.0s', () => {
    expect(buildRunStatusView({ state: 'PASS', elapsedMs: 0 }).elapsedLabel).toBe('—');
    expect(buildRunStatusView({ state: 'PASS', elapsedMs: -5 }).elapsedLabel).toBe('—');
    expect(buildRunStatusView({ state: 'PASS' }).elapsedLabel).toBe('—');
  });

  it('traceId 为空串 → 占位', () => {
    expect(buildRunStatusView({ state: 'PASS', traceId: '   ' }).traceLabel).toBe('trace：—');
  });

  it('usage.calls 缺省或 0 → 占位，不假装「0 次调用」', () => {
    expect(buildRunStatusView({ state: 'PASS', usage: null }).usageLabel).toBe('—');
    expect(buildRunStatusView({ state: 'PASS', usage: { calls: 0 } }).usageLabel).toBe('—');
  });

  it('usage 只有 calls 时不拼空的括号', () => {
    expect(buildRunStatusView({ state: 'PASS', usage: { calls: 2 } }).usageLabel).toBe('2 次调用');
  });

  it('state 缺失 → UNKNOWN，不显示空白', () => {
    expect(buildRunStatusView({}).stateLabel).toBe('UNKNOWN');
  });
});
