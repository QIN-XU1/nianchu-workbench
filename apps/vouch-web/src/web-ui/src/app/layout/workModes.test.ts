// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  MODE_ORDER, modeUsesTools, normalizeWorkMode, pickKnownModes, toolsHint, toolsTitle,
} from './workModes';

describe('normalizeWorkMode', () => {
  it('四个合法模式原样返回', () => {
    for (const id of MODE_ORDER) expect(normalizeWorkMode(id)).toBe(id);
  });
  it('未知 / 空 / 非字符串 → 保守降到 chat（不降到 do）', () => {
    expect(normalizeWorkMode('craft')).toBe('chat');
    expect(normalizeWorkMode('')).toBe('chat');
    expect(normalizeWorkMode(null)).toBe('chat');
    expect(normalizeWorkMode(42)).toBe('chat');
    expect(normalizeWorkMode('DO')).toBe('chat');
  });
  it('前后空白会去掉（持久化值常见）', () => {
    expect(normalizeWorkMode(' do ')).toBe('do');
  });
});

describe('modeUsesTools', () => {
  it('只有对话模式不调工具', () => {
    expect(modeUsesTools('chat')).toBe(false);
    expect(modeUsesTools('ask')).toBe(true);
    expect(modeUsesTools('plan')).toBe(true);
    expect(modeUsesTools('do')).toBe(true);
  });
});

describe('toolsHint', () => {
  const ask = { id: 'ask', label: '只读', desc: '', tools: ['read', 'glob', 'grep', 'recall'] };
  it('空清单 → 不调用工具', () => {
    expect(toolsHint({ id: 'chat', label: '对话', desc: '', tools: [] })).toBe('不调用工具');
  });
  it('宿主没给模式（null）→ 明说不可用，不编数字', () => {
    expect(toolsHint(null)).toBe('工具清单不可用');
    expect(toolsTitle(null)).toContain('list_modes');
  });
  it('超过 max 项时截断并带省略号', () => {
    expect(toolsHint(ask, 3)).toBe('4 项：read · glob · grep · …');
  });
  it('不超过 max 项时不加省略号', () => {
    expect(toolsHint(ask, 4)).toBe('4 项：read · glob · grep · recall');
  });
  it('max=0 / 负数按 1 处理，不返回空头', () => {
    expect(toolsHint(ask, 0)).toBe('4 项：read · …');
  });
  it('tools 里混进脏值会被过滤', () => {
    const dirty = { id: 'ask', label: '只读', desc: '', tools: ['read', '', 'grep' as string] };
    expect(toolsHint(dirty)).toBe('2 项：read · grep');
  });
});

describe('toolsTitle', () => {
  it('逐行列出全部工具名', () => {
    const t = toolsTitle({ id: 'ask', label: '只读', desc: '', tools: ['read', 'glob'] });
    expect(t).toBe('只读（2 项）\nread\nglob');
  });
  it('空清单也给出人话', () => {
    expect(toolsTitle({ id: 'chat', label: '对话', desc: '', tools: [] }))
      .toBe('对话：不调用任何工具');
  });
});

describe('pickKnownModes', () => {
  it('按 chat/ask/plan/do 排序，而不是按宿主返回顺序', () => {
    const got = pickKnownModes([
      { id: 'do', label: '动手', tools: ['write'] },
      { id: 'chat', label: '对话', tools: [] },
      { id: 'ask', label: '只读', tools: ['read'] },
    ]);
    expect(got.map((m) => m.id)).toEqual(['chat', 'ask', 'do']);
  });
  it('丢掉未知 id、重复 id、非对象项', () => {
    const got = pickKnownModes([
      { id: 'craft', label: '工艺', tools: [] },
      { id: 'ask', label: '只读', tools: ['read'] },
      { id: 'ask', label: '只读(重复)', tools: ['write'] },
      null, 'x', 7,
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].label).toBe('只读');
  });
  it('缺 label 时用本地兜底文案；tools 非数组按空处理', () => {
    const got = pickKnownModes([{ id: 'plan' }]);
    expect(got[0].label).toBe('计划');
    expect(got[0].tools).toEqual([]);
    expect(got[0].desc).toBe('');
  });
  it('非数组输入返回空数组', () => {
    expect(pickKnownModes(undefined)).toEqual([]);
    expect(pickKnownModes({ id: 'ask' })).toEqual([]);
  });
});
