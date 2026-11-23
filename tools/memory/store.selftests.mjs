#!/usr/bin/env node
/**
 * store.mjs 的扩展自检 —— 冲突 / 回滚 / 分歧类型
 *
 * 【为什么单独一个文件】
 * tools/memory/store.mjs 曾长到 42.2KB，超了 B4 单文件红线 32KB。
 * 本项目的纪律是「超红线必须拆」，而**加白名单就是抬基线** ——
 * 那正是这个项目一直在抓的「看起来解决了实际上没有」。
 *
 * 拆法：生产代码留在 store.mjs，**测试代码移到独立文件**。
 * 测试不是生产代码，不该占生产文件的体量。
 *
 * 用法：node tools/memory/store.selftests.mjs
 */

import { put, get, effectiveState, audit, resolve, revert, checkExpectHash, DISAGREEMENT, M } from './store.mjs';

export function selfTestConflict() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);
  const now0 = new Date('2026-01-01T00:00:00Z');
  const t1 = new Date(now0.getTime() + 1000);
  const t2 = new Date(now0.getTime() + 2000);

  // ── 反例 1（核心）：两条可信来源不一致时，不许静默选边 ──
  let db = { entries: [] };
  put(db, { key: 'port', value: '8080', source: 'file:a.yaml:3', now: now0, onConflict: 'flag' });
  const r2 = put(db, { key: 'port', value: '9090', source: 'file:b.yaml:7', now: t1, onConflict: 'flag' });
  T('反例 · 冲突模式下不许把旧条目标 superseded',
    db.entries.every((e) => e.state !== M.SUPERSEDED),
    db.entries.map((e) => e.state).join(','));
  T('反例 · 冲突模式下两条都保留', db.entries.length === 2, 'entries=' + db.entries.length);

  // ── 反例 2：get 不许随便返回一个当有效值 ──
  const g = get(db, 'port', { now: t2 });
  T('反例 · 有冲突时 get 的 live 必须是 null（不许随便挑一条）',
    g.live === null && g.ambiguous === true, 'live=' + JSON.stringify(g.live) + ' ambiguous=' + g.ambiguous);

  // ── 反例 3：resolve 必须写理由 ──
  const badResolve = resolve(db, { key: 'port', chooseId: db.entries[1].id, why: '', now: t2 });
  T('反例 · resolve 无理由 → 拒绝（冲突解决不许无痕）',
    badResolve.ok === false && /理由/.test(badResolve.why), JSON.stringify(badResolve));

  // ── 反例 4：resolve 不许选一个已被推翻的 ──
  db.entries[0].state = M.SUPERSEDED;   // 人为造一个已推翻的
  const badPick = resolve(db, { key: 'port', chooseId: db.entries[0].id, why: '想选它', now: t2 });
  T('反例 · resolve 选已推翻的条目 → 拒绝', badPick.ok === false, JSON.stringify(badPick));
  db.entries[0].state = M.CONFLICTED;

  // ── 正例 1：合法 resolve 后只剩一条有效，且留痕 ──
  const good = resolve(db, { key: 'port', chooseId: db.entries[1].id, why: 'b.yaml 是部署实际使用的配置', now: t2 });
  T('正例 · 合法 resolve 成功', good.ok === true && good.rejected.length === 1, JSON.stringify(good));
  const g2 = get(db, 'port', { now: t2 });
  T('正例 · resolve 后 get 返回被选中的值', g2.live && g2.live.value === '9090', JSON.stringify(g2.live && g2.live.value));
  T('正例 · resolve 留痕（理由 + 被拒候选）',
    g2.live && g2.live.resolution && g2.live.resolution.why && g2.live.resolution.rejected.length === 1,
    JSON.stringify(g2.live && g2.live.resolution));

  // ── 反例 5：默认模式仍是 supersede（向后兼容，不许悄悄改语义）──
  let db2 = { entries: [] };
  put(db2, { key: 'x', value: 'a', source: 'f:a:1', now: now0 });
  const dflt = put(db2, { key: 'x', value: 'b', source: 'f:b:1', now: t1 });
  T('反例 · 默认（不传 onConflict）仍是 supersede —— 不许悄悄改语义',
    dflt.action === 'supersede', JSON.stringify(dflt));

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

