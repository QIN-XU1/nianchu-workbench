#!/usr/bin/env node
/**
 * /api/ledger —— append-only 台账基元的对外端点。
 *
 * 存在的理由：P8「审计留痕（append-only）」的可执行对照我们只有 2.79/千文件，
 * 而 ECC 有 12.46。查下来根因不是「没有能力」，而是**能力散落在几十个文件里各写一遍**，
 * 没有统一契约。这个端点 + tools/ledger/append-only.mjs 就是那个契约。
 *
 * 签名与 serve.mjs 其它 handler 一致：`(req, res, done)`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadLedger, saveLedger, append, verifyChain, summarize, emptyLedger } from './append-only.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const DEFAULT_FILE = path.join(REPO, 'evidence/ledger/audit.json');

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

export function createLedgerHandler() {
  return async function handleLedger(req, res, done) {
    try {
      let body;
      try {
        body = await readJson(req);
      } catch {
        send(res, 400, { ok: false, error: 'body 不是合法 JSON' });
        return;
      }
      const action = String(body?.action ?? '');
      const file = typeof body?.file === 'string' && body.file && !body.file.includes('..')
        ? path.join(REPO, body.file)
        : DEFAULT_FILE;

      if (action === 'ping') {
        send(res, 200, {
          ok: true, module: 'ledger', appendOnly: true,
          actions: ['ping', 'list', 'append', 'verify', 'summary'],
          rules: ['只追加不改写', 'hash 链可查篡改', '无值不许造'],
        });
        return;
      }

      if (action === 'list') {
        const L = loadLedger(file);
        send(res, 200, { ok: true, summary: summarize(L), verify: verifyChain(L), entries: L.entries.slice(-50) });
        return;
      }

      if (action === 'append') {
        if (!body.row || typeof body.row !== 'object') { send(res, 400, { ok: false, error: 'row 必须是对象' }); return; }
        const L = loadLedger(file);
        const r = append(L, body.row);
        if (!r.ok) { send(res, 400, { ok: false, error: r.why }); return; }
        saveLedger(L, file);
        send(res, 200, { ok: true, entry: r.entry, verify: verifyChain(L) });
        return;
      }

      if (action === 'verify') {
        const L = loadLedger(file);
        const v = verifyChain(L);
        // 链断了 ⇒ 409，调用方不能把它当成功
        send(res, v.ok ? 200 : 409, { ok: v.ok, verify: v });
        return;
      }

      if (action === 'summary') {
        const L = loadLedger(file);
        send(res, 200, { ok: true, summary: summarize(L) });
        return;
      }

      send(res, 400, { ok: false, error: '未知 action：' + action });
    } finally {
      if (typeof done === 'function') done();
    }
  };
}
