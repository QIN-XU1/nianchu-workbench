/**
 * 长回复折叠的判定（纯函数）。
 *
 * 为什么需要：念初的助手消息里会出现几千字的长回答（实测有一条 3435px 高），
 * 一屏根本放不下，用户只能一路滚。折叠成「先看开头 + 展开全文」是 Claude/ChatGPT 的常见做法。
 *
 * 只对**已经结束生成**的消息折叠——流式生成中途折叠会把正在长出来的内容藏起来，反而更差
 * （这一条在调用方用 `m.state !== 'RUNNING'` 保证）。
 */

/** 超过这么多字符就算长回复。 */
export const REPLY_FOLD_CHARS = 2200;
/** 或超过这么多行也算长回复（有的回答行多但每行短）。 */
export const REPLY_FOLD_LINES = 45;

export interface FoldOptions {
  chars?: number;
  lines?: number;
}

/**
 * 是否需要折叠。
 *
 * @param content 消息正文（Markdown 原文；这里只按字符/行数粗判，不解析 Markdown）
 * @returns true 表示「值得折叠」
 */
export function shouldFoldReply(content: unknown, options: FoldOptions = {}): boolean {
  const text = typeof content === 'string' ? content : '';
  if (!text.trim()) return false;
  const charLimit = options.chars ?? REPLY_FOLD_CHARS;
  const lineLimit = options.lines ?? REPLY_FOLD_LINES;
  if (text.length > charLimit) return true;
  return text.split('\n').length > lineLimit;
}
