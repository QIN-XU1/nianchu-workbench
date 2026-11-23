/**
 * 上下文用量网格的纯计算。
 *
 * 为什么单独拎出来：这些数字不是渲染细节，而是**产品规则** ——
 * 「20 格」「70% 转黄」「90% 转红」「用了就至少亮一格」。
 * 埋在 JSX 里就没法测，改一个常量会静默变成
 * 「已经用满了还显示宽裕」。放到这里，`contextUsageView.test.ts` 会把它们钉死。
 */
/** 宿主随助手消息落盘的上下文用量（字段都可缺失，按脏数据防御）。 */
export interface MessageContextUsage {
  historyTokens?: number;
  historyBudget?: number;
  historyDropped?: number;
}

/** 网格总格数（2 行 × 10 列）。 */
export const CTX_CELLS = 20;

/** 偏紧阈值：到这个比例转黄。 */
export const CTX_WARN_RATIO = 0.7;
/** 挤压阈值：到这个比例转红。 */
export const CTX_DANGER_RATIO = 0.9;

export interface ContextUsage {
  /** 最近一轮装配实际占用的 history token 数 */
  tokens: number;
  /** 本轮装配的 history 预算（> 0） */
  budget: number;
  /** 为塞进预算而省略的较早消息条数 */
  dropped: number;
}

export type ContextLevel = 'ok' | 'warn' | 'danger';

export interface ContextUsageView {
  usage: ContextUsage;
  /** 占用比例，0..1，已 clamp */
  ratio: number;
  /** 点亮格数，0..CTX_CELLS */
  lit: number;
  level: ContextLevel;
}

/**
 * 取**最近一条**带有效 context 的助手消息 —— 即最近一轮真实的装配结果。
 *
 * 没有就返回 null：宁可不渲染，也不显示一个「0 / 6,000」的进度条假装在监控。
 * 这里对脏数据是防御式的（NaN / 负预算 / 非数字一律跳过），
 * 因为 context 来自服务端持久化的 JSON，不保证类型正确。
 */
export function resolveContextUsage(
  messages: ReadonlyArray<{ context?: MessageContextUsage | null | undefined }>,
): ContextUsage | null {
  for (let k = messages.length - 1; k >= 0; k--) {
    const c = messages[k]?.context;
    if (!c) continue;

    const tokens = c.historyTokens;
    const budget = c.historyBudget;
    if (typeof tokens !== 'number' || typeof budget !== 'number') continue;
    if (!Number.isFinite(tokens) || !Number.isFinite(budget)) continue;
    if (!(budget > 0)) continue;

    return {
      tokens: Math.max(0, tokens),
      budget,
      dropped: Math.max(0, Math.trunc(Number(c.historyDropped) || 0)),
    };
  }
  return null;
}

export function buildContextUsageView(usage: ContextUsage | null): ContextUsageView | null {
  if (!usage) return null;

  const ratio = Math.min(1, Math.max(0, usage.tokens / usage.budget));

  // 向下取整会让「刚过 1%」看起来像 0 格（等于没显示），
  // 所以只要真的用了就至少亮 1 格；0 token 才允许全灭。
  const lit =
    usage.tokens <= 0
      ? 0
      : Math.min(CTX_CELLS, Math.max(1, Math.round(ratio * CTX_CELLS)));

  const level: ContextLevel =
    ratio >= CTX_DANGER_RATIO ? 'danger' : ratio >= CTX_WARN_RATIO ? 'warn' : 'ok';

  return { usage, ratio, lit, level };
}

/** 千分位。中文界面里 token 数仍按 en-US 分组（与各家 agent 一致）。 */
export const formatTokens = (n: number): string => n.toLocaleString('en-US');

/** 圆角百分比，用于 aria-label —— 读屏用户只需要一个可比较的数。 */
export const formatPercent = (ratio: number): number => Math.round(ratio * 100);

/** 省略提示文案；没有省略时返回空串。 */
export function formatDropped(dropped: number): string {
  return dropped > 0 ? ` · 省略 ${dropped} 条` : '';
}

/* ────────────────────────── 记忆命中 ──────────────────────────
 * 宿主在装配上下文时会从**跨会话记忆**里按词法召回若干条（`tools/agent/context.mjs` 的
 * `recallMemory`），并把命中的 key/预览随 context 一起落盘。这里只做「看得见」：
 * 让用户知道「这一轮回答用到的是哪几条记忆」，而不是黑箱。
 *
 * 边界：召回是**词法**匹配（中文 bigram + 英文词），不是语义检索；命中了不等于「用对了」。
 * 所以界面只陈述「命中了哪些」，不给「相关度」这种会误导的分数。
 */

/** 明细最多展示几条（与宿主落盘上限一致）。 */
export const MEMORY_VIEW_MAX = 6;

export interface MemoryHitItem {
  key: string;
  preview: string;
}

export interface MemoryView {
  /** 本轮命中条数（宿主落盘的真实数，可大于 items.length）。 */
  count: number;
  /** 可展示的明细（旧数据可能没有明细）。 */
  items: MemoryHitItem[];
  /** 明细是否被截断（count 大于已落盘明细数时为 true，界面要如实说）。 */
  truncated: boolean;
}

type ContextWithMemory = MessageContextUsage & {
  memoryHits?: number;
  memoryHitItems?: Array<{ key?: unknown; preview?: unknown }> | null;
};

/**
 * 取最近一条带 memoryHits 的 context，翻成可展示的「记忆命中」。
 *
 * 返回 null = 没有可展示的信息（老消息、非装配回合），**界面就不渲染这一块**，
 * 而不是显示「命中 0 条」这种看起来像监控、其实没有数据源的假面板。
 */
export function resolveMemoryView(
  messages: ReadonlyArray<{ context?: ContextWithMemory | null | undefined }>,
): MemoryView | null {
  for (let k = messages.length - 1; k >= 0; k--) {
    const c = messages[k]?.context;
    if (!c || typeof c.memoryHits !== 'number' || !Number.isFinite(c.memoryHits)) continue;

    const count = Math.max(0, Math.trunc(c.memoryHits));
    const rawItems = Array.isArray(c.memoryHitItems) ? c.memoryHitItems : [];
    const items: MemoryHitItem[] = [];
    for (const it of rawItems) {
      if (!it || typeof it.key !== 'string' || !it.key.trim()) continue;
      const preview = typeof it.preview === 'string' ? it.preview.trim() : '';
      items.push({ key: it.key.trim(), preview: preview.slice(0, 80) });
      if (items.length >= MEMORY_VIEW_MAX) break;
    }
    return {
      count,
      items,
      // count 比明细多 → 一定有没展示出来的（老数据没落明细也算「说清了」用 truncated 表达）
      truncated: count > items.length,
    };
  }
  return null;
}

