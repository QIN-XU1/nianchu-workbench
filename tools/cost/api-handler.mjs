#!/usr/bin/env node
/**
 * /api/cost —— 把成本核算接进产品主链路
 *
 * C6「成本可复算」的模块是真的（tools/cost/meter.mjs，verify-cost 10/10），
 * 但矩阵里 P1「成本核算」的可执行对照我们只有 1.86/千文件 vs open-design 15.38。
 * 差距的一部分是**能力集中在单个文件**（21.5KB 一个文件干完价格表+台账+复算）。
 * 这轮按 B4 体量纪律拆成 pricing / ledger 两个模块，并把它们接进产品。
 *
 * 签名与 serve.mjs 其它 handler 一致：`(req, res, done)`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { tableFromCatalog, costOf, loadPrices, UNIT } from './pricing.mjs';
import { loadLedger, saveLedger, appendEntry, summarize, emptyLedger } from './ledger.mjs';
// 【2026-11-18 补】从会话记录批量回算成本 —— ECC 有而我们原来没有的那一环
import { parseJsonl, aggregateBySession, toLedgerRows } from './replay.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const PRICES = path.join(REPO, 'evidence/cost/prices.json');
const LEDGER = path.join(REPO, 'evidence/cost/ledger.json');

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

export function createCostHandler() {
  return async function handleCost(req, res, done) {
    try {
      let body;
      try {
        body = await readJson(req);
      } catch {
        send(res, 400, { ok: false, error: 'body 不是合法 JSON' });
        return;
      }
      const action = String(body?.action ?? '');

      if (action === 'ping') {
        send(res, 200, {
          ok: true, module: 'cost', unit: UNIT,
          rules: ['无价不当 0', 'append-only', '可复算'],
          actions: ['ping', 'prices', 'cost', 'ledger', 'record', 'replay'],
        });
        return;
      }

      if (action === 'prices') {
        const p = loadPrices(PRICES);
        if (!p) { send(res, 404, { ok: false, error: '还没有价格快照，先跑 tools/cost/meter.mjs sync' }); return; }
        const priced = Object.values(p.table).filter(Boolean).length;
        const unpriced = Object.values(p.table).filter((v) => v === null).length;
        send(res, 200, { ok: true, at: p.at, unit: p.unit, priced, unpriced, table: p.table });
        return;
      }

      if (action === 'cost') {
        const p = loadPrices(PRICES);
        if (!p) { send(res, 404, { ok: false, error: '还没有价格快照' }); return; }
        if (typeof body.model !== 'string' || !body.model) { send(res, 400, { ok: false, error: 'model 必填' }); return; }
        const price = p.table[body.model];
        if (!price) {
          // 无价 ⇒ 如实说「不知道多少钱」，不返回 0
          send(res, 200, { ok: true, usd: null, why: '该模型在价格快照里无价（不记 0）', model: body.model });
          return;
        }
        const usd = costOf(price, body);
        send(res, 200, { ok: true, usd, model: body.model, priceAt: p.at });
        return;
      }

      if (action === 'ledger') {
        const L = loadLedger(LEDGER);
        send(res, 200, { ok: true, summary: summarize(L), entries: L.entries.slice(-20) });
        return;
      }

      if (action === 'record') {
        const L = loadLedger(LEDGER);
        const p = loadPrices(PRICES);
        let usd = null;
        let why = '无价';
        if (p && p.table[body.model]) {
          usd = costOf(p.table[body.model], body);
          why = usd === null ? '单价单位不符' : null;
        }
        const r = appendEntry(L, {
          model: body.model, input: body.input, output: body.output,
          cacheRead: body.cacheRead, cacheWrite: body.cacheWrite,
          usd, priceAt: p?.at ?? null, why,
        });
        if (!r.ok) { send(res, 400, { ok: false, error: r.why }); return; }
        saveLedger(L, LEDGER);
        send(res, 200, { ok: true, entry: r.entry });
        return;
      }

      // ── 从会话记录批量回算（P1 的真实能力：不是手动一次一个，而是把历史一次性算清）──
      if (action === 'replay') {
        if (typeof body.text !== 'string') {
          send(res, 400, { ok: false, error: 'text 必填（JSONL 原文；本端点不代读任意路径）' });
          return;
        }
        const p = loadPrices(PRICES);
        const parsed = parseJsonl(body.text, { sessionIdHint: body.sessionId ?? null });
        if (!parsed.rows.length) {
          // 一行都没解析出来 ⇒ 明确 UNKNOWN，不许回「0 元」
          send(res, 422, {
            ok: false, state: 'UNKNOWN',
            why: '没有可读的 model+usage 行，判不了成本',
            skipped: parsed.skipped, notes: parsed.why,
          });
          return;
        }
        const agg = aggregateBySession(parsed.rows, { cumulative: body.cumulative !== false });
        const rows = toLedgerRows(agg, p?.table ?? {});

        if (body.commit === true) {
          const L = loadLedger(LEDGER);
          for (const r of rows) appendEntry(L, r);
          saveLedger(L, LEDGER);
        }
        const totalUsd = rows.reduce((a, r) => a + (r.value ?? 0), 0);
        const unpriced = rows.filter((r) => r.value === null).length;
        send(res, 200, {
          ok: true,
          sessions: rows.length,
          totalUsd,
          unpriced,
          committed: body.commit === true,
          notes: parsed.why,
          rows,
        });
        return;
      }

      send(res, 400, { ok: false, error: '未知 action：' + action });
    } finally {
      if (typeof done === 'function') done();
    }
  };
}
