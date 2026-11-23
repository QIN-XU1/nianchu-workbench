#!/usr/bin/env node
/**
 * 记忆老化 + 冲突的反例测试 —— 每条都要能红。
 * 用法：node tools/memory/ttl-conflict.test.mjs
 *
 * 这两族对应可执行对照的 P2（记忆老化 TTL）与 P6（记忆冲突/推翻）。
 * 反例锁住的都是「看起来有实际是空」的坑：
 *   · TTL 是算出来的，不是存的（改 now 就能验）
 *   · 过期不进结果但历史要留
 *   · gc 只删「既过期又被推翻」
 *   · 冲突不许自动选边、解决必须留理由、旧值永远可查
 */
import { M, effectiveState, isExpired, ttlRemainingSec, stateCounts, expiringSoon, collectGarbage, auditAging } from './ttl.mjs';
import { classify, resolveConflict, revertTo } from './conflict.mjs';

let pass = 0;
let fail = 0;
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

const NOW = new Date('2031-06-01T12:00:00Z');
const ago = (sec) => new Date(NOW.getTime() - sec * 1000).toISOString();
const ahead = (sec) => new Date(NOW.getTime() + sec * 1000).toISOString();

// ── TTL 四态 ──
{
  t('正例：fresh', effectiveState({ state: M.FRESH }, NOW) === M.FRESH);
  t('正例：superseded 优先于 expired（推翻是更强的结论）',
    effectiveState({ state: M.SUPERSEDED, expiresAt: ago(1) }, NOW) === M.SUPERSEDED);
  t('★反例：已过期 ⇒ expired', effectiveState({ state: M.FRESH, expiresAt: ago(1) }, NOW) === M.EXPIRED);
  t('★反例：未到期 ⇒ fresh', effectiveState({ state: M.FRESH, expiresAt: ahead(60) }, NOW) === M.FRESH);
  t('正例：conflicted', effectiveState({ state: M.CONFLICTED }, NOW) === M.CONFLICTED);
}
{
  t('正例：isExpired 独立判（不被 SUPERSEDED 干扰）',
    isExpired({ state: M.SUPERSEDED, expiresAt: ago(1) }, NOW) === true);
  t('★反例：无 TTL ⇒ ttlRemainingSec 返回 null（不是 0，也不是 Infinity）',
    ttlRemainingSec({}, NOW) === null);
  t('正例：剩余秒数可算', ttlRemainingSec({ expiresAt: ahead(120) }, NOW) === 120);
}

// ── 统计与提醒 ──
{
  const entries = [
    { id: 'a', key: 'k', state: M.FRESH },
    { id: 'b', key: 'k', state: M.SUPERSEDED },
    { id: 'c', key: 'k', state: M.FRESH, expiresAt: ago(10) },
    { id: 'd', key: 'k', state: M.CONFLICTED },
  ];
  const c = stateCounts(entries, NOW);
  t('正例：四态计数正确', c.fresh === 1 && c.superseded === 1 && c.expired === 1 && c.conflicted === 1, JSON.stringify(c));
  t('正例：total 等于条数', c.total === 4);
}
{
  const entries = [
    { id: 'a', key: 'soon', state: M.FRESH, expiresAt: ahead(3600) },
    { id: 'b', key: 'later', state: M.FRESH, expiresAt: ahead(86400 * 7) },
  ];
  const soon = expiringSoon(entries, { now: NOW, soonSec: 7200 });
  t('★反例：只有真正临近过期的才提醒', soon.length === 1 && soon[0].key === 'soon', JSON.stringify(soon));
}

// ── gc 的坑 ──
{
  const entries = [
    { id: 'both', key: 'k', state: M.SUPERSEDED, expiresAt: ago(1) },   // 既过期又被推翻 ⇒ 删
    { id: 'onlyExp', key: 'k', state: M.FRESH, expiresAt: ago(1) },      // 只过期 ⇒ 留
    { id: 'onlySup', key: 'k', state: M.SUPERSEDED },                    // 只被推翻 ⇒ 留
  ];
  const { kept, removed } = collectGarbage(entries, { now: NOW });
  t('★反例：gc 只删「既过期又被推翻」的',
    removed.length === 1 && removed[0].id === 'both', JSON.stringify(removed.map((x) => x.id)));
  t('★反例：仅过期或仅被推翻的都要保留', kept.length === 2, JSON.stringify(kept.map((x) => x.id)));
}