export function selfTestRevert() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);
  const t0 = new Date('2026-01-01T00:00:00Z');
  const t1 = new Date(t0.getTime() + 1000);
  const t2 = new Date(t0.getTime() + 2000);
  const t3 = new Date(t0.getTime() + 3000);

  // 造一个「A → B」的历史
  const db = { entries: [] };
  const a = put(db, { key: 'k', value: 'A', source: 'f:a:1', now: t0 });
  put(db, { key: 'k', value: 'B', source: 'f:b:1', now: t1 });
  const g1 = get(db, 'k', { now: t1 });
  T('准备 · 当前值是 B', g1.live && g1.live.value === 'B', JSON.stringify(g1.live && g1.live.value));

  // ── 反例 1：回滚必须写理由 ──
  const bad = revert(db, { key: 'k', toEntryId: a.id, why: '', now: t2 });
  T('反例 · revert 无理由 → 拒绝（回滚也要留痕）', bad.ok === false && /理由/.test(bad.why), JSON.stringify(bad));

  // ── 反例 2：不存在的目标 → 拒绝 ──
  const bad2 = revert(db, { key: 'k', toEntryId: 'mem-ghost', why: '试试', now: t2 });
  T('反例 · 回到不存在的条目 → 拒绝', bad2.ok === false, JSON.stringify(bad2));

  // ── 正例 1：回滚成功，当前值变回 A ──
  const good = revert(db, { key: 'k', toEntryId: a.id, why: 'B 的来源被证明是错的', now: t2 });
  T('正例 · revert 成功', good.ok === true && good.revertedFrom.length === 1, JSON.stringify(good));
  const g2 = get(db, 'k', { now: t2 });
  T('正例 · 回滚后当前值回到 A', g2.live && g2.live.value === 'A', JSON.stringify(g2.live && g2.live.value));
  T('正例 · 回滚留痕（理由 + 被回滚的条目）',
    g2.live && g2.live.revertedTo && g2.live.revertedTo.why && g2.live.revertedTo.revertedFrom.length === 1,
    JSON.stringify(g2.live && g2.live.revertedTo));

  // ── 反例 3（核心）：乐观并发 —— 期望 hash 不符必须拒绝 ──
  const cur = get(db, 'k', { now: t2 }).live;
  const badHash = put(db, { key: 'k', value: 'C', source: 'f:c:1', now: t3, expectHash: 'deadbeef' });
  T('反例 · 乐观并发：期望 hash 不符 → 拒绝（防丢失更新）',
    badHash.ok === false && /乐观并发/.test(badHash.why), JSON.stringify(badHash));

  // ── 正例 2：期望 hash 相符 → 允许 ──
  const goodHash = put(db, { key: 'k', value: 'C', source: 'f:c:1', now: t3, expectHash: cur.valueHash });
  T('正例 · 乐观并发：期望 hash 相符 → 允许', goodHash.ok === true, JSON.stringify(goodHash));

  // ── 反例 4：没有当前值却声称知道 hash → 拒绝 ──
  const noLive = checkExpectHash(db, 'never-existed', 'abc123', t3);
  T('反例 · 无有效值却声称 hash → 拒绝', noLive.ok === false, JSON.stringify(noLive));

  const badCases = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - badCases.length, total: cases.length, ok: badCases.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

export function selfTestDisagreement() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);
  const t0 = new Date('2026-01-01T00:00:00Z');
  const t1 = new Date(t0.getTime() + 1000);

  const mk = () => {
    const db = { entries: [] };
    put(db, { key: 'k', value: 'A', source: 'f:a:1', now: t0 });
    return db;
  };

  // ── 反例 1：未知分歧类型 → 拒绝 ──
  const bad = put(mk(), { key: 'k', value: 'B', source: 'f:b:1', now: t1, disagreement: 'i-dont-know' });
  T('反例 · 未知分歧类型 → 拒绝', bad.ok === false && /未知的分歧类型/.test(bad.why), JSON.stringify(bad));

  // ── 正例 1：correction → 自动取代，且记录类型 ──
  let db = mk();
  const r1 = put(db, { key: 'k', value: 'B', source: 'f:b:1', now: t1, disagreement: DISAGREEMENT.CORRECTION });
  T('正例 · correction → 自动取代且记录类型',
    r1.ok && r1.action === 'supersede' && r1.disagreement.kind === 'correction' && r1.disagreement.assumed === false,
    JSON.stringify(r1));

  // ── 正例 2：temporal_change → 也自动取代（不是冲突，是演进）──
  db = mk();
  const r2 = put(db, { key: 'k', value: 'B', source: 'f:b:1', now: t1, disagreement: DISAGREEMENT.TEMPORAL });
  T('正例 · temporal_change → 自动取代（事实演进不是冲突）',
    r2.ok && r2.action === 'supersede' && r2.disagreement.kind === 'temporal_change',
    JSON.stringify(r2));

  // ── 反例 2（核心）：source_conflict → 不许自动选边 ──
  db = mk();
  const r3 = put(db, { key: 'k', value: 'B', source: 'f:b:1', now: t1, disagreement: DISAGREEMENT.SOURCE_CONFLICT });
  T('反例 · source_conflict → **不许自动取代**，必须记为冲突',
    r3.ok && r3.action === 'conflict' && r3.disagreement.kind === 'source_conflict',
    JSON.stringify(r3));
  const g = get(db, 'k', { now: t1 });
  T('反例 · source_conflict 后 get 无有效值（要人判断）',
    g.live === null && g.ambiguous === true, JSON.stringify({ live: g.live, amb: g.ambiguous }));

  // ── 反例 3：不声明分歧类型 → 记为「假定的纠正」并标 assumed ──
  db = mk();
  const r4 = put(db, { key: 'k', value: 'B', source: 'f:b:1', now: t1 });
  T('反例 · 未声明分歧类型 → 记 assumed:true（不许装作已声明）',
    r4.ok && r4.disagreement.assumed === true && r4.disagreement.kind === 'correction',
    JSON.stringify(r4.disagreement));

  // ── 正例 3：audit 能数出「假定的纠正」 ──
  const a = audit(db, { now: t1 });
  T('正例 · audit 统计「假定的纠正」条数', a.assumedCorrections === 1, JSON.stringify({ n: a.assumedCorrections }));

  // ── 正例 4：明确声明 correction 的不算 assumed ──
  db = mk();
  put(db, { key: 'k', value: 'B', source: 'f:b:1', now: t1, disagreement: DISAGREEMENT.CORRECTION });
  const a2 = audit(db, { now: t1 });
  T('正例 · 明确声明的不计入 assumed', a2.assumedCorrections === 0, JSON.stringify({ n: a2.assumedCorrections }));

  const badCases = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - badCases.length, total: cases.length, ok: badCases.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

