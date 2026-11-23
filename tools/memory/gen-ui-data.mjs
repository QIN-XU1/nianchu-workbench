#!/usr/bin/env node
/**
 * 生成界面的记忆数据（A7）
 *
 * 读真实记忆存储 evidence/memory/store.json，算出治理视图：
 * 每条的有效状态（fresh/superseded/expired/conflicted）、来源、TTL 剩余。
 *
 * 界面显示的是**真实存储的状态**，不是示例。
 */
import fs from 'node:fs';
import path from 'node:path';
import { effectiveState, audit, M } from './store.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const STORE = path.join(REPO, 'evidence/memory/store.json');
const OUT = path.join(REPO, 'apps/agent-ui/src/data/memory.json');

const db = fs.existsSync(STORE)
  ? JSON.parse(fs.readFileSync(STORE, 'utf8'))
  : { entries: [] };

const now = new Date();
const entries = (db.entries || []).map((e) => {
  const st = effectiveState(e, now);
  const msLeft = e.expiresAt ? new Date(e.expiresAt).getTime() - now.getTime() : null;
  return {
    id: e.id,
    key: e.key,
    value: String(e.value).slice(0, 200),
    source: e.source,
    state: st,
    createdAt: e.createdAt,
    lastSeen: e.lastSeen,
    touchCount: e.touchCount || 1,
    ttlSec: e.ttlSec || null,
    expiresAt: e.expiresAt || null,
    /** 剩余毫秒（null = 无 TTL） */
    msLeft,
    supersededBy: e.supersededBy || null,
  };
});

const a = audit(db, { now });

const data = {
  what: '记忆治理状态（A7）',
  at: now.toISOString(),
  generator: 'tools/memory/gen-ui-data.mjs',
  rule: '每条记忆必须有来源；同 key 更新不覆盖而是标 superseded；TTL 过期标 expired',
  states: M,
  totals: {
    total: a.total,
    fresh: a.fresh,
    expired: a.expired.length,
    superseded: a.superseded.length,
    noSource: a.noSource.length,
    unresolvedConflict: a.unresolvedConflict.length,
  },
  audit: {
    ok: a.ok,
    issues: a.unresolvedConflict.map((c) => '同 key「' + c.key + '」有 ' + c.count + ' 条不同值未解决'),
  },
  entries,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n', 'utf8');

console.log('');
console.log('  记忆治理数据');
console.log('  ' + '─'.repeat(60));
console.log('  总计 ' + a.total + ' 条 · 有效 ' + a.fresh + ' · 过期 ' + a.expired.length +
  ' · 被推翻 ' + a.superseded.length + ' · 无来源 ' + a.noSource.length);
console.log('  治理' + (a.ok ? '达标 ✓' : '不达标 ✗'));
console.log('  → ' + path.relative(REPO, OUT));
console.log('');