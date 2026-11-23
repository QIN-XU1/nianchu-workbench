#!/usr/bin/env node
/**
 * 可执行对照的探测器定义 —— 「量什么」。
 *
 * 从 executable-compare.mjs 拆出（原文件涨到 33.5KB 超 32KB 红线）。
 * 拆分理由：「量什么」与「怎么量」是两个职责，混在一起既超体量又难校。
 *
 * 每个探测器 = 一个正则 + 可选的上下文要求 + 一句「为什么这算有这个能力」。
 * ⚠ 这把尺子会误判，必须持续校：
 *   · P1 曾把网页文案里的 "pricing" 区块名当成成本核算（2026-11-18 已收紧）
 *   · 每千文件命中率测的是「能力散布在多少个文件里」，不是「能力有多强」
 */

export const PROBES = [
  {
    id: 'P1',
    name: '成本核算',
    strength: 'soft',
    // 【2026-11-18 修假阳性】原来只要求 pricing 等裸词 + 同文件出现 model/token 就算命中。
    // 实测 open-design 被判「最强 15.38」，但它的命中是：
    //   brands/engine/kit.ts:1108  body: "Marketing blocks (testimonials, pricing, stats)..."
    //   media/vela.ts:299          * pricing decision: the model's own default tier...
    // 那是营销落地页的 section 名与注释，不是 LLM token 成本核算。
    // 现在要求命中必须带**成本形态**：结构化 price 字段（pricing: { / pricing. / price_per）
    // 或明确计算式（cost_usd / token_cost / usd_per）。裸词 pricing 单独出现不算。
    re: /\b(price_per|input_cost|output_cost|cost_per|usd_per|token_cost|cost_usd|prompt_price|completion_price)\b|\bpricing\s*[:=]\s*\{|\bpricing\.[a-z]|\bprice\s*[:=]\s*\{/i,
    withContext: /\b(token|llm|model|completion|prompt|usage)\b/i,
    why: '有结构化价格字段或成本计算式（排除网页文案里的 pricing 区块名）',
  },
  {
    id: 'P2',
    name: '记忆老化（TTL）',
    strength: 'hard',
    re: /\b(expiresAt|expires_at|timeToLive|maxAge|expiry)\b/,
    withContext: /\b(memory|memories|记忆|fact|facts|knowledge|recall)\b/i,
    why: '记忆有到期/TTL 概念（要求文件含 memory 上下文，排除 HTTP 缓存 TTL）',
  },
  {
    id: 'P3',
    name: '第三态 UNKNOWN',
    strength: 'hard',
    re: /\b(UNKNOWN|UNDECIDABLE|INDETERMINATE)\b/,
    withContext: /\b(verify|check|audit|assert|verdict|state|status)\b/i,
    why: '有「判不了」这个状态',
  },
  {
    id: 'P4',
    name: '检查脚本带退出码',
    strength: 'weak',
    re: /process\.exit\(\s*[1-9]/,
    why: '检查脚本会在失败时返回非 0（能当门禁）',
    // 【2026-11-17】有效性弱：量仓库构成非能力（我们 85.8% 命中来自 vendored/归档）
    validity: 'weak',
    validityNote: '量仓库构成非能力；11.6% vs 12.4% 是噪音级，不构成能力差距',
  },
  {
    id: 'P5',
    name: '改进前后度量',
    strength: 'soft',
    re: /\b(baseline|before_after|beforeAfter|improvement_delta|regression_ratio)\b/i,
    withContext: /\b(metric|measure|score|recall|accuracy|improv)\b/i,
    why: '有基线/前后对比概念',
  },
  {
    id: 'P6',
    name: '记忆冲突/推翻',
    strength: 'hard',
    // 【修正】不再用通用的 supersede/invalidate。
    // 只认**记忆治理专用**的标识：supersededBy 字段、conflictGroup、contradict（矛盾）
    re: /\b(supersededBy|superseded_by|conflictGroup|conflict_group|contradict(?:ion|s|ory)?)\b/i,
    withContext: /\b(memory|memories|记忆|fact|facts|belief|knowledge)\b/i,
    why: '记忆有「被谁推翻」/冲突组/矛盾检测（专用标识，不用通用 invalidate）',
  },
  {
    id: 'P7',
    name: '成本冻结/快照',
    strength: 'soft',
    re: /\b(frozenPrice|priceSnapshot|price_snapshot|frozen_price|rate_lock)\b/i,
    why: '历史成本不随价格变化重算',
  },
  {
    id: 'P8',
    name: '审计留痕（append-only）',
    strength: 'soft',
    re: /\b(append_only|appendOnly|append-only|audit_log|auditLog)\b/i,
    why: '有只追加的台账/审计日志',
  },
  {
    id: 'P99',
    name: '【负对照】无意义 token',
    strength: 'hard',
    re: /\b(zxqvblorp|quuxly_frobnicate)\b/,
    why: '**应当 0 命中** —— 证明扫描器不是什么都匹配',
  },
]