// ── 老化审计四态 ──
{
  const r = auditAging([{ id: 'a', key: 'k', state: M.FRESH }], { now: NOW });
  t('正例：无异常 ⇒ PASS', r.state === 'PASS', JSON.stringify(r.state));
}
{
  const r = auditAging([{ id: 'a', key: 'k', state: M.FRESH, expiresAt: ahead(600) }], { now: NOW, soonSec: 3600 });
  t('★反例：有临近过期 ⇒ WARN（不是 PASS）', r.state === 'WARN', JSON.stringify(r.state));
}
{
  const r = auditAging([{ id: 'a', key: 'k', state: M.CONFLICTED }], { now: NOW });
  t('★反例：有未解决冲突 ⇒ FAIL（冲突比临期严重）', r.state === 'FAIL', JSON.stringify(r.state));
}

// ── 冲突分类 ──
{
  const c = classify([{ id: 'a', key: 'k', state: M.CONFLICTED }, { id: 'b', key: 'k', state: M.CONFLICTED }], NOW);
  t('★反例：冲突模式下 ambiguous 必须为 true（不许把冲突藏起来）',
    c.ambiguous === true && c.live === null && c.conflicted.length === 2, JSON.stringify({ a: c.ambiguous, l: c.liveCount }));
}

// ── 解决与回滚 ──
const mkDb = () => ({ entries: [
  { id: 'e1', key: 'k', value: 'v1', source: 's1', state: M.CONFLICTED, createdAt: '2031-01-01' },
  { id: 'e2', key: 'k', value: 'v2', source: 's2', state: M.CONFLICTED, createdAt: '2031-01-02' },
] });
{
  const db = mkDb();
  const r = resolveConflict(db, { key: 'k', chooseId: 'e1', why: 'e1 有官方文档', now: NOW });
  t('正例：能显式解决冲突', r.ok === true && r.superseded.includes('e2'), JSON.stringify(r));
  t('★反例：解决后旧值仍可查（不是删除）',
    db.entries.find((e) => e.id === 'e2').state === M.SUPERSEDED, db.entries[1].state);
  t('★反例：解决必须留痕（理由与时间都写进去）',
    db.entries[0].resolveWhy === 'e1 有官方文档' && !!db.entries[0].resolvedAt);
}
{
  const db = mkDb();
  const r = resolveConflict(db, { key: 'k', chooseId: 'e1', why: '' });
  t('★反例：不写理由 ⇒ 拒绝（冲突解决不许无痕）', r.ok === false, JSON.stringify(r));
}
{
  const db = mkDb();
  const r = resolveConflict(db, { key: 'k', chooseId: 'nope', why: 'x' });
  t('★反例：选不存在的条目 ⇒ 拒绝', r.ok === false, JSON.stringify(r));
}
{
  const db = { entries: [
    { id: 'e1', key: 'k', value: 'v1', state: M.FRESH },
    { id: 'e2', key: 'k', value: 'v2', state: M.SUPERSEDED },
  ] };
  const r = revertTo(db, { key: 'k', toEntryId: 'e2', why: '回滚到旧版', now: NOW });
  t('正例：能回滚到历史值', r.ok === true && db.entries[1].state === M.FRESH, JSON.stringify(r));
  t('★反例：回滚也要留痕', db.entries[1].revertWhy === '回滚到旧版' && !!db.entries[1].revertedAt);
  t('★反例：回滚不许无理由', revertTo(mkDb(), { key: 'k', toEntryId: 'e1', why: '  ' }).ok === false);
}

// ══════════════════════════════════════════════════════════════
// 以下反例来自 2026-11-18 第二个独立审计员的报告（它判了 FAIL）。
// 每条都对应它实测出来的真 bug —— 留着防止再犯。
// ══════════════════════════════════════════════════════════════

