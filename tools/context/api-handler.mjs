#!/usr/bin/env node
/**
 * /api/context —— 把上下文压缩接进产品主链路
 *
 * 背景：A5 的模块是真的（`tools/context/compress.mjs`，verify-context 32/32），
 * 但矩阵里被判「部分」，理由是「全仓无任何文件 import 该模块」。
 * 这个 handler 就是补那一刀。
 *
 * 四态语义（照搬模块自己的约定，不另造）：
 *   PASS/WARN 压缩成功（WARN 表示回退过）
 *   FAIL      压不下或丢关键事实 —— **不许假装成功**
 *   UNKNOWN   输入非法
 *
 * 签名与 serve.mjs 其它 handler 一致：`(req, res, done)`。
 */
import { compress, estimateTokens, S } from './compress.mjs';

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

export function createContextHandler() {
  return async function handleContext(req, res, done) {
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
        send(res, 200, { ok: true, module: 'context', states: Object.values(S) });
        return;
      }

      if (action === 'compress') {
        const items = Array.isArray(body.items) ? body.items : null;
        if (!items) { send(res, 400, { ok: false, error: 'items 必须是数组' }); return; }
        if (!items.length) { send(res, 400, { ok: false, error: 'items 不能为空' }); return; }

        const budget = Number.isFinite(body.budget) ? body.budget : 2000;
        const keepRecent = Number.isFinite(body.keepRecent) ? body.keepRecent : 3;

        let r;
        try {
          r = compress(items, { budget, keepRecent });
        } catch (e) {
          send(res, 400, { ok: false, error: String(e && e.message) });
          return;
        }
        // 模块返回四态；FAIL 用 409 让调用方无法误当成功（这是「不许假装成功」的落地）
        const state = r?.state ?? r?.status ?? null;
        const httpCode = state === S.FAIL ? 409 : state === S.UNKNOWN ? 422 : 200;
        send(res, httpCode, { ok: httpCode === 200, state, result: r ?? null });
        return;
      }

      if (action === 'estimate') {
        const text = typeof body.text === 'string' ? body.text : null;
        if (text === null) { send(res, 400, { ok: false, error: 'text 必填' }); return; }
        send(res, 200, { ok: true, tokens: estimateTokens(text) });
        return;
      }

      send(res, 400, { ok: false, error: '未知 action：' + action + '（支持 ping / compress / estimate）' });
    } finally {
      if (typeof done === 'function') done();
    }
  };
}
