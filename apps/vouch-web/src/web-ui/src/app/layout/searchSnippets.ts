/**
 * 会话搜索的「命中片段」（批次 Z.15，对标 Claude 的搜索下拉 + 高亮）。
 *
 * 现状只有「第 3/12 条」和滚动定位，用户不知道命中在哪句话里。
 * 这里为每条命中的消息抽一段上下文（默认前后各 24 字），供下拉列表逐条展示并高亮。
 * 纯函数：大小写不敏感、只取每条的**第一处**命中、超长两侧补「…」。
 */

export type SearchSnippet = {
  /** 消息在 msgs 里的下标（用来跳到对应消息）。 */
  msgIndex: number;
  role: string;
  before: string;
  match: string;
  after: string;
};

export type SnippetOptions = { radius?: number; limit?: number };

export function extractSnippets(
  messages: ReadonlyArray<{ content?: string; role?: string }> | null | undefined,
  query: string,
  options: SnippetOptions = {},
): SearchSnippet[] {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const radius = Math.max(0, options.radius ?? 24);
  const limit = Math.max(1, options.limit ?? 5);
  const out: SearchSnippet[] = [];
  const list = Array.isArray(messages) ? messages : [];
  for (let i = 0; i < list.length && out.length < limit; i += 1) {
    const content = String(list[i]?.content || '');
    const at = content.toLowerCase().indexOf(q);
    if (at < 0) continue;
    const start = Math.max(0, at - radius);
    const end = Math.min(content.length, at + q.length + radius);
    const before = content.slice(start, at);
    const after = content.slice(at + q.length, end);
    out.push({
      msgIndex: i,
      role: list[i]?.role || 'assistant',
      before: (start > 0 ? '…' : '') + before,
      match: content.slice(at, at + q.length),
      after: after + (end < content.length ? '…' : ''),
    });
  }
  return out;
}

/**
 * 当前选中的那条命中，换算到 **msgs 坐标** 后的下标（批次 Z.19）。
 *
 * 【为什么必须抽成函数】搜索界面有两套坐标，之前混在一起比：
 *  - `searchMatches`：**命中消息**在 `msgs` 里的下标（如 `[5, 7]`）
 *  - `searchIdx`：**命中列表**里的第几个（0、1…）
 * 片段列表、消息列表都按 `msgs` 下标对齐，所以「当前项」必须从后者换算回前者。
 * 之前组件里写的是 `activeMatch === sn.msgIndex`：两边都是数字，一旦
 * 「第 5 条消息才是第一次命中」，标记就落到错误的片段上，而界面上
 * 「选中第 2 条、计数 2/6」看起来一切正常 —— 错的只是**哪个被选中**，没人会去对坐标。
 * 所以换算只允许经过这里，单测才能守住它。
 *
 * @returns 当前命中在 `msgs` 里的下标；没有命中（空表）返回 -1（**不做任何猜测**）
 */
export function activeResultMsgIndex(
  searchMatches: ReadonlyArray<number> | null | undefined,
  searchIdx: number | null | undefined,
): number {
  if (!Array.isArray(searchMatches) || searchMatches.length === 0) return -1;
  const raw = Number(searchIdx);
  const at = Math.min(Math.max(0, Math.floor(Number.isFinite(raw) ? raw : 0)), searchMatches.length - 1);
  return searchMatches[at];
}
