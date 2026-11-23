#!/usr/bin/env node
/**
 * 价格表 —— 从网关模型目录读真实单价，并做**冻结快照**。
 *
 * 从 `tools/cost/meter.mjs` 拆出（原文件 21.5KB 已接近 24KB 黄线，
 * 按 B4 体量纪律拆分；同时让「单价从哪来、怎么冻结」这一职责独立可测）。
 *
 * 核心规则（照搬 meter.mjs 原有语义，没改行为）：
 *   · 有 `pricing.prompt` / `pricing.completion` 才算有价
 *   · 无价的模型记 `null` —— **不许当成 0**（当成 0 会让成本看起来很低，是假绿）
 *   · 单价单位统一 `usd_per_token`
 *   · 快照带 at，用于「记录后价格变过」的复算比对
 */
import fs from 'node:fs';
import path from 'node:path';

export const GATEWAY = 'http://127.0.0.1:3425/v1/models';
export const UNIT = 'usd_per_token';

/**
 * 把网关返回的模型目录转成价格表。
 * @param {any} json 网关响应
 * @returns {{state:'PASS'|'UNKNOWN', table?:object, priced?:number, unpriced?:number, why?:string}}
 */
export function tableFromCatalog(json) {
  if (!json || typeof json !== 'object') return { state: 'UNKNOWN', why: '网关响应不是对象' };
  const list = json.data || json.models || [];
  if (!Array.isArray(list) || !list.length) return { state: 'UNKNOWN', why: '模型目录为空' };

  const table = {};
  let priced = 0;
  let unpriced = 0;
  for (const m of list) {
    if (!m || !m.id) continue;
    const p = m.pricing;
    if (!p || (p.prompt === undefined && p.completion === undefined)) {
      // 记下来但标为无价 —— 不许当成 0
      table[m.id] = null;
      unpriced++;
      continue;
    }
    // 【2026-11-18 修·审计员发现】原来用 Number(x) || 0：
    // pricing:{prompt:'abc'} 会被解析成 0 且计入 priced ⇒ 「解析失败」变成「免费模型」，
    // 正是本模块宣称要防的假绿，只是换了个入口。
    // 现在：任一单价字段存在但**解析不出有限数** ⇒ 整条记 null（无价），不许造 0。
    const nums = {
      prompt: p.prompt,
      completion: p.completion,
      cacheRead: p.input_cache_read,
      cacheWrite: p.input_cache_write,
    };
    let bad = false;
    for (const [k, raw] of Object.entries(nums)) {
      if (raw === undefined || raw === null) { nums[k] = 0; continue; }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) { bad = true; break; }
      nums[k] = n;
    }
    if (bad) {
      table[m.id] = null;   // 声明了价格但读不懂 ⇒ 与「无价」同处理，绝不记 0
      unpriced++;
      continue;
    }
    table[m.id] = { ...nums, unit: UNIT };
    priced++;
  }
  return { state: 'PASS', table, priced, unpriced };
}

/** 从网关拉取并落盘（带 at 快照时间） */
export async function syncFromGateway({ gateway = GATEWAY, outPath } = {}) {
  let res;
  try {
    res = await fetch(gateway, { signal: AbortSignal.timeout(8000) });
  } catch (e) {
    return { state: 'UNKNOWN', why: '网关不可达：' + String(e && e.message).slice(0, 80) };
  }
  if (!res.ok) return { state: 'UNKNOWN', why: '网关 HTTP ' + res.status };

  let json;
  try { json = await res.json(); } catch { return { state: 'UNKNOWN', why: '网关响应不是 JSON' }; }

  const t = tableFromCatalog(json);
  if (t.state !== 'PASS') return t;

  const doc = { what: '单价表（从网关模型目录同步）', at: new Date().toISOString(), unit: UNIT, table: t.table };
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  }
  return { state: 'PASS', priced: t.priced, unpriced: t.unpriced, at: doc.at };
}

/** 读已冻结的价格表 */
export function loadPrices(pricesPath) {
  try {
    const j = JSON.parse(fs.readFileSync(pricesPath, 'utf8'));
    return j && typeof j.table === 'object' ? j : null;
  } catch {
    return null;
  }
}

/**
 * 单条金额计算 —— 这是「成本可复算」的最小单元。
 * 无价 ⇒ 返回 null（**不是 0**），调用方必须区分「没花钱」与「不知道多少钱」。
 */
export function costOf(price, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = {}) {
  if (!price || price.unit !== UNIT) return null;
  const usd =
    input * price.prompt +
    output * price.completion +
    cacheRead * price.cacheRead +
    cacheWrite * price.cacheWrite;
  return Number.isFinite(usd) ? usd : null;
}
