// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { activeResultMsgIndex, extractSnippets } from './searchSnippets';

describe('activeResultMsgIndex（命中列表坐标 → msgs 坐标）', () => {
  it('★第 0 条命中 → 它在 msgs 里的下标（不是 0）', () => {
    expect(activeResultMsgIndex([5, 7, 9], 0)).toBe(5);
  });
  it('★第 1 条命中 → msgs 下标 7（两套坐标不能直接对）', () => {
    expect(activeResultMsgIndex([5, 7, 9], 1)).toBe(7);
    expect(activeResultMsgIndex([5, 7, 9], 2)).toBe(9);
  });
  it('searchIdx 越界时收敛到最后一条（界面不会给非法下标）', () => {
    expect(activeResultMsgIndex([5, 7, 9], 99)).toBe(9);
    expect(activeResultMsgIndex([5, 7, 9], -3)).toBe(5);
  });
  it('非数字/null 当作第 0 条（不返回 NaN 当下标）', () => {
    expect(activeResultMsgIndex([5, 7], Number.NaN)).toBe(5);
    expect(activeResultMsgIndex([5, 7], null)).toBe(5);
    expect(activeResultMsgIndex([5, 7], undefined)).toBe(5);
  });
  it('★没有命中 → -1（不是 0，0 会误指第一条消息）', () => {
    expect(activeResultMsgIndex([], 0)).toBe(-1);
    expect(activeResultMsgIndex(null, 0)).toBe(-1);
    expect(activeResultMsgIndex(undefined, 0)).toBe(-1);
  });
  it('只有一条命中时无论给哪个下标都返回那一条', () => {
    expect(activeResultMsgIndex([4], 0)).toBe(4);
    expect(activeResultMsgIndex([4], 5)).toBe(4);
  });
  it('★与真实搜索场景一致：命中是第 5、7 条消息，选中第 2 条 → 第 7 条消息', () => {
    const matches = [5, 7];
    expect(activeResultMsgIndex(matches, 1)).toBe(7);
    expect(extractSnippets(
      Array.from({ length: 8 }, (_, i) => ({ role: i === 7 ? 'assistant' : 'user', content: `第${i}条 ${i === 5 || i === 7 ? '端口' : 'x'}` })),
      '端口',
    ).map((s) => s.msgIndex)).toEqual([5, 7]);
  });
});

const msgs = [
  { role: 'user', content: '帮我看看这个报错' },
  { role: 'assistant', content: '这个报错通常是因为端口被占用，先检查 3002 端口。' },
  { role: 'user', content: '端口检查过了没问题' },
  { role: 'assistant', content: '那就再检查一下防火墙规则。' },
];

describe('extractSnippets', () => {
  it('★大小写不敏感，命中词原样保留', () => {
    const r = extractSnippets([{ role: 'user', content: 'Hello World' }], 'hello');
    expect(r).toHaveLength(1);
    expect(r[0].match).toBe('Hello');
    expect(r[0].msgIndex).toBe(0);
  });

  it('★只取每条消息的第一处命中', () => {
    const r = extractSnippets([{ role: 'user', content: '端口 端口 端口' }], '端口');
    expect(r).toHaveLength(1);
    expect(r[0].before).toBe('');
  });

  it('★前后补上下文，超长两侧加省略号', () => {
    const long = 'a'.repeat(60) + '命中词' + 'b'.repeat(60);
    const r = extractSnippets([{ role: 'assistant', content: long }], '命中词', { radius: 10 });
    expect(r[0].before).toBe('…' + 'a'.repeat(10));
    expect(r[0].after).toBe('b'.repeat(10) + '…');
  });

  it('★按上限截断（limit 默认 5）', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ role: 'user', content: '关键词' + i }));
    expect(extractSnippets(many, '关键词')).toHaveLength(5);
    expect(extractSnippets(many, '关键词', { limit: 2 })).toHaveLength(2);
  });

  it('空查询 / 无命中 → 空数组', () => {
    expect(extractSnippets(msgs, '   ')).toEqual([]);
    expect(extractSnippets(msgs, '不存在的词')).toEqual([]);
    expect(extractSnippets(null, 'x')).toEqual([]);
  });

  it('多条消息按顺序返回，msgIndex 指向原消息', () => {
    const r = extractSnippets(msgs, '端口');
    expect(r.map((x) => x.msgIndex)).toEqual([1, 2]);
    expect(r[1].role).toBe('user');
  });

  it('命中在开头/结尾时不补多余省略号', () => {
    const r = extractSnippets([{ role: 'user', content: '端口被占用' }], '端口', { radius: 4 });
    expect(r[0].before).toBe('');
    expect(r[0].after).toBe('被占用');
  });
});
