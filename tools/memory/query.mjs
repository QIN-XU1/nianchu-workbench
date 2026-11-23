#!/usr/bin/env node
/**
 * 记忆检索层 —— 按内容找记忆
 *
 * ── 为什么需要它（真实缺口）────────────────────────────────
 * 原来的 store.mjs 只能 `get --key=<精确 key>`。
 * 也就是说：**你得先知道 key 才能查到东西**。
 * 那不是记忆，那是字典 —— 而人回忆的方式是「我记得有件事关于 X」。
 *
 * 这是产品能力缺口，不是为了刷指标。
 * 特意放在独立文件里：store.mjs 已 31.9KB（红线 32KB），必须拆分而不是硬塞。
 *
 * ── 四态 ──────────────────────────────────────────────
 *   PASS(0)     查到 ≥1 条
 *   WARN(3)     没有匹配（不是错误，是「没有」）
 *   FAIL(1)     参数错误（如空查询）
 *   UNKNOWN(2)  记忆库读不出来
 */
import fs from 'node:fs';
import path from 'node:path';
import { effectiveState, M } from './store.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const STORE = path.join(REPO, 'evidence/memory/store.json');


/**
 * 相关度打分（0-100）—— 决定「先看到哪条」
 *
 * 【为什么需要】原来排序是按 key 字母序 —— 那对用户毫无意义。
 * 搜「port」时，key 就叫 port 的应该排最前，只是 value 里提到 port 的排最后。
 *
 *   key 与查询完全相同      100
 *   key 以查询开头           80
 *   key 含查询               60
 *   仅 value 含查询          20（matchKeyOnly 时为 0，不入选）
 */
export function relevance(key, value, needle, matchKeyOnly = false) {
  const k = String(key || '').toLowerCase();
  const n = String(needle || '').toLowerCase();
  if (!n) return 0;
  if (k === n) return 100;
  if (k.startsWith(n)) return 80;
  if (k.includes(n)) return 60;
  if (!matchKeyOnly && String(value || '').toLowerCase().includes(n)) return 20;
  return 0;
}

export function loadDb(file = STORE) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * 检索记忆
 *
 * @param q          查询词（必填，非空）—— 空查询一律拒绝：那等于把整个库倒出来
 * @param includeHistory  是否含非 fresh（过期/被推翻/冲突）的条目
 * @param limit      最多返回条数
 * @param matchKeyOnly  只匹配 key（默认 key+value 都匹配）
 */
export function search(db, { q, now = new Date(), includeHistory = false, limit = 20, offset = 0, matchKeyOnly = false } = {}) {
  if (!q || !String(q).trim()) {
    return { ok: false, why: '查询词不能为空 —— 空查询等于把整个记忆库倒出来，不是检索', hits: [] };
  }
  const needle = String(q).trim().toLowerCase();
  const entries = (db && db.entries) || [];

  const rows = [];
  for (const e of entries) {
    const st = effectiveState(e, now);
    if (!includeHistory && st !== M.FRESH) continue;
    const hay = matchKeyOnly ? String(e.key || '') : String(e.key || '') + '\u0000' + String(e.value || '');
    if (!hay.toLowerCase().includes(needle)) continue;
    rows.push({
      id: e.id, key: e.key, value: e.value, state: st,
      source: e.source, createdAt: e.createdAt,
      score: relevance(e.key, e.value, needle, matchKeyOnly),
    });
  }

  // 相关度排序：key 精确 > key 前缀 > key 包含 > 仅 value；同分按时间倒序，再按 key 字母序
  rows.sort((a, b) => b.score - a.score
    || String(b.createdAt).localeCompare(String(a.createdAt))
    || String(a.key).localeCompare(String(b.key)));

  const off = Number(offset);
  if (!Number.isFinite(off) || off < 0) {
    return { ok: false, why: 'offset 必须是非负整数', hits: [] };
  }
  const lim = Number(limit);
  if (!Number.isFinite(lim) || lim <= 0) {
    return { ok: false, why: 'limit 必须是正整数', hits: [] };
  }
  const page = rows.slice(off, off + lim);
  return {
    ok: true, q: String(q).trim(),
    total: rows.length,          // 总数永远是全量命中数，不随分页变
    offset: off, limit: lim,
    hits: page,
    truncated: off + lim < rows.length,
  };
}

