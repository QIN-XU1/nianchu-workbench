/**
 * 会话标题清洗（对标 Claude 的自动会话名）。
 *
 * 为什么需要：本机历史里的会话名直接取「首条消息前 40 字」，于是满屏都是
 * 「目标：…」「总目标：…」「请…」这种前缀，且常被截断在半个词上；
 * 列表里一行行读下来全是噪声。这里做**纯展示层**清洗：
 *   1. 去掉「目标/总目标/请/帮我」这类指令式前缀；
 *   2. 合并空白、去掉末尾的省略号与被截断的半个英文单词；
 *   3. 超过 maxChars 时按「词边界」截断并补 …。
 * 不改宿主存的 sessionName（重命名仍以用户输入为准）。
 */

const PREFIX_RE = /^(?:总目标|目标|子目标|请(?:你)?(?:只)?(?:帮我)?|帮我|麻烦你?)[：:，,。\s]*/u;

/** 清洗一条会话名；返回空串表示「没有可用名字」（由调用方兜底）。 */
export function cleanSessionTitle(raw: string | undefined | null, maxChars = 28): string {
  if (!raw) return '';
  let s = String(raw).replace(/\s+/gu, ' ').trim();
  s = s.replace(PREFIX_RE, '');
  // 宿主按字符截断后常留一个「…」或半个英文词，去掉悬空的标点
  s = s.replace(/[.．。…,，、;；:：]+$/u, '');
  if (s.length <= maxChars) return s;
  const head = s.slice(0, maxChars + 1);
  const cut = Math.max(head.lastIndexOf(' '), head.lastIndexOf('，'), head.lastIndexOf('、'), head.lastIndexOf('。'));
  const base = cut > maxChars * 0.6 ? s.slice(0, cut) : s.slice(0, maxChars);
  return `${base.replace(/[\s.．。…,，、;；:：]+$/u, '')}…`;
}

/** 列表里展示的名字：清洗后为空则用兜底文案。 */
export function sessionDisplayName(raw: string | undefined | null, fallback = '未命名会话'): string {
  return cleanSessionTitle(raw) || fallback;
}
