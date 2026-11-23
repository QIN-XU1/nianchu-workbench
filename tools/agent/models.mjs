#!/usr/bin/env node
/**
 * 念初 · 模型路由（A14 多模型供应商 + 故障转移链）
 *
 * ══ 现状与差距 ═══════════════════════════════════════════════
 * 我们的网关（127.0.0.1:3425）实测暴露 853 个模型，但代码里只有**一个** DEFAULT_MODEL：
 *   · 换模型要改代码/改环境变量，不能按用途选（规划用一个、实现用另一个）
 *   · 主模型挂了就整个失败，没有备用链（实测网关会瞬时 401/5xx）
 * 矩阵里 A14 我们是「部分」，dsh 是「有」。
 *
 * ══ 这里补什么 ═══════════════════════════════════════════════
 *   ① 模型注册表：按用途（role）登记候选，如 plan / code / cheap
 *   ② 故障转移链：按顺序试，第一个成功的胜出；全部失败才 FAIL
 *   ③ 每次尝试都记录（model / 是否成功 / 原因 / 耗时），可审计
 *
 * ══ 诚实边界 ═════════════════════════════════════════════════
 * · 只做**顺序故障转移**，不是负载均衡/并发竞速（竞速更贵且难判断）。
 * · 没有成本/延迟感知路由（需要历史统计，未做）。
 * · 注册表来自环境变量与默认值，没有持久化配置界面。
 */
import { callModel, DEFAULT_MODEL, GATEWAY } from './runtime.mjs';

/**
 * 默认注册表：按用途给候选链。可用 NIANCHU_MODELS_JSON 覆盖（整体替换）。
 *
 * **必须是函数而不是常量**：runtime.mjs ↔ models.mjs 是循环依赖，
 * 若在模块顶层直接读 DEFAULT_MODEL，而 runtime 还没初始化完，会抛
 * 「Cannot access 'DEFAULT_MODEL' before initialization」（TDZ）。
 * 改成调用时才取值，模块加载顺序就不再重要。
 */
export function defaultRegistry() {
  return {
    /**
     * ⚠ 2026-11-19 实测踩到的坑：`claude-3-5-haiku-20241022` 能对话但**不支持工具调用**，
     * 网关直接回 400 `model_not_supported`（"GitHub Copilot: The requested model is not supported"）。
     * 把它当备用放进 default 链，会让**带工具的 agent 循环**在首模型抖动时整轮失败 ——
     * 故障转移反而变成了故障来源。
     *
     * 所以注册表按「用途」分开：需要工具的场景（tool / agent）只用支持 function calling 的模型。
     * 这不是配置细节，是**契约**：链里的每个候选都必须满足该用途的最低能力。
     */
    default: [DEFAULT_MODEL],
    plan: [DEFAULT_MODEL],
    cheap: [DEFAULT_MODEL],
    // 需要 function calling 的用途：只用实测支持工具的模型
    tool: [DEFAULT_MODEL],
    agent: [DEFAULT_MODEL],
  };
}

/** 哪些用途**必须**支持工具调用 */
export const TOOL_CAPABLE_ROLES = new Set(['tool', 'agent']);

/** 读注册表（环境变量可整体覆盖） */
export function getRegistry() {
  const raw = process.env.NIANCHU_MODELS_JSON;
  if (raw) {
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object') return j;
    } catch { /* 解析失败就用默认，不崩 */ }
  }
  return defaultRegistry();
}

/** 取某个用途的候选链（未知用途回落到 default） */
export function resolveChain(role = 'default') {
  const reg = getRegistry();
  const chain = Array.isArray(reg[role]) ? reg[role] : reg.default;
  return (Array.isArray(chain) ? chain : []).filter((x) => typeof x === 'string' && x.trim());
}

/**
 * 带故障转移的模型调用。
 *
 * @returns {{state, content?, model?, usage?, attempts:Array, servedBy?:string, reason?}}
 */
export async function callWithFailover({
  messages, role = 'default', chain, maxTokens = 1200, signal,
} = {}) {
  const models = (Array.isArray(chain) && chain.length ? chain : resolveChain(role))
    .filter((x) => typeof x === 'string' && x.trim());

  if (models.length === 0) {
    return { state: 'FAIL', reason: '没有可用模型（候选链为空）', attempts: [] };
  }

  const attempts = [];
  let lastReason = null;

  for (const model of models) {
    // 已被用户停止：别再换下一个模型继续烧 token
    if (signal?.aborted) {
      return { state: 'ABORTED', reason: '用户已停止生成', attempts };
    }
    const t0 = Date.now();
    const r = await callModel({ messages, model, maxTokens, signal });
    if (signal?.aborted) {
      return { state: 'ABORTED', reason: '用户已停止生成', attempts };
    }
    const ms = Date.now() - t0;
    attempts.push({
      model, ok: r.state === 'PASS', state: r.state, ms,
      reason: r.state === 'PASS' ? null : String(r.reason || '').slice(0, 200),
    });
    if (r.state === 'PASS') {
      return {
        state: 'PASS',
        content: r.content,
        model: r.model || model,
        usage: r.usage ?? null,
        servedBy: model,
        attempts,
        // 说明这是第几个候选生效的（0 = 首选可用；>0 = 前面挂了，用到备用）
        failoverIndex: attempts.length - 1,
        truncated: r.truncated === true,
        finishReason: r.finishReason ?? null,
      };
    }
    lastReason = r.reason || r.state;
  }

  return {
    state: 'FAIL',
    reason: '所有候选模型都失败（' + models.length + ' 个）：' + String(lastReason).slice(0, 200),
    attempts,
  };
}

/** 给界面/审计看的注册表摘要 */
export function registrySummary() {
  const reg = getRegistry();
  return Object.entries(reg).map(([role, chain]) => ({
    role,
    chain: Array.isArray(chain) ? chain : [],
    count: Array.isArray(chain) ? chain.length : 0,
  }));
}

/** 网关可用模型数（探测用；失败返回 null，不假装 0） */
export async function gatewayModelCount() {
  try {
    const base = GATEWAY.replace(/\/chat\/completions.*$/, '');
    const r = await fetch(base + '/models', { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j.data) ? j.data.length : null;
  } catch {
    return null;
  }
}