/** 本文件的全部自检 */

/** 自检 —— C3 记忆老化的「即将过期」预警 */
export function selfTestExpiringSoon() {
  const cases = [];
  const T2 = (n, ok, why) => cases.push([n, !!ok, why]);
  const t0 = new Date('2026-01-01T00:00:00Z');
  const t0ms = t0.getTime();

  const mk = () => {
    const db = { entries: [] };
    // A：1 小时后过期（在 24h 窗口内）
    put(db, { key: 'a', value: '1', source: 'f:a:1', ttlSec: 3600, now: t0 });
    // B：30 天后过期（不在窗口内）
    put(db, { key: 'b', value: '2', source: 'f:b:1', ttlSec: 30 * 86400, now: t0 });
    // C：无 TTL（永不过期）
    put(db, { key: 'c', value: '3', source: 'f:c:1', now: t0 });
    return db;
  };

  // ── 正例 1：只报窗口内的那一条 ──
  const a1 = audit(mk(), { now: t0, soonSec: 86400 });
  T2('正例 · 24h 窗口内只报 1 小时后过期的那条',
    a1.expiringSoon.length === 1 && a1.expiringSoon[0].key === 'a',
    JSON.stringify(a1.expiringSoon.map((x) => x.key)));

  // ── 反例 1（核心）：30 天后过期的不许被算成「即将过期」──
  T2('反例 · 30 天后过期的不许进 24h 窗口（窗口必须真生效）',
    !a1.expiringSoon.some((x) => x.key === 'b'), JSON.stringify(a1.expiringSoon.map((x) => x.key)));

  // ── 反例 2：无 TTL 的不许被算成即将过期 ──
  T2('反例 · 无 TTL 的不许进即将过期（永不过期 ≠ 快过期）',
    !a1.expiringSoon.some((x) => x.key === 'c'), '');

  // ── 反例 3：已过期的不许混进「即将过期」（那是 expired，不是 soon）──
  const db2 = { entries: [] };
  put(db2, { key: 'd', value: '4', source: 'f:d:1', ttlSec: 60, now: t0 });
  const a2 = audit(db2, { now: new Date(t0ms + 3600 * 1000), soonSec: 86400 });
  T2('反例 · 已过期的不许进即将过期（分属两个状态）',
    a2.expiringSoon.length === 0 && a2.expired.length === 1,
    'soon=' + a2.expiringSoon.length + ' expired=' + a2.expired.length);

  // ── 正例 2：窗口放宽到 31 天，B 应该进来 ──
  const a3 = audit(mk(), { now: t0, soonSec: 31 * 86400 });
  T2('正例 · 窗口放宽后 30 天那条进来',
    a3.expiringSoon.some((x) => x.key === 'b'), JSON.stringify(a3.expiringSoon.map((x) => x.key)));

  // ── 反例 4：soonSec=0 时不许误报（明确关闭预警）──
  const a4 = audit(mk(), { now: t0, soonSec: 0 });
  T2('反例 · soonSec=0 必须为空（显式关闭预警，不许默认乱报）',
    a4.expiringSoon.length === 0, JSON.stringify(a4.expiringSoon));

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

export function selfTestAll() {
  const a = selfTestConflict();
  const b = selfTestRevert();
  const c = selfTestDisagreement();
  const d = selfTestExpiringSoon();
  const ok = a.ok && b.ok && c.ok && d.ok;
  const pass = a.pass + b.pass + c.pass + d.pass;
  const total = a.total + b.total + c.total + d.total;
  return {
    ok,
    pass,
    total,
    lines: [a.lines, b.lines, c.lines, d.lines].join('\n'),
    groups: { conflict: a, revert: b, disagreement: c, expiringSoon: d },
  };
}

import path from 'node:path';
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const r = selfTestAll();
  console.log('');
  console.log('  store 扩展自检 —— 冲突 / 回滚 / 分歧类型');
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}
