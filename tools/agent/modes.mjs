/**
 * 工作方式（批次 Z.28）= 显式工具白名单
 *
 * 对标依据（不是拍脑袋）：
 *   · WorkBuddy 的 `interactionmode/<mode>/fragments/interaction.md`：5 个交互模式，
 *     每个模式就是一份**显式工具清单**（ask 只读 6 项 / craft 37 项 / expert 39 项）；
 *   · CodeBuddy CN：问答 / 代码 / 规划 / 自动 / 思考 —— 模式即能力边界。
 *
 * 因此这里只做一件事：**模式 → 工具名清单**。
 * 唯一的执行点也不在这里，而在 `loop.mjs` 的派发处（白名单外的调用不落地，
 * 见文件注释的「白名单要在派发处生效」）。本模块是纯数据 + 纯函数，可被
 * 宿主 / 前端校验脚本 / 单测直接 import，不碰文件系统、不碰网络。
 */

/**
 * 「动手」用的默认全量表 —— 与 `loop.mjs` 的默认参数是**同一份**（loop 从这里 import），
 * 界面上的「本模式可用工具」也就不会和真实派发能力对不上。
 */
export const DEFAULT_TOOLS = [
  'read', 'write', 'edit', 'apply_patch', 'bash', 'glob', 'grep',
  'web_search', 'web_fetch', 'read_image', 'load_skill', 'todo_write', 'spawn_subagent',
];

/** 'do' 的 tools 用 null 表示「宿主的默认全量表」，避免这里再抄一份清单 */
export const MODES = [
  {
    id: 'chat',
    label: '对话',
    desc: '只用模型回答，不给任何工具',
    tools: [],
  },
  {
    id: 'ask',
    label: '只读',
    desc: '能读文件、搜索、联网；不能写文件、不能执行命令',
    tools: ['read', 'glob', 'grep', 'recall', 'read_image', 'web_fetch', 'web_search', 'load_skill'],
  },
  {
    id: 'plan',
    label: '计划',
    desc: '只读 + todo_write：先出方案和任务清单，不动文件',
    tools: ['read', 'glob', 'grep', 'recall', 'read_image', 'web_fetch', 'web_search', 'load_skill', 'todo_write'],
  },
  {
    id: 'do',
    label: '动手',
    desc: '全部工具：读写文件、执行命令、派子代理',
    tools: null,
  },
];

export const MODE_IDS = MODES.map((m) => m.id);

export const DEFAULT_MODE = 'chat';

/**
 * 按 id 取模式；未知 id 返回 null（由调用方决定是报错还是回落）。
 * 不做「静默当成 do」—— 那会把一个拼错的模式变成全量权限，是最坏的降级方向。
 */
export function modeById(id) {
  const key = String(id ?? '').trim();
  if (!key) return null;
  return MODES.find((m) => m.id === key) || null;
}

/**
 * 模式 → 工具清单。返回 null 表示「不额外限制，用调用方默认表」（只有 do）。
 * 未知模式抛错而不是返回 null：调用方必须看见「模式名不认得」。
 */
export function modeTools(id) {
  const m = modeById(id);
  if (!m) throw new Error('未知的工作方式：' + String(id) + '（可选：' + MODE_IDS.join(' / ') + '）');
  return m.tools ? m.tools.slice() : null;
}

/**
 * 给前端用的模式描述：把 do 的 null 展开成真实清单（调用方传 defaultTools）。
 * 返回 { id, label, desc, tools: string[], openEnded: boolean }
 */
export function describeMode(id, defaultTools = DEFAULT_TOOLS) {
  const m = modeById(id);
  if (!m) return null;
  const openEnded = m.tools === null;
  return {
    id: m.id,
    label: m.label,
    desc: m.desc,
    tools: openEnded ? defaultTools.slice() : m.tools.slice(),
    openEnded,
  };
}

/** 全部模式描述（list_modes 的返回体） */
export function describeAllModes(defaultTools = DEFAULT_TOOLS) {
  return MODES.map((m) => describeMode(m.id, defaultTools));
}
