#!/usr/bin/env node
/**
 * 从会话记录（JSONL）回算成本 —— 批量、可复算。
 *
 * 【为什么加】查 P1 差 3 倍时对比 ECC 的 `scripts/hooks/cost-tracker.js`：
 * 它能从会话 transcript 逐条累加 usage 并落 append-only 台账；
 * 我们只能手动 `record({input, output})` 一次一个，**没有「把历史会话一次性回算」的能力**。
 * 这是真实缺口，不是关键词差。
 *
 * ECC 踩过的坑，我们直接吸收（不重踩）：
 *   · 它 v1 期望 Stop 事件里带 usage/model，结果 **52 天 2340 行全是 0**（0% 非零 token 率）；
 *     修法是「读 transcript 文件」而不是读事件字段。
 *   · 「累积 vs 增量」必须分清：Stop 每条是**累积到该点**的会话总额，
 *     要 per-session 成本就取该 session 的最后一条，不是全部相加。
 *
 * 我们的记录形状（不假设对方形状，用宽松探测）：
 *   { type: 'assistant', message: { model, usage: { input_tokens, output_tokens, cache_* } } }
 *   { session_id, ts, cost_usd }  —— 若有宿主直报的权威金额，优先用它
 */
import fs from 'node:fs';
import path from 'node:path';

/** 宽松取 usage：不同来源字段名不同，都认 */
export function usageOf(obj) {
  const u = obj?.message?.usage ?? obj?.usage ?? null;
  if (!u) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const input = num(u.input_tokens ?? u.input ?? u.prompt_tokens);
  const output = num(u.output_tokens ?? u.output ?? u.completion_tokens);
  const cacheRead = num(u.cache_read_input_tokens ?? u.cacheRead ?? u.cache_read);
  const cacheWrite = num(u.cache_creation_input_tokens ?? u.cacheWrite ?? u.cache_write);
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) {
    // 全 0 是 ECC 那个坑的症状 —— 明确返回 null，不许当「真的用了 0」
    return null;
  }
  return { input, output, cacheRead, cacheWrite };
}

/** 宽松取 model：message.model 优先，其次顶层 model */
export function modelOf(obj) {
  const m = obj?.message?.model ?? obj?.model ?? null;
  return typeof m === 'string' && m ? m : null;
}

/**
 * 解析一份 JSONL。
 * @returns {{rows:Array, skipped:number, why:Array<string>}}
 *   rows: [{ sessionId, model, usage, ts, costUsd }]
 */
