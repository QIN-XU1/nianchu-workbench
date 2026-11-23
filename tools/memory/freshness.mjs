#!/usr/bin/env node
/**
 * 记忆陈旧度分析 —— 「还新鲜，但很久没人确认了」
 *
 * ── 为什么需要它（真实缺口，不是凑数）────────────────────────
 * store.mjs 的 TTL 管的是**显式过期**：写的时候就说好「多久后作废」。
 * 但真实世界里大多数记忆根本没写 TTL，它们会一直「fresh」。
 *
 * 于是出现一个 TTL 看不见的问题：
 *   一条记忆从来没被推翻、也没过期 —— 但它**三年没被任何人确认过**。
 *   它在系统里看起来 100% 有效，实际上可能早就不是事实了。
 *
 * TTL 管不到它。这正是 C3（记忆老化）缺的那一块：**隐式腐烂**。
 *
 * 所以：freshness 层找的是「还 fresh 但 lastSeen 太久远」的条目，
 * 交给人和机制去复核 —— 而不是让它们假装永远正确。
 *
 * ── 与 audit 的分工 ─────────────────────────────────────
 *   audit     ：已过期 / 即将过期 / 无来源 / 未解决冲突（**状态**问题）
 *   freshness ：fresh 但长期未确认（**可信度衰减**问题）
 *
 * ── 四态 ──────────────────────────────────────────────
 *   PASS(0)     没有陈旧项
 *   WARN(3)     有陈旧项（提醒，不是错误）
 *   FAIL(1)     参数错误
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

/**
 * 找出「新鲜但陈旧」的记忆
 *
 * @param staleDays  超过这么多天没被确认 ⇒ 算陈旧
 * @param now        当前时刻（可注入，保证可复算）
 */
export function staleEntries(db, { now = new Date(), staleDays = 30 } = {}) {
  const d = Number(staleDays);
  if (!Number.isFinite(d) || d < 0) {
    return { ok: false, why: 'staleDays 必须是非负数', items: [] };
  }
  if (d === 0) return { ok: true, staleDays: 0, total: 0, items: [] };  // 显式关闭

  const cutoff = now.getTime() - d * 86400 * 1000;
  const entries = (db && db.entries) || [];
  const items = [];

  for (const e of entries) {
    // 只看仍然 fresh 的 —— 过期/被推翻/冲突的归 audit 管，不在这里重复报
    if (effectiveState(e, now) !== M.FRESH) continue;
    // 「最后一次被确认」：优先 lastSeen（同值重复写入会刷新），否则退到 createdAt
    const last = e.lastSeen || e.createdAt;
    const t = new Date(last).getTime();
    if (!Number.isFinite(t)) continue;   // 没有可用时间戳 ⇒ 不瞎猜
    if (t <= cutoff) {
      const days = Math.floor((now.getTime() - t) / 86400000);
      // 分级：超过 3 倍阈值 ⇒ critical（几乎肯定过时），否则 warn
      // 不区分的话，「31 天没确认」和「三年没确认」并列，人无法排优先级
      const severity = days >= d * 3 ? 'critical' : 'warn';
      items.push({
        id: e.id, key: e.key, value: e.value, source: e.source,
        lastSeen: last, daysSinceSeen: days, severity,
      });
    }
  }
  // 最旧的在最前
  items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1)
    || b.daysSinceSeen - a.daysSinceSeen);
  return { ok: true, staleDays: d, total: items.length, items };
}

