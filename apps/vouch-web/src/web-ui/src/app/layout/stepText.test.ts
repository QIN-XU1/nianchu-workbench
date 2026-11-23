// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { stepArgText, stepKey, stepOutputText } from './stepText';

describe('stepArgText', () => {
  it('优先取 path / command 这类有信息量的参数', () => {
    expect(stepArgText({ path: 'src/a.ts' })).toBe('src/a.ts');
    expect(stepArgText({ command: 'ls -la' })).toBe('ls -la');
  });
  it('超长参数截断到 60 字加省略号', () => {
    const s = stepArgText({ path: 'a'.repeat(100) });
    expect(s.endsWith('…')).toBe(true);
    expect(s.length).toBe(61);
  });
  it('非对象/空 → 空串（不抛）', () => {
    expect(stepArgText(null)).toBe('');
    expect(stepArgText('x')).toBe('');
    expect(stepArgText({})).toBe('{}');
  });
});

describe('stepOutputText', () => {
  it('字符串原样、对象转 JSON、截断 1200', () => {
    expect(stepOutputText('ok')).toBe('ok');
    expect(stepOutputText({ a: 1 })).toContain('"a": 1');
    expect(stepOutputText('x'.repeat(5000)).length).toBe(1200);
  });
  it('循环引用不抛', () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(stepOutputText(o)).toBe('');
  });
});

describe('stepKey（内容决定 key，批次 Z.24）', () => {
  it('★同一条步骤的 key 稳定（重复渲染不会变）', () => {
    const step = { tool: 'read', ok: true, ms: 10, input: { path: 'a.ts' } };
    expect(stepKey(step)).toBe(stepKey({ ...step }));
  });
  it('★不同工具 / 不同参数 → 不同 key', () => {
    expect(stepKey({ tool: 'read', input: { path: 'a.ts' } }))
      .not.toBe(stepKey({ tool: 'read', input: { path: 'b.ts' } }));
    expect(stepKey({ tool: 'read' })).not.toBe(stepKey({ tool: 'bash' }));
  });
  it('★成败与耗时也进 key（同工具同参数的两次调用不会撞）', () => {
    expect(stepKey({ tool: 'bash', ok: true, ms: 10, input: { command: 'ls' } }))
      .not.toBe(stepKey({ tool: 'bash', ok: false, ms: 10, input: { command: 'ls' } }));
    expect(stepKey({ tool: 'bash', ms: 10, input: { command: 'ls' } }))
      .not.toBe(stepKey({ tool: 'bash', ms: 20, input: { command: 'ls' } }));
  });
  it('★插入一条新步骤不改变已有步骤的 key（这正是下标 key 做不到的）', () => {
    const read = { tool: 'read', ok: true, ms: 10, input: { path: 'a.ts' } };
    const bash = { tool: 'bash', ok: true, ms: 20, input: { command: 'ls' } };
    const k1 = [stepKey(read), stepKey(bash)];
    const k2 = [stepKey({ tool: 'glob', input: { pattern: '*.ts' } }), stepKey(read), stepKey(bash)];
    expect(k2.slice(1)).toEqual(k1);
  });
  it('缺工具名/空参数也能产出非空 key（不会变成 undefined）', () => {
    expect(stepKey({})).toBe('tool|1||');
  });
});
