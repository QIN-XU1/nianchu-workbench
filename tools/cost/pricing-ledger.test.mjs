#!/usr/bin/env node
/**
 * 成本模块的反例测试 —— 每条都要能红。
 * 用法：node tools/cost/pricing-ledger.test.mjs
 *
 * 这些反例锁住三条「不许看起来有实际是空」的规则：
 *   · 无价不许当 0（否则成本看起来很低 = 假绿）
 *   · 台账 append-only（不许改历史）
 *   · 复算必须能发现「价格变了导致历史金额对不上」
 */
import { tableFromCatalog, costOf, UNIT } from './pricing.mjs';
import { emptyLedger, appendEntry, summarize } from './ledger.mjs';

let pass = 0;
let fail = 0;
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

// ── 价格表 ──
{
  const r = tableFromCatalog({ data: [
    { id: 'm-priced', pricing: { prompt: 0.000001, completion: 0.000002 } },
    { id: 'm-free' },
  ] });
  t('正例：有 pricing 的模型被记为有价', r.state === 'PASS' && r.table['m-priced'].prompt === 0.000001, JSON.stringify(r).slice(0, 120));
  t('★反例：无 pricing 的模型必须记 null，不许记 0',
    r.table['m-free'] === null, JSON.stringify(r.table['m-free']));
  t('正例：priced/unpriced 分开计数', r.priced === 1 && r.unpriced === 1, r.priced + '/' + r.unpriced);
}
{
  const r = tableFromCatalog({ data: [] });
  t('★反例：空目录 ⇒ UNKNOWN（不能报 PASS 说「全部有价」）', r.state === 'UNKNOWN', JSON.stringify(r));
}
{
  const r = tableFromCatalog(null);
  t('★反例：非对象输入 ⇒ UNKNOWN', r.state === 'UNKNOWN', JSON.stringify(r));
}

// ── 价格解析失败不许当免费（2026-11-18 审计员发现）──
{
  const r = tableFromCatalog({ data: [{ id: 'bad', pricing: { prompt: 'abc', completion: 'xyz' } }] });
  t('★反例：声明了价格但解析不出数 ⇒ 必须记 null（不许记 0 且算 priced）',
    r.table.bad === null && r.priced === 0 && r.unpriced === 1, JSON.stringify({ bad: r.table.bad, p: r.priced, u: r.unpriced }));
}
{
  const r = tableFromCatalog({ data: [{ id: 'neg', pricing: { prompt: -1, completion: 1 } }] });
  t('★反例：负单价 ⇒ 记 null（负数会让成本为负）', r.table.neg === null, JSON.stringify(r.table.neg));
}
{
  const r = tableFromCatalog({ data: [{ id: 'ok', pricing: { prompt: 0, completion: 0 } }] });
  t('正例：真的 0 单价必须保留 0（免费模型是合法的）', r.table.ok !== null && r.table.ok.prompt === 0, JSON.stringify(r.table.ok));
}

// ── 单条金额 ──
{
  const price = { prompt: 1e-6, completion: 2e-6, cacheRead: 0.1e-6, cacheWrite: 0.2e-6, unit: UNIT };
  const c = costOf(price, { input: 1000, output: 500 });
  t('正例：金额可算', Math.abs(c - (1000 * 1e-6 + 500 * 2e-6)) < 1e-12, String(c));
}
{
  const c = costOf(null, { input: 1000 });
  t('★反例：无价 ⇒ 返回 null（不是 0）', c === null, String(c));
}
{
  // 【2026-11-18 修·审计员 E1】原来这里传的 price 缺 completion/cacheRead/cacheWrite，
  // `output * undefined` = NaN ⇒ Number.isFinite(NaN) 为 false ⇒ 返回 null。
  // 也就是说它**是因为 NaN 才 null，不是因为单位检查** —— 删掉单位检查这条断言依然绿。
  // 现在传**完整的** price 对象，只让 unit 这一个条件不同。
  const full = { prompt: 1, completion: 2, cacheRead: 0, cacheWrite: 0, unit: 'usd_per_million_tokens' };
  const c = costOf(full, { input: 1 });
  t('★反例：单位不符 ⇒ 返回 null（完整 price 对象，只改 unit —— 这才真的测到单位检查）',
    c === null, String(c));
  // 反证：同对象只把 unit 改对，必须算得出金额（否则上一条又可能是恒真）
  const c2 = costOf({ ...full, unit: UNIT }, { input: 1 });
  t('★反例：同对象 unit 正确 ⇒ 必须算得出（证明上一条不是恒真）', c2 === 1, String(c2));
}

// ── 台账 ──
{
  const L = emptyLedger();
  const a = appendEntry(L, { model: 'm', input: 100, usd: 0.001 });
  t('正例：能追加', a.ok === true && L.entries.length === 1, JSON.stringify(a));
  const b = appendEntry(L, { model: 'm2', input: 100, usd: null, why: '无价' });
  t('正例：无价条目也能追加（记 null）', b.ok === true && L.entries[1].usd === null, JSON.stringify(b));
}
{
  const L = emptyLedger();
  const r = appendEntry(L, { input: 100, usd: 0.001 });
  t('★反例：缺 model ⇒ 拒绝（没模型名无法复算单价）', r.ok === false, JSON.stringify(r));
}
{
  const L = emptyLedger();
  const r = appendEntry(L, { model: 'm', usd: 'NaN' });
  t('★反例：usd 是字符串 ⇒ 拒绝（不能把脏数据当金额）', r.ok === false, JSON.stringify(r));
}
{
  const L = emptyLedger();
  appendEntry(L, { model: 'm', input: 100, usd: 0.001 });
  appendEntry(L, { model: 'm', input: 100, usd: null, why: '无价' });
  const s = summarize(L);
  t('★反例：汇总时无价不许当 0 混进总额', s.totalUsd === 0.001 && s.unpriced === 1, JSON.stringify(s));
}
{
  // append-only：追加不改历史
  const L = emptyLedger();
  appendEntry(L, { model: 'm', usd: 0.001 });
  const first = JSON.stringify(L.entries[0]);
  appendEntry(L, { model: 'm', usd: 0.002 });
  t('★反例：追加不能改动已有条目（append-only）', JSON.stringify(L.entries[0]) === first, L.entries[0].usd + ' vs ' + JSON.parse(first).usd);
}

console.log('\n  成本模块反例测试：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