/** 自检 —— 1 正例 + 5 反例 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);
  const t0 = new Date('2026-01-01T00:00:00Z');
  const day = 86400000;
  const at = (days) => new Date(t0.getTime() + days * day);

  const mk = (lastSeenDaysAgo, extra = {}) => ({
    id: 'm' + lastSeenDaysAgo + (extra.id || ''),
    key: 'k' + lastSeenDaysAgo + (extra.id || ''),
    value: 'v', source: 'f:1',
    createdAt: at(-lastSeenDaysAgo).toISOString(),
    lastSeen: at(-lastSeenDaysAgo).toISOString(),
    state: M.FRESH, expiresAt: null, valueHash: 'h',
    ...extra,
  });

  // ── 正例：新鲜记忆必须被判为新鲜（不是「没报陈旧」就算过，要显式确认）──
  // 为什么需要它：全部自检都是「不许报陈旧」，如果 staleEntries 永远返回空，
  // 所有反例都会通过 —— 那这个验收器就是假的。必须有一条断言它**确实能**
  // 在正常输入下给出「新鲜」这个结论。
  const freshDb = { entries: [mk(1, { id: '-fresh' })] };
  const rf = staleEntries(freshDb, { now: t0, staleDays: 30 });
  T('正例 · 新鲜记忆（1 天前确认，阈值 30 天）：判为新鲜，不误报',
    rf?.total === 0, JSON.stringify(rf?.items || []));

  // ── 反例 1：刚确认过的不许算陈旧 ──
  const db1 = { entries: [mk(1)] };
  const r1 = staleEntries(db1, { now: t0, staleDays: 30 });
  T('反例 · 1 天前刚确认的不许算陈旧', r1?.total === 0,
    JSON.stringify((r1?.items || []).map((x) => x.key)));

  // ── 反例 2（核心）：超期未确认的必须报出来 ──
  const db2 = { entries: [mk(90)] };
  const r2 = staleEntries(db2, { now: t0, staleDays: 30 });
  T('反例 · 90 天未确认必须报陈旧',
    r2?.total === 1 && (r2.items?.[0]?.daysSinceSeen ?? -1) >= 90,
    JSON.stringify(r2?.items || []));

  // ── 反例 3：已过期的不许混进陈旧（那是 audit 的 expired，两回事）──
  const expiredEntry = mk(90, { state: M.FRESH, expiresAt: at(-100).toISOString() });
  const r3 = staleEntries({ entries: [expiredEntry] }, { now: t0, staleDays: 30 });
  T('反例 · 已过期的不许算陈旧（归 audit 管）', r3?.total === 0,
    JSON.stringify(r3?.items || []));

  // ── 反例 4：staleDays=0 必须关闭（不许默认乱报）──
  const r4 = staleEntries({ entries: [mk(999)] }, { now: t0, staleDays: 0 });
  T('反例 · staleDays=0 必须为空（显式关闭）', r4?.total === 0,
    JSON.stringify(r4?.items || []));

  // ── 反例 5：没有 lastSeen 时用 createdAt 兜底（不许因缺字段就漏报）──
  const noSeen = mk(90);
  delete noSeen.lastSeen;
  const r5 = staleEntries({ entries: [noSeen] }, { now: t0, staleDays: 30 });
  T('反例 · 缺 lastSeen 用 createdAt 兜底（不许漏报）', r5?.total === 1,
    JSON.stringify((r5?.items || []).map((x) => x.key)));

  // ── 分级 2 条反例 ──
  {
    const dbS = { entries: [mk(40, { id: 'w' }), mk(200, { id: 'c' })] };
    const rS = staleEntries(dbS, { now: t0, staleDays: 30 });
    const w = (rS?.items || []).find((x) => x.key === 'k40w');
    const c = (rS?.items || []).find((x) => x.key === 'k200c');
    T('反例 · 200 天(>3倍阈值) 必须判 critical、40 天判 warn',
      c && c.severity === 'critical' && w && w.severity === 'warn',
      JSON.stringify((rS?.items || []).map((x) => x.key + ':' + x.severity)));
    T('反例 · critical 必须排在 warn 前面（可以照它排优先级）',
      rS?.items?.[0]?.severity === 'critical', JSON.stringify((rS?.items || []).map((x) => x.severity)));
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
    console.log('  记忆陈旧度 · 自检（5 反例）');
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
  if (!db) { console.log('  ❔ 记忆库读不出来'); process.exit(2); }

  const days = flag('days') ? Number(flag('days')) : 30;
  const r = staleEntries(db, { staleDays: days });
  if (!r.ok) { console.log('  ✗ ' + r.why); process.exit(1); }

  console.log('');
  console.log('  陈旧度分析 · 阈值 ' + r.staleDays + ' 天 · 发现 ' + r.total + ' 条「还新鲜但久未确认」');
  console.log('  ' + '─'.repeat(70));
  if (!r.total) { console.log('  （没有陈旧项）'); console.log(''); process.exit(0); }
  for (const x of r.items) {
    console.log('  ! ' + x.key + '  已 ' + x.daysSinceSeen + ' 天未确认  ' + String(x.value).slice(0, 40));
    console.log('      来源 ' + x.source);
  }
  console.log('');
  console.log('  提醒：这些条目**没有过期**，只是**很久没人确认**。建议复核或续期。');
  console.log('');
  process.exit(3);   // WARN：有陈旧项，提醒而非失败
}
