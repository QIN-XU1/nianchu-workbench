#!/usr/bin/env node
/**
 * 功能对照实验（P1 成本核算 / P2 记忆老化 / P6 记忆冲突 / P8 审计留痕）
 *
 * ── 为什么需要它 ───────────────────────────────────────────────
 * audit-lead 判 UNKNOWN 的那 4 项，卡在「每千文件命中率」——它量的是**词汇散布**，
 * 不是能力强度。项目自己的结论是：「强度需功能对照实验，不是继续数痕迹」。
 *
 * 所以这里不数痕迹，而是给每个能力定义**行为契约**（正常路径 + 反例），
 * 用真实实现跑出可复算结果。证据落在 evidence/benchmark/functional-contrast.json。
 *
 * ── 诚实边界（必须一起读）────────────────────────────────────────
 * · 本实验证明：**我方每个能力满足一份明确、可复算的行为契约**（不是"有这个词"）。
 * · 它**不**证明：我方比某个对手"更强"。对手实现不可在本机运行（多为闭源/需登录），
 *   无法做同输入对打的强度对照；本文件只把"我方达标"这一半做实，另一半不夸大。
 *
 * 用法：node tools/benchmark/functional-contrast.mjs   退出码 0 全过 / 1 有失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tableFromCatalog, costOf } from '../cost/pricing.mjs';
import { emptyLedger, appendEntry, summarize as summarizeCost } from '../cost/ledger.mjs';
import {
  M, effectiveState, isExpired, ttlRemainingSec, collectGarbage, auditAging,
} from '../memory/ttl.mjs';
import { classify, resolveConflict, revertTo } from '../memory/conflict.mjs';
import {
  emptyLedger as emptyAo, append as aoAppend, verifyChain, loadLedger as loadAo,
} from '../ledger/append-only.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'evidence/benchmark/functional-contrast.json');

const results = [];
const rec = (probe, name, ok, detail = '') => {
  results.push({ probe, name, ok: !!ok, detail: String(detail).slice(0, 200) });
  console.log('  ' + (ok ? '✓' : '✗') + ' [' + probe + '] ' + name + (ok ? '' : '  ← ' + detail));
};

console.log('');
console.log('  功能对照实验（行为契约 + 反例，非痕迹计数）');
console.log('  ' + '='.repeat(72));

// ══════════════════════════════════════════════════════════════
// P1 成本核算：单价表 → 单条金额 → 台账汇总，全部可复算；无价不记 0
// ══════════════════════════════════════════════════════════════
console.log('\n▶ P1 成本核算');
{
  const cat = {
    data: [
      { id: 'm-priced', pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003', input_cache_write: '0.00000375' } },
      { id: 'm-free', pricing: { prompt: '0', completion: '0' } },
      { id: 'm-unpriced' }, // 无价
      { id: 'm-bad', pricing: { prompt: 'abc', completion: '1' } }, // 声明了价格但读不懂
    ],
  };
  const t = tableFromCatalog(cat);
  rec('P1', '单价表解析：priced=2 / unpriced=2', t.state === 'PASS' && t.priced === 2 && t.unpriced === 2, JSON.stringify({ priced: t.priced, unpriced: t.unpriced }));

  const price = t.table['m-priced'];
  // 1000 输入 + 500 输出 + 2000 缓存读 + 100 缓存写
  const usd = costOf(price, { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 100 });
  const expect = 1000 * 3e-6 + 500 * 15e-6 + 2000 * 0.3e-6 + 100 * 3.75e-6; // = 0.010425
  rec('P1', '单条金额精确可复算（到 1e-12）', Math.abs(usd - expect) < 1e-12, 'usd=' + usd + ' expect=' + expect);

  rec('P1', '★反例：声明价格但读不懂 → 记无价(null)，绝不记 0', t.table['m-bad'] === null, String(t.table['m-bad']));
  rec('P1', '★反例：无价条目 → costOf 返回 null（不是 0）', costOf(null, { input: 999 }) === null, String(costOf(null, { input: 999 })));

  const led = emptyLedger();
  appendEntry(led, { model: 'm-priced', input: 1000, output: 500, usd });
  appendEntry(led, { model: 'm-unpriced', input: 999, output: 1, usd: null, why: '无单价' });
  rec('P1', '★反例：usd=NaN 的条目被拒（不许伪造金额）', appendEntry(led, { model: 'x', usd: NaN }).ok === false);
  const sum = summarizeCost(led);
  rec('P1', '台账汇总：无价条目不混进总额', sum.priced === 1 && sum.unpriced === 1 && Math.abs(sum.totalUsd - usd) < 1e-12, JSON.stringify(sum));

  // 复算：同一批条目重算总额一致
  const led2 = emptyLedger();
  appendEntry(led2, { model: 'm-priced', input: 1000, output: 500, usd: costOf(price, { input: 1000, output: 500 }) });
  rec('P1', '重算一致（同输入 → 同金额）', Math.abs(summarizeCost(led2).totalUsd - (1000 * 3e-6 + 500 * 15e-6)) < 1e-12);
}

// ══════════════════════════════════════════════════════════════
// P2 记忆老化：TTL 由注入时钟算出；四态优先级；过期保留历史；gc 保守
// ══════════════════════════════════════════════════════════════
console.log('\n▶ P2 记忆老化（TTL）');
{
  const now = new Date('2026-06-01T12:00:00Z');
  const past = '2026-06-01T11:00:00Z';
  const future = '2026-06-02T12:00:00Z';
  const e = (id, extra = {}) => ({ id, key: 'k-' + id, ...extra });

  rec('P2', '无 TTL → fresh', effectiveState(e('a'), now) === M.FRESH);
  rec('P2', 'expiresAt 已过 → expired', effectiveState(e('b', { expiresAt: past }), now) === M.EXPIRED);
  rec('P2', 'expiresAt 未到 → fresh', effectiveState(e('c', { expiresAt: future }), now) === M.FRESH);
  rec('P2', '★优先级：已被推翻 + 已过期 → 仍报 superseded（推翻更强）',
    effectiveState(e('d', { state: M.SUPERSEDED, expiresAt: past }), now) === M.SUPERSEDED);
  rec('P2', 'ttlRemainingSec 计算精确', ttlRemainingSec(e('e', { expiresAt: future }), now) === 86400);

  const entries = [
    e('x', { state: M.SUPERSEDED, expiresAt: past }), // 既过期又被推翻 → 删
    e('y', { expiresAt: past }),                       // 仅过期 → 保留历史
    e('z', { state: M.SUPERSEDED }),                   // 仅被推翻 → 保留
  ];
  const gc = collectGarbage(entries, { now });
  rec('P2', 'gc 只删「既过期又被推翻」，仅过期/仅推翻都保留历史',
    gc.removed.length === 1 && gc.removed[0].id === 'x' && gc.kept.length === 2, JSON.stringify(gc.removed));

  const manyExpired = Array.from({ length: 10 }, (_, i) => e('m' + i, { expiresAt: past }));
  const audit = auditAging(manyExpired, { now });
  rec('P2', '★反例：大面积过期不许静默 PASS（≥50% 判 WARN）', audit.state === 'WARN' && audit.problems.length > 0, audit.state);

  const conflictedAudit = auditAging([e('c1', { state: M.CONFLICTED })], { now });
  rec('P2', '★反例：存在未解决冲突 → FAIL（不许自动选边）', conflictedAudit.state === 'FAIL', conflictedAudit.state);
}

// ══════════════════════════════════════════════════════════════
// P6 记忆冲突/推翻：冲突须显式裁决 + 留理由；旧值永远可查
// ══════════════════════════════════════════════════════════════
console.log('\n▶ P6 记忆冲突/推翻');
{
  const now = new Date('2026-06-01T12:00:00Z');
  const db = () => ({
    entries: [
      { id: 'v1', key: 'lang', value: 'TypeScript', state: M.CONFLICTED },
      { id: 'v2', key: 'lang', value: 'Rust', state: M.CONFLICTED },
      { id: 'other', key: 'color', value: 'blue', state: M.FRESH },
    ],
  });
  const d = db();
  const cls = classify(d.entries.filter((x) => x.key === 'lang'), now);
  rec('P6', '同 key 冲突 → ambiguous=true（不藏冲突）', cls.ambiguous === true && cls.conflicted.length === 2, JSON.stringify({ live: cls.liveCount, conf: cls.conflicted.length }));

  rec('P6', '★反例：不写理由的 resolve 被拒', resolveConflict(d, { key: 'lang', chooseId: 'v2', why: '   ' }).ok === false);

  const r = resolveConflict(d, { key: 'lang', chooseId: 'v2', why: '项目已改用 Rust', now, by: 'user' });
  const v1 = d.entries.find((x) => x.id === 'v1');
  const v2 = d.entries.find((x) => x.id === 'v2');
  rec('P6', '显式 resolve：被弃条目 superseded + supersededBy 指向选中项',
    r.ok && v1.state === M.SUPERSEDED && v1.supersededBy === 'v2' && v2.state === M.FRESH && v2.resolveWhy === '项目已改用 Rust');
  rec('P6', '旧值仍可查（superseded 条目没被删除）', d.entries.some((x) => x.id === 'v1' && x.value === 'TypeScript'));

  const d2 = db();
  d2.entries[1].expiresAt = '2026-06-01T00:00:00Z'; // v2 过期
  rec('P6', '★反例：不能选一条已过期的条目（会让冲突被静默抹平）',
    resolveConflict(d2, { key: 'lang', chooseId: 'v2', why: 'x', now }).ok === false);

  const d3 = {
    entries: [
      { id: 'old', key: 'model', value: 'A', state: M.SUPERSEDED },
      { id: 'cur', key: 'model', value: 'B', state: M.FRESH },
    ],
  };
  const rv = revertTo(d3, { key: 'model', toEntryId: 'old', why: 'A 更稳', now, by: 'user' });
  rec('P6', '回滚：当前值 superseded、目标值 fresh、全程留痕',
    rv.ok && d3.entries.find((x) => x.id === 'cur').state === M.SUPERSEDED && d3.entries.find((x) => x.id === 'old').state === M.FRESH && d3.entries.find((x) => x.id === 'old').revertWhy === 'A 更稳');
}

// ══════════════════════════════════════════════════════════════
// P8 审计留痕 append-only：只追加；改嵌套字段/截尾/损坏都查得出；无值不造
// ══════════════════════════════════════════════════════════════
console.log('\n▶ P8 审计留痕（append-only）');
{
  const led = emptyAo();
  aoAppend(led, { turn: 1, tokens: { input: 100, output: 50 }, usd: 0.01 });
  aoAppend(led, { turn: 2, tokens: { input: 200, output: 80 }, usd: 0.02 });
  aoAppend(led, { turn: 3, value: undefined });
  rec('P8', '追加 3 条 → 链校验通过，count/tail 锚点正确',
    verifyChain(led).ok && led.count === 3 && typeof led.tail === 'string', JSON.stringify(verifyChain(led)));

  rec('P8', '★反例：无值不许造（value=undefined 记 null 并标 why）',
    led.entries[2].value === null && Boolean(led.entries[2].why));

  // 篡改嵌套字段（旧实现哈希不覆盖嵌套会漏检，这里必须检出）
  const tampered = JSON.parse(JSON.stringify(led));
  tampered.entries[0].tokens.input = 999;
  rec('P8', '★反例：改写嵌套字段 tokens.input → 链校验 FAIL',
    verifyChain(tampered).ok === false, JSON.stringify(verifyChain(tampered)));

  // 尾部截断（pop 一条但不同步 count）
  const truncated = JSON.parse(JSON.stringify(led));
  truncated.entries.pop();
  rec('P8', '★反例：尾部截断（pop 未同步 count）→ 检出条数不符',
    verifyChain(truncated).ok === false);

  // 损坏文件 fail-closed
  const tmp = path.join(ROOT, 'evidence/benchmark/_ao_probe.json');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, '{ not valid json ', 'utf8');
  const loaded = loadAo(tmp);
  rec('P8', '★反例：文件损坏 → 标记 corrupt 且链校验 FAIL（不冒充空台账）',
    loaded.corrupt === true && verifyChain(loaded).ok === false);
  fs.rmSync(tmp, { force: true });

  // 历史被改后再追加必须被拒
  const t2 = JSON.parse(JSON.stringify(led));
  t2.entries[1].usd = 999;
  rec('P8', '★反例：历史被改后再 append → 拒绝追加', aoAppend(t2, { turn: 4 }).ok === false);
}

// ══════════════════════════════════════════════════════════════
const byProbe = {};
for (const r of results) {
  const p = (byProbe[r.probe] ||= { pass: 0, fail: 0, total: 0 });
  p.total++;
  r.ok ? p.pass++ : p.fail++;
}
const total = results.length;
const failed = results.filter((r) => !r.ok);
const state = failed.length === 0 ? 'PASS' : 'FAIL';

console.log('\n' + '─'.repeat(74));
for (const [p, v] of Object.entries(byProbe)) {
  console.log('  ' + p + ': ' + v.pass + '/' + v.total + (v.fail ? '  ✗' : '  ✓'));
}
console.log('  合计：通过 ' + (total - failed.length) + ' · 失败 ' + failed.length);
console.log('  四态: ' + state + (state === 'PASS'
  ? ' —— 四个能力均满足明确行为契约（含反例全部成立）'
  : ' —— 有行为契约不成立'));
console.log('  ⚠ 只证明「我方达标」，不证明「比对手强」（对手不可本机执行，强度对照另需实测）');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  what: '功能对照实验（P1/P2/P6/P8 行为契约）',
  at: new Date().toISOString(),
  state,
  summary: { total, pass: total - failed.length, fail: failed.length, byProbe },
  caveat: '只证明我方满足明确行为契约（含反例）；不证明对手更强/更弱，强度需对对手可执行实测。',
  results,
}, null, 2) + '\n', 'utf8');
console.log('  → ' + path.relative(ROOT, OUT));
console.log('');
process.exit(failed.length === 0 ? 0 : 1);
