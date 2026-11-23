/**
 * 子代理卡片的「下钻」视图：把 `spawn_subagent` 的结果翻成可展示的
 * 「它调了哪些工具 / 成功几次 / 失败几次」。
 *
 * 为什么单独抽：这是**纯数据整形 + 防御**（结果来自模型/工具，字段不保证存在），
 * 埋在 JSX 里既测不了，也容易在某个字段缺失时把整张卡片渲染崩。
 *
 * 边界：只展示子代理**内部的工具调用清单**，不展示它们的完整输出——
 * 父上下文不该被子代理的中间产物撑爆；要看细节属于另一个层级的评审。
 */

export interface SubagentInnerStep {
  tool: string;
  ok: boolean;
  ms: number | null;
}

export interface SubagentView {
  /** 子代理的最终回答摘要（可能为空串）。 */
  summary: string;
  steps: SubagentInnerStep[];
  okCount: number;
  failCount: number;
  /** 子代理总工具调用数（可能大于 steps.length，因为只保留了前 20 条）。 */
  totalCalls: number;
  /** 是否被截断（totalCalls > steps.length）。 */
  truncated: boolean;
}

const MAX_STEPS = 20;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * @param output `spawn_subagent` 工具调用返回的对象
 * @returns 可展示视图；既没摘要也没内部工具流时返回 null（界面不渲染空下钻区）
 */
export function buildSubagentView(output: unknown): SubagentView | null {
  if (!output || typeof output !== 'object') return null;
  const o = output as Record<string, unknown>;

  const summary = asString(o.summary).trim();

  const rawSteps = Array.isArray(o.innerSteps) ? o.innerSteps : [];
  const steps: SubagentInnerStep[] = [];
  for (const raw of rawSteps) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    steps.push({
      tool: asString(s.tool).trim() || 'tool',
      // 只有明确的 ok===false 才算失败；缺省按成功（与工具调用语义一致）
      ok: s.ok !== false,
      ms: typeof s.ms === 'number' && Number.isFinite(s.ms) ? s.ms : null,
    });
    if (steps.length >= MAX_STEPS) break;
  }

  if (!summary && steps.length === 0) return null;

  const okCount = steps.filter((s) => s.ok).length;
  const failCount = steps.length - okCount;
  const totalCalls = typeof o.toolCalls === 'number' && Number.isFinite(o.toolCalls)
    ? Math.max(steps.length, Math.trunc(o.toolCalls))
    : steps.length;

  return {
    summary,
    steps,
    okCount,
    failCount,
    totalCalls,
    truncated: totalCalls > steps.length,
  };
}
