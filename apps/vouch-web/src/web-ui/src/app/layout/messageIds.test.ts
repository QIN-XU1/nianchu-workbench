// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { historyMessageId, scopedSessionToken } from './messageIds';

describe('scopedSessionToken（要能安全进 [data-mid="…"] 选择器）', () => {
  it('普通 id 原样保留', () => {
    expect(scopedSessionToken('sess-abc123')).toBe('sess-abc123');
  });
  it('★去掉双引号与反斜杠（否则选择器被打断）', () => {
    expect(scopedSessionToken('a"b\\c')).toBe('abc');
  });
  it('空白折成 -（避免选择器里出现换行/空格歧义）', () => {
    expect(scopedSessionToken('a b\tc')).toBe('a-b-c');
  });
  it('非字符串入参不抛（null/undefined/数字）', () => {
    expect(scopedSessionToken(null)).toBe('');
    expect(scopedSessionToken(undefined)).toBe('');
    expect(scopedSessionToken(42)).toBe('42');
  });
});

describe('historyMessageId（id 必须带会话作用域）', () => {
  it('★不同会话的同一下标 → 不同 id（旧实现这里撞车）', () => {
    expect(historyMessageId('A', 3)).not.toBe(historyMessageId('B', 3));
  });
  it('★同一会话不同下标 → 不同 id', () => {
    expect(historyMessageId('A', 1)).not.toBe(historyMessageId('A', 2));
  });
  it('同会话同下标稳定（可重复查询）', () => {
    expect(historyMessageId('A', 1)).toBe(historyMessageId('A', 1));
  });
  it('格式可读：h:<会话>:<下标>', () => {
    expect(historyMessageId('sess-1', 0)).toBe('h:sess-1:0');
  });
  it('★非法下标收敛成 0（不产出 h:A:NaN 这种查不到的 id）', () => {
    expect(historyMessageId('A', Number.NaN)).toBe('h:A:0');
    expect(historyMessageId('A', -5)).toBe('h:A:0');
    expect(historyMessageId('A', 2.9)).toBe('h:A:2');
    expect(historyMessageId('A', undefined)).toBe('h:A:0');
  });
  it('★会话 id 里的危险字符不会漏进 id', () => {
    expect(historyMessageId('a"b', 1)).toBe('h:ab:1');
  });
  it('★真实场景：A 会话第 3 条展开不会影响 B 会话第 3 条（id 不同）', () => {
    const expanded = new Set<string>();
    expanded.add(historyMessageId('sess-A', 3));
    expect(expanded.has(historyMessageId('sess-B', 3))).toBe(false);
    expect(expanded.has(historyMessageId('sess-A', 3))).toBe(true);
  });
});
