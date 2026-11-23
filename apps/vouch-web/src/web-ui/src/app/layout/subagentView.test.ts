// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { buildSubagentView } from './subagentView';

describe('buildSubagentView · 正常', () => {
  it('摘要 + 内部工具流 + 计数', () => {
    const v = buildSubagentView({
      ok: true,
      summary: '确认 1+1=2',
      toolCalls: 2,
      innerSteps: [{ tool: 'bash', ok: true, ms: 12 }, { tool: 'read', ok: false, ms: 5 }],
    });
    expect(v?.summary).toBe('确认 1+1=2');
    expect(v?.steps).toHaveLength(2);
    expect(v?.okCount).toBe(1);
    expect(v?.failCount).toBe(1);
    expect(v?.totalCalls).toBe(2);
    expect(v?.truncated).toBe(false);
  });

  it('只有摘要、没有内部工具流（子代理没调工具）→ 不返回 null，steps 空', () => {
    const v = buildSubagentView({ ok: true, summary: '直接回答' });
    expect(v?.summary).toBe('直接回答');
    expect(v?.steps).toEqual([]);
    expect(v?.totalCalls).toBe(0);
  });

  it('★totalCalls 大于已保留步骤 → truncated=true（如实说有没展开的）', () => {
    const v = buildSubagentView({ toolCalls: 35, innerSteps: [{ tool: 'bash', ok: true, ms: 1 }] });
    expect(v?.truncated).toBe(true);
    expect(v?.totalCalls).toBe(35);
    expect(v?.steps).toHaveLength(1);
  });

  it('内部步骤最多保留 20 条', () => {
    const many = Array.from({ length: 40 }, () => ({ tool: 'bash', ok: true, ms: 1 }));
    expect(buildSubagentView({ innerSteps: many })?.steps).toHaveLength(20);
  });
});

describe('buildSubagentView · 防御（结果字段不保证存在）', () => {
  it('null / undefined / 非对象 → null', () => {
    expect(buildSubagentView(null)).toBeNull();
    expect(buildSubagentView(undefined)).toBeNull();
    expect(buildSubagentView('x')).toBeNull();
    expect(buildSubagentView(42)).toBeNull();
  });

  it('既无摘要也无步骤 → null（不渲染空下钻区）', () => {
    expect(buildSubagentView({ ok: false, reason: '深度上限' })).toBeNull();
  });

  it('脏 innerSteps（缺字段 / 非对象）不崩，缺省 tool=「tool」、ok 按成功', () => {
    const v = buildSubagentView({ innerSteps: [null, {}, { tool: 'grep', ok: false }] });
    expect(v?.steps).toHaveLength(2);
    expect(v?.steps[0]).toEqual({ tool: 'tool', ok: true, ms: null });
    expect(v?.steps[1]).toEqual({ tool: 'grep', ok: false, ms: null });
  });

  it('summary 非字符串按空串处理', () => {
    const v = buildSubagentView({ summary: 123, innerSteps: [{ tool: 'bash' }] });
    expect(v?.summary).toBe('');
  });

  it('ms 非数字 → null', () => {
    const v = buildSubagentView({ innerSteps: [{ tool: 'bash', ms: 'NaNs' }] });
    expect(v?.steps[0].ms).toBeNull();
  });
});
