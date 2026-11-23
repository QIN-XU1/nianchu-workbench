/**
 * 工具步骤的文本小工具（从 NianchuChat.tsx 抽出，供 ToolSteps 组件与导出共用）。
 */

export type ToolStep = {
  kind?: string;
  tool?: string;
  ok?: boolean;
  ms?: number;
  input?: unknown;
  output?: unknown;
};

/** 工具步骤的一行摘要：优先展示 path / command 这类最有信息量的参数 */
export function stepArgText(input?: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  // task 放最后：只有 spawn_subagent 这类「派活」工具才用它，它通常最长
  for (const k of ['path', 'filePath', 'command', 'pattern', 'query', 'url', 'name', 'task']) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) {
      const s = v.replace(/\s+/g, ' ').trim();
      return s.length > 60 ? s.slice(0, 60) + '…' : s;
    }
  }
  try {
    const s = JSON.stringify(input);
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  } catch { return ''; }
}

/** 工具输出预览（卡片展开后看） */
export function stepOutputText(output?: unknown): string {
  try {
    const s = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
    return String(s ?? '').slice(0, 1200);
  } catch { return ''; }
}

/**
 * 工具步骤的稳定 key（批次 Z.24）。
 *
 * 之前 ToolSteps 用**数组下标**当 key。步骤列表并不是只追加：
 * 补一条 todo_write、重跑一轮、子代理回填，都可能让前面的条目整体位移。
 * React 按位置复用 DOM，而 `<details>` 的展开态是 **DOM 状态**（不是受控属性）——
 * 用户点开第 2 条（bash），列表一变，展开框里就变成了 read 的内容，看着像串台。
 *
 * 所以 key 由**内容**决定：工具名 + 成败 + 耗时 + 参数摘要。
 * 同样的步骤出现多次时由调用方补一个序号（见 ToolSteps 里的 seen 计数）。
 */
export function stepKey(step: ToolStep): string {
  const tool = step.tool || 'tool';
  const ok = step.ok === false ? '0' : '1';
  const ms = typeof step.ms === 'number' ? String(step.ms) : '';
  return [tool, ok, ms, stepArgText(step.input)].join('|');
}
