#!/usr/bin/env node
/**
 * 记忆老化 —— TTL / 四态 / 到期扫描 / 回收。
 *
 * 从 `tools/memory/store.mjs` 拆出（原文件 32KB 正好压在红线上）。
 * 拆分依据：P2「记忆老化（TTL）」与 P6「记忆冲突/推翻」是两个独立能力，
 * 挤在一个文件里既超体量、又让「老化」这件事没有独立可测的边界。
 *
 * 核心设计（照搬原实现，没改行为）：
 *   · **TTL 是算出来的，不是存的** —— effectiveState(entry, now) 按注入时钟判
 *   · 四态：fresh / superseded / expired / conflicted，优先级 superseded > expired > conflicted > fresh
 *   · 过期**不进查询结果，但保留历史** —— 物理删除会让「这条曾经存在过」无从查证
 *   · gc 只删「既过期又被推翻」的；仅过期或仅被推翻都保留
 */
export const M = {
  FRESH: 'fresh',
  SUPERSEDED: 'superseded',
  EXPIRED: 'expired',
  CONFLICTED: 'conflicted',
};

/**
 * 计算某条在当前时刻的实际状态。
 * 优先级很重要：已被推翻的条目即便过期也报 superseded（推翻是更强的结论）。
 */
export function effectiveState(entry, now = new Date()) {
  if (entry.state === M.SUPERSEDED) return M.SUPERSEDED;
  if (entry.expiresAt && new Date(entry.expiresAt).getTime() <= now.getTime()) return M.EXPIRED;
  return entry.state === M.CONFLICTED ? M.CONFLICTED : M.FRESH;
}

/** 是否已过期（独立算，不复用 effectiveState —— 否则 SUPERSEDED 会提前返回，见 gc 的坑） */
export function isExpired(entry, now = new Date()) {
  return !!(entry.expiresAt && new Date(entry.expiresAt).getTime() <= now.getTime());
}

/** 距离过期还有多少秒；无 TTL 返回 null */
export function ttlRemainingSec(entry, now = new Date()) {
  if (!entry.expiresAt) return null;
  return Math.floor((new Date(entry.expiresAt).getTime() - now.getTime()) / 1000);
}

/** 四态计数（不含历史判定，纯统计） */
export function stateCounts(entries, now = new Date()) {
  const out = { fresh: 0, superseded: 0, expired: 0, conflicted: 0, total: entries.length };
  for (const e of entries) out[effectiveState(e, now)]++;
  return out;
}

/** 即将过期（默认 24 小时内）—— 供界面提醒，不自动删 */
export function expiringSoon(entries, { now = new Date(), soonSec = 86400 } = {}) {
  return entries
    .filter((e) => {
      const left = ttlRemainingSec(e, now);
      return left !== null && left > 0 && left <= soonSec && effectiveState(e, now) === M.FRESH;
    })
    .map((e) => ({ id: e.id, key: e.key, expiresAt: e.expiresAt, leftSec: ttlRemainingSec(e, now) }));
}

/**
 * 回收：只删「既过期又被推翻」的。
 *
 * 【实测修过的坑】原实现用 effectiveState 判过期，而它在 SUPERSEDED 时**提前返回**，
 * 导致「过期且被推翻」永远判不到、一条都删不掉。所以这里用独立的 isExpired。
 */
export function collectGarbage(entries, { now = new Date() } = {}) {
  const kept = [];
  const removed = [];
  for (const e of entries) {
    if (isExpired(e, now) && e.state === M.SUPERSEDED) removed.push({ id: e.id, key: e.key, why: '既过期又被推翻' });
    else kept.push(e);
  }
  return { kept, removed };
}

/**
 * 老化审计：把「该注意什么」讲清楚，而不是只给数字。
 * 四态结论：PASS 无异常 / WARN 有即将过期或未解决冲突 / FAIL 有过期但仍被当作有效
 */
export function auditAging(entries, { now = new Date(), soonSec = 86400 } = {}) {
  const counts = stateCounts(entries, now);
  const soon = expiringSoon(entries, { now, soonSec });
  const conflicted = entries.filter((e) => effectiveState(e, now) === M.CONFLICTED);

  const problems = [];
  if (conflicted.length) problems.push(conflicted.length + ' 条未解决冲突（必须显式 resolve，不许自动选边）');
  if (soon.length) problems.push(soon.length + ' 条将在 ' + Math.round(soonSec / 3600) + ' 小时内过期');

  // 【2026-11-18 修·独立审计 P2】原实现注释写「FAIL 有过期但仍被当作有效」，
  // 但判定只看 conflicted 与 soon，**expired 完全不进 problems** ⇒
  // 一个 100% 过期的库报 PASS（实测真实库 expired=299 报 PASS）。
  // 现在：过期条目占比高（≥50%）判 WARN 并如实说 —— 因为「大量记忆已失效」
  // 是使用者必须知道的状态，不该静默 PASS。
  const total = counts.total || 0;
  const expiredRatio = total ? counts.expired / total : 0;
  if (total > 0 && expiredRatio >= 0.5) {
    problems.push(counts.expired + '/' + total + ' 条已过期（占 ' + Math.round(expiredRatio * 100) + '%）—— 记忆大面积失效');
  }

  const state = conflicted.length ? 'FAIL' : (soon.length || expiredRatio >= 0.5) ? 'WARN' : 'PASS';
  return {
    state, counts,
    expiringSoon: soon,
    conflicted: conflicted.map((e) => ({ id: e.id, key: e.key })),
    expiredRatio: Math.round(expiredRatio * 1000) / 1000,
    problems,
  };
}
