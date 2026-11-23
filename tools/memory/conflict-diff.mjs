#!/usr/bin/env node
/**
 * 冲突候选差异对比 —— 把「判断所需的材料」摆出来，但**不替人选**
 *
 * ── 为什么需要它（真实缺口）────────────────────────────────
 * store.mjs 的 get/audit 只说「这个 key 有 2 条未解决冲突」，
 * 但不告诉你**它们差在哪里**。
 *
 * 于是 resolve 的时候，人看到的只是两个值，得自己去翻 source、翻时间、逐个对比。
 * 这违背了一条原则：
 *   判断类的事情不机械化 —— 机制不替你决定；
 *   但机制**有责任把做判断所需的材料给全**。
 *
 * 这个文件做的就是：把候选摊开，标出哪些字段不同、值差在哪，
 * 然后**停在那里** —— 选谁仍然是人的事。
 *
 * ── 四态 ──────────────────────────────────────────────
 *   PASS(0)     没有未解决冲突
 *   WARN(3)     有冲突（需要人判断，这是提醒不是失败）
 *   UNKNOWN(2)  库读不出来
 */
import fs from 'node:fs';
import path from 'node:path';
import { effectiveState, M } from './store.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const STORE = path.join(REPO, 'evidence/memory/store.json');

export function loadDb(file = STORE) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 两个字符串的共同前缀/后缀长度，用来只展示差异段 */
export function diffSegment(a, b) {
  const A = String(a), B = String(b);
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  return {
    commonPrefix: A.slice(0, p),
    commonSuffix: s ? A.slice(A.length - s) : '',
    aMiddle: A.slice(p, A.length - s),
    bMiddle: B.slice(p, B.length - s),
  };
}

/**
 * 列出所有未解决冲突，并把候选的差异摆清楚
 *
 * @returns [{key, count, fields: 哪些字段不同, candidates: [...], note}]
 */
export function conflictReport(db, { now = new Date() } = {}) {
  const entries = (db && db.entries) || [];
  const byKey = new Map();
  for (const e of entries) {
    if (effectiveState(e, now) !== M.CONFLICTED) continue;
    if (!byKey.has(e.key)) byKey.set(e.key, []);
    byKey.get(e.key).push(e);
  }

  const out = [];
  for (const [key, list] of byKey) {
    // 哪些字段在候选之间不同 —— 这就是「差在哪」
    const fields = [];
    for (const f of ['value', 'source']) {
      const vals = new Set(list.map((e) => String(e[f])));
      if (vals.size > 1) fields.push(f);
    }
    const candidates = list.map((e) => ({
      id: e.id, value: e.value, source: e.source, createdAt: e.createdAt,
    }));
    // 值两两差异（只对前两个做示例，多了没意义）
    let valueDiff = null;
    if (list.length >= 2) valueDiff = diffSegment(list[0].value, list[1].value);

    out.push({
      key, count: list.length, fields, candidates, valueDiff,
      note: '这些候选**都没有过期**，是可信来源之间的真分歧。选谁由人决定（resolve --choose --why）。',
    });
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return { ok: true, total: out.length, conflicts: out };
}

/** 自检 —— 4 条反例 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);
  const t0 = new Date('2026-01-01T00:00:00Z');
  const mk = (id, key, value, source, state = M.CONFLICTED) => ({
    id, key, value, source, createdAt: t0.toISOString(), lastSeen: t0.toISOString(),
    state, expiresAt: null, valueHash: 'h' + id,
  });

  // ── 反例 1（核心）：没有冲突时不许编造 ──
  const clean = { entries: [mk('a', 'k', '1', 'f:1', M.FRESH)] };
  const r1 = conflictReport(clean, { now: t0 });
  T('反例 · 无冲突时不许编造（fresh 不算冲突）', r1.total === 0, JSON.stringify(r1.conflicts));

  // ── 正例 1：两条冲突 ⇒ 报出，并指出 value 与 source 都不同 ──
  const c2 = { entries: [mk('b', 'port', '8080', 'f:a:1'), mk('c', 'port', '9090', 'f:b:1')] };
  const r2 = conflictReport(c2, { now: t0 });
  T('正例 · 两条冲突被报出且标出 value/source 都不同',
    r2.total === 1 && r2.conflicts[0].count === 2
    && r2.conflicts[0].fields.includes('value') && r2.conflicts[0].fields.includes('source'),
    JSON.stringify(r2.conflicts[0] && r2.conflicts[0].fields));

  // ── 反例 2：value 不同但 source 相同时，fields 不许把 source 也说成不同 ──
  const c3 = { entries: [mk('d', 'k', 'A', 'f:same'), mk('e', 'k', 'B', 'f:same')] };
  const r3 = conflictReport(c3, { now: t0 });
  T('反例 · source 相同 ⇒ fields 不许含 source（不许乱标差异）',
    !r3.conflicts[0].fields.includes('source') && r3.conflicts[0].fields.includes('value'),
    JSON.stringify(r3.conflicts[0].fields));

  // ── 正例 2：diffSegment 必须只切出真正不同的那段 ──
  const ds = diffSegment('deploy.port=8080', 'deploy.port=9090');
  // 共同前缀 deploy.port=，共同后缀 '0'，中间分别是 808 vs 909
  T('正例 · diffSegment 正确切出差异段（前缀 deploy.port= / 后缀 0 / 中间 808 vs 909）',
    ds.commonPrefix === 'deploy.port=' && ds.commonSuffix === '0'
    && ds.aMiddle === '808' && ds.bMiddle === '909',
    JSON.stringify(ds));

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
    console.log('  冲突候选差异 · 自检（2 正例 + 2 反例）');
    console.log('  ' + '─'.repeat(70));
    console.log(r.lines);
    console.log('');
    console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
    console.log('');
    process.exit(r.ok ? 0 : 1);
  }

  const db = loadDb();
  if (!db) { console.log('  ❔ 记忆库读不出来'); process.exit(2); }
  const r = conflictReport(db);
  console.log('');
  console.log('  未解决冲突 · ' + r.total + ' 个 key');
  console.log('  ' + '─'.repeat(70));
  if (!r.total) { console.log('  （没有未解决冲突）'); console.log(''); process.exit(0); }
  for (const c of r.conflicts) {
    console.log('  ' + c.key + '  （' + c.count + ' 条候选 · 不同字段：' + (c.fields.join('/') || '无') + '）');
    for (const cand of c.candidates) {
      console.log('      · ' + String(cand.value).slice(0, 40) + '   来源 ' + cand.source + '   ' + cand.createdAt);
    }
    if (c.valueDiff) {
      console.log('      差异：共同前缀「' + c.valueDiff.commonPrefix + '」 → 「' + c.valueDiff.aMiddle + '」 vs 「' + c.valueDiff.bMiddle + '」');
    }
    console.log('      ' + c.note);
  }
  console.log('');
  process.exit(3);   // WARN：有冲突需要人判断
}
