// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { cleanSessionTitle, sessionDisplayName } from './sessionTitle';

describe('cleanSessionTitle', () => {
  it('★去掉「目标：」前缀', () => {
    expect(cleanSessionTitle('目标：在工作目录创建 out.txt')).toBe('在工作目录创建 out.txt');
  });
  it('★去掉「总目标：」前缀', () => {
    expect(cleanSessionTitle('总目标：写一个脚本')).toBe('写一个脚本');
  });
  it('去掉「请 / 请只 / 帮我」前缀', () => {
    expect(cleanSessionTitle('请只回复两个字：收到')).toBe('回复两个字：收到');
    expect(cleanSessionTitle('帮我看看这个报错')).toBe('看看这个报错');
  });
  it('合并空白与换行', () => {
    expect(cleanSessionTitle('目标：第一行\n\n第二行')).toBe('第一行 第二行');
  });
  it('★超长按词边界截断并补 …', () => {
    const raw = '在工作目录创建 out.txt，内容写 team-ok-777，然后用 bash 输出结果并核对';
    const out = cleanSessionTitle(raw, 20);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(21);
    expect(out).not.toMatch(/[\s，、。]$/u);
  });
  it('短标题不截断也不加省略号', () => {
    expect(cleanSessionTitle('部署脚本', 20)).toBe('部署脚本');
  });
  it('去掉宿主的悬空省略号', () => {
    expect(cleanSessionTitle('目标：写一篇 8000 字的详尽方案…')).toBe('写一篇 8000 字的详尽方案');
  });
  it('空 / null / 纯前缀 → 空串', () => {
    expect(cleanSessionTitle('')).toBe('');
    expect(cleanSessionTitle(null)).toBe('');
    expect(cleanSessionTitle('目标：')).toBe('');
  });
});

describe('sessionDisplayName', () => {
  it('空名走兜底', () => {
    expect(sessionDisplayName(undefined)).toBe('未命名会话');
    expect(sessionDisplayName('目标：', '新会话')).toBe('新会话');
  });
  it('正常名原样清洗后返回', () => {
    expect(sessionDisplayName('目标：部署脚本')).toBe('部署脚本');
  });
});
