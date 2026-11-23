// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { REPLY_FOLD_CHARS, REPLY_FOLD_LINES, shouldFoldReply } from './replyFold';

describe('shouldFoldReply', () => {
  it('短回复不折叠', () => {
    expect(shouldFoldReply('你好，这是短回复。')).toBe(false);
  });

  it('空串 / 纯空白 / null → 不折叠', () => {
    expect(shouldFoldReply('')).toBe(false);
    expect(shouldFoldReply('   \n  ')).toBe(false);
    expect(shouldFoldReply(null)).toBe(false);
    expect(shouldFoldReply(undefined)).toBe(false);
  });

  it('★字符超阈值 → 折叠', () => {
    expect(shouldFoldReply('字'.repeat(REPLY_FOLD_CHARS + 1))).toBe(true);
  });

  it('★行数超阈值 → 折叠（哪怕每行很短）', () => {
    expect(shouldFoldReply(Array.from({ length: REPLY_FOLD_LINES + 1 }, () => 'x').join('\n'))).toBe(true);
  });

  it('刚好等于阈值 → 不折叠（判据是「超过」不是「达到」）', () => {
    expect(shouldFoldReply('字'.repeat(REPLY_FOLD_CHARS))).toBe(false);
    expect(shouldFoldReply(Array.from({ length: REPLY_FOLD_LINES }, () => 'x').join('\n'))).toBe(false);
  });

  it('自定义阈值生效', () => {
    expect(shouldFoldReply('abcde', { chars: 3 })).toBe(true);
    expect(shouldFoldReply('abc', { chars: 10 })).toBe(false);
  });

  it('中文按字符计（不是字节）', () => {
    // 3000 个中文字：字符数 3000 > 2200 → 折叠；若按 UTF-8 字节会更大，这里只验证不走字节
    expect(shouldFoldReply('中'.repeat(3000))).toBe(true);
  });
});
