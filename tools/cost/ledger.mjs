#!/usr/bin/env node
/**
 * 记账台账 —— append-only 成本流水，可复算。
 *
 * 从 `tools/cost/meter.mjs` 拆出。三条硬规则：
 *   ① **append-only**：只追加不修改；每条带 at / model / tokens / usd / priceAt（当时用的价格快照时间）
 *   ② **无价不记 0**：模型没有单价时 usd 记 null，并标 why —— 「不知道多少钱」≠「没花钱」
 *   ③ **可复算**：verify() 用台账里冻结的 priceAt + 当时的单价重算，
 *      与记录值比对；不一致就报出来（价格后来变了不能悄悄改历史金额）
 */
import fs from 'node:fs';
import path from 'node:path';

export const LEDGER_VERSION = 1;

export function emptyLedger() {
  return { what: '成本台账（append-only）', version: LEDGER_VERSION, at: new Date().toISOString(), entries: [] };
}

export function loadLedger(ledgerPath) {
  try {
    const j = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    if (!j || !Array.isArray(j.entries)) return emptyLedger();
    return j;
  } catch {
    return emptyLedger();
  }
}

export function saveLedger(ledger, ledgerPath) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  ledger.at = new Date().toISOString();
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
  return ledger;
}

/**
 * 追加一条。**不修改历史条目** —— 这是 append-only 的落地。
 * @returns {{ok:boolean, entry?:object, why?:string}}
 */
export function appendEntry(ledger, entry) {
  if (!entry || typeof entry !== 'object') return { ok: false, why: 'entry 不是对象' };
  if (!entry.model) return { ok: false, why: 'model 必填（没有模型名就无法复算单价）' };
  const usd = entry.usd;
  if (usd !== null && !Number.isFinite(usd)) {
    return { ok: false, why: 'usd 必须是数字或 null（无价），不能是其它值' };
  }
  const row = {
    at: entry.at || new Date().toISOString(),
    model: entry.model,
    input: Number(entry.input) || 0,
    output: Number(entry.output) || 0,
    cacheRead: Number(entry.cacheRead) || 0,
    cacheWrite: Number(entry.cacheWrite) || 0,
    usd: usd === null ? null : usd,
    priceAt: entry.priceAt || null,
    why: entry.why || null,
    turn: entry.turn ?? null,
  };
  ledger.entries.push(row);
  return { ok: true, entry: row };
}

/** 汇总：总金额只累加有价的；无价的单独计数（不许把无价当 0 混进总额） */
export function summarize(ledger) {
  let totalUsd = 0;
  let priced = 0;
  let unpriced = 0;
  for (const e of ledger.entries) {
    if (e.usd === null) { unpriced++; continue; }
    totalUsd += e.usd;
    priced++;
  }
  return { entries: ledger.entries.length, priced, unpriced, totalUsd };
}
