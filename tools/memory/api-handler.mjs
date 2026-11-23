#!/usr/bin/env node
/**
 * /api/memory —— 把记忆治理接进产品主链路
 *
 * 背景：A7 记忆治理的模块是真的（`tools/memory/store.mjs`，verify-memory 34/34），
 * 但矩阵里被判「部分」，理由是「实现是真的，但没接进产品主链路」。
 * 这个 handler 就是补那一刀。
 *
 * 治理三件事都通过这个端点对外（不是只读展示，是真写入真治理）：
 *   · 溯源：没有 source 的写入被 store 拒绝（透传 400）
 *   · 冲突：同 key 不同值走 superseded + supersededBy，旧值仍可查
 *   · TTL：expiresAt 按注入时钟算四态，过期不进查询结果但保留历史
 *
 * 签名与 serve.mjs 其它 handler 一致：`(req, res, done)`，自己读 body、自己写响应。
 */
import { load as loadDb, save as saveDb, put, get, audit, gc, effectiveState } from './store.mjs';
// 【2026-11-18 拆】老化与冲突各自独立成模块，这里接进来对外暴露
import { stateCounts, expiringSoon, auditAging, ttlRemainingSec, M } from './ttl.mjs';
import { classify, resolveConflict, revertTo } from './conflict.mjs';

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

export function createMemoryHandler() {
  return async function handleMemory(req, res, done) {
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
          ok: true, module: 'memory',
          governance: ['source', 'conflict', 'ttl'],
          actions: ['ping', 'put', 'get', 'audit', 'gc', 'state', 'aging', 'conflict', 'resolve', 'revert'],
        });
        return;
      }

      const db = loadDb();

      if (action === 'put') {
        if (typeof body.key !== 'string' || !body.key) { send(res, 400, { ok: false, error: 'key 必填' }); return; }
        if (typeof body.source !== 'string' || !body.source) {
          // 治理第一条：凭印象的记忆不许进存储
          send(res, 400, { ok: false, error: 'source 必填 —— 没有来源的记忆不允许写入' });
          return;
        }
        let r;
        try {
          r = put(db, {
            key: body.key,
            value: body.value,
            source: body.source,
            ttlSec: Number.isFinite(body.ttlSec) ? body.ttlSec : null,
            by: typeof body.by === 'string' ? body.by : 'agent',
          });
        } catch (e) {
          send(res, 400, { ok: false, error: String(e && e.message) });
          return;
        }
        saveDb(db);
        // 【第 93 轮修】原来无条件 send(200, { ok:true, result })：store 拒绝写入时
        // （如 value 为空 → {ok:false, why:'value 不能为空'}）外层仍是 200 + ok:true，
        // 客户端只看外层会以为写成功。改为把拒绝映射成 400 + 外层 ok:false。
        if (r && r.ok === false) {
          send(res, 400, { ok: false, error: r.why || 'write rejected', result: r });
          return;
        }
        send(res, 200, { ok: true, result: r ?? null });
        return;
      }

      if (action === 'get') {
        if (typeof body.key !== 'string' || !body.key) { send(res, 400, { ok: false, error: 'key 必填' }); return; }
        const r = get(db, body.key, { includeHistory: body.includeHistory === true });
        send(res, 200, { ok: true, result: r ?? null });
        return;
      }

      if (action === 'audit') {
        const r = audit(db, { soonSec: Number.isFinite(body.soonSec) ? body.soonSec : 86400 });
        send(res, 200, { ok: true, result: r ?? null });
        return;
      }

      if (action === 'gc') {
        const r = gc(db);
        saveDb(db);
        send(res, 200, { ok: true, result: r ?? null });
        return;
      }

      if (action === 'state') {
        // 单条的四态（fresh/superseded/expired/conflicted）
        if (typeof body.key !== 'string' || !body.key) { send(res, 400, { ok: false, error: 'key 必填' }); return; }
        const e = get(db, body.key, { includeHistory: true });
        // 【2026-11-18 修·独立审计 P1】原实现读 `e.entries`，但 store.get() 返回的是
        // {key, live, liveCount, ambiguous, conflict, history} —— **没有 entries 字段**。
        // 于是 entries = [e] 是那个包装对象本身，effectiveState(包装对象) 既无 state
        // 也无 expiresAt ⇒ **恒返回 fresh**，连不存在的 key 都报 fresh。
        // 现在读 history（那才是逐条数组）；一条都没有就如实说找不到。
        const list = Array.isArray(e?.history) ? e.history : [];
        if (!list.length) {
          send(res, 404, { ok: false, error: '没有这个 key 的任何记录', key: body.key });
          return;
        }
        const entries = list;
        send(res, 200, {
          ok: true,
          result: entries.map((x) => ({ key: x.key, state: effectiveState(x), source: x.source, expiresAt: x.expiresAt ?? null })),
        });
        return;
      }

      // ── 老化（P2）：四态计数 / 临期提醒 / 老化审计 ──
      if (action === 'aging') {
        const entries = Array.isArray(db.entries) ? db.entries : [];
        const soonSec = Number.isFinite(body.soonSec) ? body.soonSec : 86400;
        const a = auditAging(entries, { soonSec });
        send(res, 200, {
          ok: true,
          state: a.state,
          counts: a.counts,
          expiringSoon: a.expiringSoon,
          conflicted: a.conflicted,
          problems: a.problems,
        });
        return;
      }

      // ── 冲突（P6）：分类 / 显式解决 / 回滚 ──
      if (action === 'conflict') {
        if (typeof body.key !== 'string' || !body.key) { send(res, 400, { ok: false, error: 'key 必填' }); return; }
        const all = (db.entries || []).filter((e) => e.key === body.key);
        const c = classify(all, new Date());
        send(res, 200, {
          ok: true,
          key: body.key,
          live: c.live,
          liveCount: c.liveCount,
          ambiguous: c.ambiguous,
          conflicted: c.conflicted.map((e) => ({ id: e.id, value: e.value, source: e.source })),
        });
        return;
      }

      if (action === 'resolve') {
        const r = resolveConflict(db, {
          key: body.key, chooseId: body.chooseId, why: body.why,
          by: typeof body.by === 'string' ? body.by : 'agent',
        });
        if (!r.ok) { send(res, 400, { ok: false, error: r.why }); return; }
        saveDb(db);
        send(res, 200, { ok: true, superseded: r.superseded });
        return;
      }

      if (action === 'revert') {
        const r = revertTo(db, {
          key: body.key, toEntryId: body.toEntryId, why: body.why,
          by: typeof body.by === 'string' ? body.by : 'agent',
        });
        if (!r.ok) { send(res, 400, { ok: false, error: r.why }); return; }
        saveDb(db);
        send(res, 200, { ok: true, superseded: r.superseded });
        return;
      }

      send(res, 400, { ok: false, error: '未知 action：' + action });
    } finally {
      if (typeof done === 'function') done();
    }
  };
}
