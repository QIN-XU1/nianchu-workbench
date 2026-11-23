#!/usr/bin/env node
/**
 * 批次 Z.28：工作方式（交互模式）宿主方法
 *
 * 为什么单独一个文件：ws-host.mjs 已经贴着 32KB 红线（体量纪律见
 * tools/quality/size-guard.mjs），而「模式 → 工具白名单」的解析逻辑也不该
 * 埋在 RPC 大表里 —— 它要被 verify 脚本和单测直接调用。
 *
 * 数据源只有一份：`tools/agent/modes.mjs`。这里只做两件事：
 *   ① 把模式表暴露成 `list_modes`（前端显示「本模式可用工具」）；
 *   ② 把 run_task 的 `mode`/`tools` 解析成**一份**白名单（mode 优先）。
 */
import { describeAllModes, modeById, modeTools, MODE_IDS } from '../agent/modes.mjs';

/**
 * 解析一次运行实际使用的工具白名单。
 * @returns {{ mode: string|null, tools: string[]|undefined, error: string|null }}
 *
 * 语义（与 WorkBuddy 的 interactionmode 对齐）：
 *   · 给了 mode 且认得 → 用模式表，**忽略** req.tools（否则「模式说只读、tools 传全量」会打架）；
 *   · 给了 mode 但不认得 → error（不静默回落成全量：拼错模式变成全权限是最坏的降级方向）；
 *   · 没给 mode → 沿用显式 tools（老调用方不受影响）。
 */
export function resolveRunMode(req = {}) {
  const rawMode = req.mode == null ? '' : String(req.mode).trim();
  if (!rawMode) {
    const tools = Array.isArray(req.tools) && req.tools.length ? req.tools : undefined;
    return { mode: null, tools, error: null };
  }
  const m = modeById(rawMode);
  if (!m) {
    return {
      mode: null,
      tools: undefined,
      error: '未知的工作方式：' + rawMode + '（可选：' + MODE_IDS.join(' / ') + '），请切换后重试',
    };
  }
  return { mode: m.id, tools: modeTools(m.id) || undefined, error: null };
}

/** 宿主方法：list_modes（前端点开「本模式可用工具」时拉一次） */
export function workModeMethods() {
  return {
    list_modes: () => describeAllModes(),
  };
}