export function parseJsonl(text, { sessionIdHint = null } = {}) {
  const rows = [];
  const why = [];
  let skipped = 0;

  for (const line of String(text ?? '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { skipped++; continue; }

    const sessionId = obj?.session_id ?? obj?.sessionId ?? sessionIdHint;
    const ts = obj?.ts ?? obj?.at ?? obj?.timestamp ?? null;

    // 宿主直报的权威金额优先（有它就不用自己算）
    // 【2026-11-18 修】原守卫要求 obj.cost_usd !== undefined，而取值又用了 obj.cost.total_cost_usd
    // ⇒ 两者互斥，那个回退分支**永远走不到**（审计员实测该形状 → skipped:1）。
    const rawDirect = obj?.cost_usd ?? obj?.cost?.total_cost_usd;
    const direct = Number(rawDirect);
    if (rawDirect !== undefined && rawDirect !== null && Number.isFinite(direct) && direct >= 0) {
      rows.push({ sessionId, model: modelOf(obj), usage: usageOf(obj), ts, costUsd: direct, source: 'host-reported' });
      continue;
    }

    const usage = usageOf(obj);
    const model = modelOf(obj);
    if (!usage || !model) { skipped++; continue; }
    rows.push({ sessionId, model, usage, ts, costUsd: null, source: 'usage' });
  }

  if (skipped) why.push(skipped + ' 行没有可读的 model+usage（可能是用户消息或工具结果）');
  const zero = rows.filter((r) => !r.usage && r.costUsd === null);
  if (zero.length) why.push(zero.length + ' 条既无 usage 也无直报金额');
  return { rows, skipped, why };
}

/**
 * 按会话聚合。
 * 【关键】累积型记录（Stop 事件）每条是**累积到该点**，所以取每个 session 的最后一条；
 * 若判不出是不是累积型，用 `cumulative` 参数显式指定，不猜。
 */
export function aggregateBySession(rows, { cumulative = true } = {}) {
  const bySession = new Map();
  for (const r of rows) {
    const k = r.sessionId ?? '(unknown)';
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k).push(r);
  }
  const out = [];
  for (const [sessionId, list] of bySession) {
    const sorted = list.slice().sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
    if (cumulative) {
      // 取最后一条（累积值），而不是全部相加
      out.push({ sessionId, rows: sorted.length, take: sorted[sorted.length - 1] });   // take 含 costUsd
    } else {
      // 增量型：逐条相加
      const sum = sorted.reduce(
        (a, r) => ({
          input: a.input + (r.usage?.input ?? 0),
          output: a.output + (r.usage?.output ?? 0),
          cacheRead: a.cacheRead + (r.usage?.cacheRead ?? 0),
          cacheWrite: a.cacheWrite + (r.usage?.cacheWrite ?? 0),
        }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      );
      out.push({ sessionId, rows: sorted.length, take: { usage: sum, model: sorted[sorted.length - 1]?.model ?? null } });
    }
  }
  return out;
}

/** 从文件读 */
export function readJsonlFile(filePath, opts) {
  const text = fs.readFileSync(filePath, 'utf8');
  return parseJsonl(text, opts);
}

/**
 * 把一批会话回算成台账条目（交给 append-only 台账追加）。
 * 无价的模型 usd 记 null 并标 why —— 不许当 0。
 */
const UNIT = 'usd_per_token';

export function toLedgerRows(aggregated, priceTable) {
  const rows = [];
  for (const a of aggregated) {
    const model = a.take?.model ?? null;
    const usage = a.take?.usage ?? null;
    const price = model && priceTable ? priceTable[model] : null;
    let usd = null;
    let why = null;

    // 【2026-11-18 修·审计员发现】宿主直报的权威金额原来被解析后**从不使用**
    // （parseJsonl 标了 source:'host-reported'，但这里只读 usage）⇒ 现在优先用它。
    const hostUsd = Number(a.take?.costUsd);
    if (a.take?.costUsd !== undefined && a.take?.costUsd !== null && Number.isFinite(hostUsd) && hostUsd >= 0) {
      usd = hostUsd;
    } else if (!model) why = '记录里没有模型名，无法定价';
    else if (!usage) why = '记录里没有可读 usage';
    else if (!price) why = '该模型在价格表里无价';
    // 【2026-11-18 修·审计员发现】原实现自己重写了一遍乘法，**绕过了 costOf 的单位校验**：
    // per-million 价格会被当成 per-token，放大 10⁶ 倍。现在必须过 unit 这一关。
    else if (price.unit !== UNIT) why = '单价单位不是 ' + UNIT + '（是 ' + String(price.unit) + '），不能当美元算';
    // 负数 token 会让金额变负（等于「赚了钱」），拒绝
    else if ([usage.input, usage.output, usage.cacheRead, usage.cacheWrite].some((v) => Number(v) < 0)) {
      why = 'token 数不能为负';
    } else {
      usd =
        (usage.input ?? 0) * (price.prompt ?? 0) +
        (usage.output ?? 0) * (price.completion ?? 0) +
        (usage.cacheRead ?? 0) * (price.cacheRead ?? 0) +
        (usage.cacheWrite ?? 0) * (price.cacheWrite ?? 0);
      if (!Number.isFinite(usd)) { usd = null; why = '算出的金额非有限数'; }
    }
    rows.push({
      kind: 'cost-replay',
      sessionId: a.sessionId,
      model,
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      value: usd,
      why,
      rowsSeen: a.rows,
    });
  }
  return rows;
}
