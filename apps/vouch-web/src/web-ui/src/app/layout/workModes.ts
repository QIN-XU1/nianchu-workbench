/**
 * 批次 Z.28：工作方式（交互模式）的前端纯逻辑
 *
 * 对标依据：WorkBuddy 的 5 个 interactionmode、CodeBuddy 的问答/规划模式 ——
 * 每个模式 = **一份显式工具白名单**，界面上要能看见「这个模式到底能用什么」。
 *
 * 数据源只有宿主：`list_modes`（`tools/agent/modes.mjs`）。
 * 这个文件**不抄任何工具清单**，只做「模式 → 文案 / 占位符 / 工具提示」的纯映射，
 * 这样界面上的数字永远和宿主真实派发能力同源，也方便单测。
 */

export type WorkModeId = 'chat' | 'ask' | 'plan' | 'do';

export interface WorkModeInfo {
  id: string;
  label: string;
  desc: string;
  tools: string[];
  /** true = 清单是全量默认表（do），false/缺省 = 模式自己的固定清单 */
  openEnded?: boolean;
}

/** 按钮顺序：从「最不动」到「最能动」，风险递增，不按字母排 */
export const MODE_ORDER: WorkModeId[] = ['chat', 'ask', 'plan', 'do'];

export const MODE_LABELS: Record<WorkModeId, string> = {
  chat: '对话',
  ask: '只读',
  plan: '计划',
  do: '动手',
};

/** 每种模式的输入框提示：让用户一眼知道「我现在这样问，它会不会动我的文件」 */
export const MODE_PLACEHOLDERS: Record<WorkModeId, string> = {
  chat: '给念初发消息（@ 上下文，/ 技能指令）',
  ask: '只读提问：可以读文件/搜索，不会改任何东西',
  plan: '让它先出方案：只读 + 任务清单，不动文件',
  do: '让念初动手（可读写文件 / 执行命令）',
};

/**
 * 兜底：未知模式一律降到 `chat`（最保守），绝不降到 `do`。
 * 宿主那边对未知模式是 FAIL（不静默放行），前端这层只是防脏持久化值。
 */
export function normalizeWorkMode(id: unknown): WorkModeId {
  const key = typeof id === 'string' ? id.trim() : '';
  return (MODE_ORDER as string[]).includes(key) ? (key as WorkModeId) : 'chat';
}

/** 模式要不要走宿主 run_task（对话走的是纯对话通道，不带工具） */
export function modeUsesTools(mode: WorkModeId): boolean {
  return normalizeWorkMode(mode) !== 'chat';
}

/**
 * 工具提示文案：`8 项：read · glob · grep · …`
 * · 清单为空 → 「不调用工具」（对话模式的真实情况）
 * · 传 null（宿主没给 list_modes）→ 「工具清单不可用」，不编一个数字出来
 */
export function toolsHint(mode: WorkModeInfo | null | undefined, max = 3): string {
  if (!mode) return '工具清单不可用';
  const tools = Array.isArray(mode.tools) ? mode.tools.filter((t) => typeof t === 'string' && t) : [];
  if (!tools.length) return '不调用工具';
  const head = tools.slice(0, Math.max(1, max)).join(' · ');
  const more = tools.length > Math.max(1, max) ? ' · …' : '';
  return tools.length + ' 项：' + head + more;
}

/** 「本模式可用工具」的完整 title（鼠标悬停看全）：一行一个 */
export function toolsTitle(mode: WorkModeInfo | null | undefined): string {
  if (!mode) return '宿主没有返回工具清单（list_modes 不可用）';
  const tools = Array.isArray(mode.tools) ? mode.tools : [];
  if (!tools.length) return mode.label + '：不调用任何工具';
  return mode.label + '（' + tools.length + ' 项）\n' + tools.join('\n');
}

/** 从宿主返回的列表里挑出四种已知模式，按 MODE_ORDER 排序（多余/未知的丢掉） */
export function pickKnownModes(list: unknown): WorkModeInfo[] {
  const arr = Array.isArray(list) ? list : [];
  const byId = new Map<string, WorkModeInfo>();
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Partial<WorkModeInfo>;
    const id = typeof m.id === 'string' ? m.id.trim() : '';
    if (!(MODE_ORDER as string[]).includes(id) || byId.has(id)) continue;
    byId.set(id, {
      id,
      label: typeof m.label === 'string' && m.label ? m.label : MODE_LABELS[id as WorkModeId],
      desc: typeof m.desc === 'string' ? m.desc : '',
      tools: Array.isArray(m.tools) ? m.tools.filter((t): t is string => typeof t === 'string') : [],
      openEnded: m.openEnded === true,
    });
  }
  return MODE_ORDER.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
}