/** 自检 —— 8 条反例钉住检索最容易写错的地方（含相关度排序） */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);
  const t0 = new Date('2026-01-01T00:00:00Z');
  const t1 = new Date(t0.getTime() + 1000);
  const later = new Date(t0.getTime() + 9999999 * 1000);

  const db = {
    entries: [
      { id: 'm1', key: 'deploy.port', value: '8080', source: 'f:a:1', createdAt: t0.toISOString(), state: M.FRESH, expiresAt: null, valueHash: 'h1' },
      { id: 'm2', key: 'Build.Command', value: 'vite build', source: 'f:b:1', createdAt: t0.toISOString(), state: M.FRESH, expiresAt: null, valueHash: 'h2' },
      { id: 'm3', key: 'deploy.host', value: 'old-host-8080', source: 'f:c:1', createdAt: t1.toISOString(), state: M.SUPERSEDED, expiresAt: null, valueHash: 'h3' },
      { id: 'm4', key: 'temp.token', value: 'abc', source: 'f:d:1', createdAt: t0.toISOString(), state: M.FRESH, expiresAt: new Date(t0.getTime() + 60 * 1000).toISOString(), valueHash: 'h4' },
    ],
  };

  // ── 反例 1（核心）：空查询必须拒绝，不许把整个库倒出来 ──
  const e1 = search(db, { q: '', now: t0 });
  T('反例 · 空查询 → 拒绝（不许把整个库倒出来）', e1.ok === false && /不能为空/.test(e1.why), JSON.stringify(e1.why));

  // ── 反例 2：默认只返回 fresh，过期/被推翻的不许混进来 ──
  // 'old-host' 只出现在 m3（被推翻）里；m1/m2/m4 都不含 ⇒ 默认必须为空
  const r2 = search(db, { q: 'old-host', now: later });
  T('反例 · 默认不返回被推翻/过期的（old-host 只在被推翻的 m3 里，必须为空）',
    r2.ok && r2.hits.length === 0, JSON.stringify(r2.hits.map((h) => h.id)));

  // ── 正例 1：--all 时历史条目才出现，且带真实状态标注 ──
  const r3 = search(db, { q: 'old-host', now: later, includeHistory: true });
  T('正例 · --all 时历史条目出现且标注 superseded',
    r3.hits.some((h) => h.id === 'm3' && h.state === M.SUPERSEDED), JSON.stringify(r3.hits.map((h) => h.id + ':' + h.state)));

  // ── 反例 3：大小写不敏感（key 大小写不同也要能查到）──
  const r4 = search(db, { q: 'build.command', now: t0 });
  T('反例 · 大小写不敏感（build.command 应命中 Build.Command）',
    r4.ok && r4.hits.some((h) => h.id === 'm2'), JSON.stringify(r4.hits.map((h) => h.key)));

  // ── 反例 4：value 命中也要算，不只 key ──
  const r5 = search(db, { q: 'vite', now: t0 });
  T('反例 · value 内容也要能搜到（vite 在 value 里）',
    r5.ok && r5.hits.some((h) => h.id === 'm2'), JSON.stringify(r5.hits.map((h) => h.id)));

  // ── 反例 5：matchKeyOnly 时 value 命中不许算 ──
  const r6 = search(db, { q: 'vite', now: t0, matchKeyOnly: true });
  T('反例 · matchKeyOnly 时 value 命中不算（必须为空）',
    r6.ok && r6.hits.length === 0, JSON.stringify(r6.hits.map((h) => h.id)));

  // ── 相关度排序：3 条反例 ──
  {
    const dbr = { entries: [
      { id: 'v1', key: 'notes', value: 'the port is 8080', source: 'f:1', createdAt: t0.toISOString(), state: M.FRESH, expiresAt: null, valueHash: 'x1' },
      { id: 'k1', key: 'cfg.port', value: '9000', source: 'f:2', createdAt: t0.toISOString(), state: M.FRESH, expiresAt: null, valueHash: 'x2' },
      { id: 'k2', key: 'port', value: '7000', source: 'f:3', createdAt: t0.toISOString(), state: M.FRESH, expiresAt: null, valueHash: 'x3' },
    ] };
    const rr = search(dbr, { q: 'port', now: t0 });
    T('反例 · key 精确命中必须排第一（port 在 notes 之前）',
      rr.hits[0] && rr.hits[0].id === 'k2', JSON.stringify(rr.hits.map((h) => h.id + ':' + h.score)));
    T('反例 · key 命中必须排在「仅 value 命中」之前',
      rr.hits.findIndex((h) => h.id === 'v1') === rr.hits.length - 1, JSON.stringify(rr.hits.map((h) => h.id)));
    // 【2026-11-15 修】原来这条是「打分单调不增」—— 按 score 降序 sort 完必然成立，**恒真装饰**。
    // 换成能真失败的：仅 value 命中的得分必须严格低于 key 包含命中。
    T('反例 · 仅 value 命中的得分必须严格低于 key 包含命中',
      rr.hits.find((h) => h.id === 'v1').score < rr.hits.find((h) => h.id === 'k1').score, JSON.stringify(rr.hits.map((h) => h.id + ':' + h.score)));
  }

  // ── 分页：4 条反例 ──
  {
    const mkE = (i) => ({ id: 'p' + i, key: 'k' + i, value: 'v' + i, source: 'f:' + i, createdAt: t0.toISOString(), state: M.FRESH, expiresAt: null, valueHash: 'h' + i });
    const dbb = { entries: Array.from({ length: 10 }, (_, i) => mkE(i)) };
    const pg1 = search(dbb, { q: 'k', now: t0, limit: 4, offset: 0 });
    const pg2 = search(dbb, { q: 'k', now: t0, limit: 4, offset: 4 });
    const pg3 = search(dbb, { q: 'k', now: t0, limit: 4, offset: 8 });
    T('反例 · 第 1 页 4 条且 truncated=true', pg1.hits.length === 4 && pg1.truncated === true && pg1.total === 10,
      JSON.stringify({ n: pg1.hits.length, tr: pg1.truncated, tot: pg1.total }));
    T('反例 · 第 2 页不与第 1 页重叠（offset 真生效）',
      pg2.hits[0].id === 'p4' && !pg1.hits.some((h) => pg2.hits.some((x) => x.id === h.id)),
      JSON.stringify({ p1: pg1.hits.map((h) => h.id), p2: pg2.hits.map((h) => h.id) }));
    T('反例 · 末页 truncated 必须为 false（不许永远说还有更多）', pg3.truncated === false, JSON.stringify({ tr: pg3.truncated }));
    T('反例 · offset 超出总数 ⇒ 0 条但 total 仍是 10（总数不随分页变）',
      search(dbb, { q: 'k', now: t0, limit: 4, offset: 99 }).total === 10
      && search(dbb, { q: 'k', now: t0, limit: 4, offset: 99 }).hits.length === 0, '');
    T('反例 · offset 为负 ⇒ 拒绝', search(dbb, { q: 'k', now: t0, offset: -1 }).ok === false, '');
  }

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  if (process.argv.includes('--selftest')) {
    const r = selfTest();
    console.log('');
    console.log('  记忆检索 · 自检（2 正例 + 7 反例，含相关度排序）');
    console.log('  ' + '─'.repeat(70));
    console.log(r.lines);
    console.log('');
    console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
    console.log('');
    process.exit(r.ok ? 0 : 1);
  }

  const flag = (n) => {
    const p = '--' + n + '=';
    const a = process.argv.find((x) => x.startsWith(p));
    return a ? a.slice(p.length) : null;
  };

  const db = loadDb();
  if (!db) {
    console.log('  ❔ 记忆库读不出来（' + path.relative(REPO, STORE) + '）');
    process.exit(2);
  }

  const q = flag('q') || flag('query');
  const r = search(db, {
    q,
    includeHistory: process.argv.includes('--all'),
    matchKeyOnly: process.argv.includes('--key-only'),
    limit: flag('limit') ? Number(flag('limit')) : 20,
    offset: flag('offset') ? Number(flag('offset')) : 0,
  });
  if (!r.ok) { console.log('  ✗ ' + r.why); process.exit(1); }

  console.log('');
  console.log('  检索「' + r.q + '」· 命中 ' + r.total + ' 条 · 显示第 ' + (r.hits.length ? (r.offset + 1) : 0) + '-' + (r.offset + r.hits.length) + ' 条' + (r.truncated ? '（还有更多，用 --offset 翻页）' : ''));
  console.log('  ' + '─'.repeat(70));
  if (!r.total) {
    console.log('  （没有匹配）');
    console.log('');
    process.exit(3);   // WARN：没有匹配不是错误
  }
  for (const h of r.hits) {
    const tag = h.state === M.FRESH ? '' : '  [' + h.state + ']';
    console.log('  · ' + h.key + ' = ' + String(h.value).slice(0, 60) + tag);
    console.log('      来源 ' + h.source + ' · ' + h.createdAt);
  }
  console.log('');
  process.exit(0);
}