// ── 冲突不许被 TTL 静默抹平（审计员 R1/R2）──
{
  const db = { entries: [
    { id: 'e1', key: 'k', value: 'v1', state: M.CONFLICTED, expiresAt: ago(3600) },   // 已过期
    { id: 'e2', key: 'k', value: 'v2', state: M.CONFLICTED, expiresAt: ahead(3600) },
  ] };
  const r = resolveConflict(db, { key: 'k', chooseId: 'e1', why: '选它', now: NOW });
  t('★反例：选一条**已过期**的条目解决冲突 ⇒ 必须拒绝（否则冲突被静默抹平）',
    r.ok === false && /过期/.test(r.why), JSON.stringify(r));
}
{
  // 反证：选未过期的那条必须成功，否则上一条可能是「一律拒绝」的假绿
  const db = { entries: [
    { id: 'e1', key: 'k', value: 'v1', state: M.CONFLICTED, expiresAt: ago(3600) },
    { id: 'e2', key: 'k', value: 'v2', state: M.CONFLICTED, expiresAt: ahead(3600) },
  ] };
  const r = resolveConflict(db, { key: 'k', chooseId: 'e2', why: '选它', now: NOW });
  t('★反例：选未过期的那条 ⇒ 必须成功（证明上一条不是一律拒绝）', r.ok === true, JSON.stringify(r));
}

// ── 回滚不许到过期条目，且要收口冲突（审计员 R3/R4）──
{
  const db = { entries: [
    { id: 'e1', key: 'k', value: 'v1', state: M.SUPERSEDED, expiresAt: ago(3600) },
    { id: 'e2', key: 'k', value: 'v2', state: M.FRESH },
  ] };
  const r = revertTo(db, { key: 'k', toEntryId: 'e1', why: '回滚', now: NOW });
  t('★反例：回滚到**已过期**条目 ⇒ 必须拒绝', r.ok === false && /过期/.test(r.why), JSON.stringify(r));
}
{
  const db = { entries: [
    { id: 'e1', key: 'k', value: 'v1', state: M.SUPERSEDED },
    { id: 'e2', key: 'k', value: 'v2', state: M.FRESH },
    { id: 'e3', key: 'k', value: 'v3', state: M.CONFLICTED },
  ] };
  const r = revertTo(db, { key: 'k', toEntryId: 'e1', why: '回滚', now: NOW });
  t('★反例：回滚时必须收口冲突条目（原来只处理 FRESH ⇒ 回滚后仍 ambiguous）',
    r.ok === true && r.superseded.includes('e3'), JSON.stringify(r));
}

// ── auditAging：大面积过期不许报 PASS（审计员 R5/R16）──
{
  const entries = [
    { id: 'a', key: 'k', state: M.FRESH, expiresAt: ago(3600) },
    { id: 'b', key: 'k', state: M.FRESH, expiresAt: ago(3600) },
  ];
  const r = auditAging(entries, { now: NOW });
  t('★反例：100% 过期 ⇒ 不许报 PASS（实测真实库 expired=299 报 PASS）',
    r.state !== 'PASS', JSON.stringify({ s: r.state, p: r.problems }));
  t('★反例：过期必须在 problems 里说出来', (r.problems || []).some((p) => /过期/.test(p)), JSON.stringify(r.problems));
}
{
  const entries = [
    { id: 'a', key: 'k', state: M.FRESH, expiresAt: ahead(86400 * 7) },
    { id: 'b', key: 'k', state: M.FRESH, expiresAt: ahead(86400 * 7) },
  ];
  const r = auditAging(entries, { now: NOW });
  t('正例：全都没过期 ⇒ PASS（证明上一条不是一律 WARN）', r.state === 'PASS', JSON.stringify(r.state));
}

// ── 存活变异体 M5：不能选已被推翻的条目（审计员删掉这条保护，测试仍绿）──
{
  const db = { entries: [
    { id: 'e1', key: 'k', value: 'v1', state: M.SUPERSEDED },
    { id: 'e2', key: 'k', value: 'v2', state: M.CONFLICTED },
  ] };
  const r = resolveConflict(db, { key: 'k', chooseId: 'e1', why: '选它', now: NOW });
  t('★反例：不能选一条**已被推翻**的条目（M5 变异体要能被抓到）',
    r.ok === false && /推翻/.test(r.why), JSON.stringify(r));
}

// ── 存活变异体 M11：inboxOf 必须返回拷贝，不许泄漏内部数组 ──
// 这条在 bus.test.mjs 里，但审计员删掉 slice() 后 21/21 仍绿，所以在这里补一条更硬的。
console.log('\n  记忆老化+冲突反例测试：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
