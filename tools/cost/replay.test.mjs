#!/usr/bin/env node
/**
 * 会话成本回算的反例测试 —— 每条都要能红。
 * 用法：node tools/cost/replay.test.mjs
 *
 * 反例锁住的都是 ECC 真踩过的坑：
 *   · 事件里没 usage 却静默写 0（ECC v1：52 天 2340 行 0% 非零）
 *   · 累积型记录被当成增量相加（金额翻好几倍）
 *   · 无价模型当 0（成本看起来很低）
 */
import { usageOf, modelOf, parseJsonl, aggregateBySession, toLedgerRows } from './replay.mjs';

let pass = 0;
let fail = 0;
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

const line = (o) => JSON.stringify(o);

// ── usage 提取 ──
{
  const u = usageOf({ message: { usage: { input_tokens: 10, output_tokens: 5 } } });
  t('正例：从 message.usage 取到 token 数', u && u.input === 10 && u.output === 5, JSON.stringify(u));
}
{
  const u = usageOf({ usage: { prompt_tokens: 7, completion_tokens: 3 } });
  t('正例：兼容 prompt_tokens/completion_tokens', u && u.input === 7 && u.output === 3, JSON.stringify(u));
}
{
  const u = usageOf({ message: { usage: { input_tokens: 0, output_tokens: 0 } } });
  t('★反例：全 0 的 usage 必须返回 null（不许当「真的用了 0」—— 这是 ECC 那个坑的症状）',
    u === null, JSON.stringify(u));
}
{
  t('★反例：没有 usage 字段 ⇒ null', usageOf({ message: {} }) === null);
}

// ── model 提取 ──
{
  t('正例：message.model 优先', modelOf({ message: { model: 'm1' }, model: 'm2' }) === 'm1');
  t('★反例：没有模型名 ⇒ null（不许编一个）', modelOf({ message: {} }) === null);
}

// ── 解析 ──
{
  const text = [
    line({ type: 'user', message: { role: 'user', content: 'hi' } }),
    line({ session_id: 's1', ts: '2031-01-01T00:00:01Z', message: { model: 'm', usage: { input_tokens: 100, output_tokens: 50 } } }),
    '',
  ].join('\n');
  const r = parseJsonl(text);
  t('正例：解析出 1 条 usage 行', r.rows.length === 1 && r.rows[0].usage.input === 100, JSON.stringify(r.rows.length));
  t('★反例：没有 model+usage 的行被跳过并计数（不静默吞掉）', r.skipped === 1, String(r.skipped));
}
{
  const text = line({ session_id: 's1', cost_usd: 0.0123, message: { model: 'm' } });
  const r = parseJsonl(text);
  t('正例：宿主直报的 cost_usd 优先采用', r.rows.length === 1 && r.rows[0].costUsd === 0.0123 && r.rows[0].source === 'host-reported', JSON.stringify(r.rows[0]));
}
{
  const r = parseJsonl('{bad json}\n');
  t('★反例：坏行不崩，计入 skipped', r.skipped === 1 && r.rows.length === 0, JSON.stringify({ s: r.skipped }));
}
{
  const r = parseJsonl('');
  t('★反例：空输入 ⇒ 0 行（不崩）', r.rows.length === 0);
}

// ── 聚合：累积 vs 增量（关键）──
const rowsCumulative = [
  { sessionId: 's1', model: 'm', usage: { input: 100, output: 10 }, ts: '2031-01-01T00:00:01Z' },
  { sessionId: 's1', model: 'm', usage: { input: 300, output: 30 }, ts: '2031-01-01T00:00:02Z' },  // 累积到 300
  { sessionId: 's1', model: 'm', usage: { input: 600, output: 60 }, ts: '2031-01-01T00:00:03Z' },  // 累积到 600
];
{
  const a = aggregateBySession(rowsCumulative, { cumulative: true });
  t('★反例：累积型必须取最后一条（不是相加）',
    a.length === 1 && a[0].take.usage.input === 600, JSON.stringify(a[0]?.take?.usage));
}
{
  const a = aggregateBySession(rowsCumulative, { cumulative: false });
  t('正例：增量型逐条相加 = 1000', a[0].take.usage.input === 1000, String(a[0].take.usage.input));
}
{
  // 两种口径结果必须不同 —— 否则这个参数是摆设
  const c = aggregateBySession(rowsCumulative, { cumulative: true })[0].take.usage.input;
  const i = aggregateBySession(rowsCumulative, { cumulative: false })[0].take.usage.input;
  t('★反例：累积与增量口径必须产生不同结果（否则参数是假的）', c !== i, c + ' vs ' + i);
}
{
  const a = aggregateBySession([], { cumulative: true });
  t('★反例：空输入 ⇒ 空结果', a.length === 0);
}

// ── 转台账行 ──
// 【2026-11-18 修·审计员发现】原 fixture **没有 unit 字段** ——
// 整条回算链路的测试都建立在不合规的价格对象上，等于把「绕过单位校验」这个漏洞固化了。
const PRICES = { m: { prompt: 1e-6, completion: 2e-6, cacheRead: 0, cacheWrite: 0, unit: 'usd_per_token' } };
{
  const rows = toLedgerRows(aggregateBySession(rowsCumulative, { cumulative: true }), PRICES);
  const expect = 600 * 1e-6 + 60 * 2e-6;
  t('正例：能算出金额', Math.abs(rows[0].value - expect) < 1e-12, String(rows[0].value));
}
{
  const rows = toLedgerRows(aggregateBySession(rowsCumulative, { cumulative: true }), {});
  t('★反例：无价模型 ⇒ value 记 null 并标 why（不许当 0）',
    rows[0].value === null && !!rows[0].why, JSON.stringify({ v: rows[0].value, w: rows[0].why }));
}
{
  const agg = [{ sessionId: 's1', rows: 1, take: { model: null, usage: { input: 1, output: 1 } } }];
  const rows = toLedgerRows(agg, PRICES);
  t('★反例：没有模型名 ⇒ 无法定价，记 null 并说明', rows[0].value === null && /模型/.test(rows[0].why), JSON.stringify(rows[0]));
}

// ══════════════════════════════════════════════════════════════
// 以下反例来自 2026-11-18 独立审计员的报告（它判了 FAIL）。
// 每一条都对应一个它实测出来的真 bug —— 留着防止再犯。
// ══════════════════════════════════════════════════════════════

// ── 单位校验必须真的生效（原来 toLedgerRows 自己重写乘法，绕过 costOf）──
{
  const agg = [{ sessionId: 's', rows: 1, take: { model: 'm', usage: { input: 1000000 } } }];
  const perMillion = { m: { prompt: 3, completion: 15, cacheRead: 0, cacheWrite: 0, unit: 'usd_per_million_tokens' } };
  const rows = toLedgerRows(agg, perMillion);
  t('★反例：per-million 单价不许当 per-token 算（会放大 10⁶ 倍）',
    rows[0].value === null && /单位/.test(rows[0].why), JSON.stringify({ v: rows[0].value, w: rows[0].why }));
}
{
  const agg = [{ sessionId: 's', rows: 1, take: { model: 'm', usage: { input: 1 } } }];
  const noUnit = { m: { prompt: 1, completion: 1, cacheRead: 0, cacheWrite: 0 } };
  const rows = toLedgerRows(agg, noUnit);
  t('★反例：price 没有 unit 字段 ⇒ 不许当美元算', rows[0].value === null, JSON.stringify(rows[0]));
}

// ── 宿主直报金额必须被真的使用（原来解析了但 toLedgerRows 从不读）──
{
  const text = line({ session_id: 's1', cost_usd: 0.5, message: { model: 'm' } });
  const parsed = parseJsonl(text);
  const agg = aggregateBySession(parsed.rows, { cumulative: true });
  const rows = toLedgerRows(agg, PRICES);
  t('★反例：宿主直报 cost_usd 必须被采用（原来被丢弃记 null）',
    rows[0].value === 0.5, JSON.stringify({ v: rows[0].value, w: rows[0].why }));
}
{
  // cost.total_cost_usd 这个回退形状原来不可达（守卫与取值互斥）
  const text = line({ session_id: 's1', cost: { total_cost_usd: 0.25 }, message: { model: 'm' } });
  const parsed = parseJsonl(text);
  t('★反例：cost.total_cost_usd 形状必须能解析（原来 skipped:1）',
    parsed.rows.length === 1 && parsed.rows[0].costUsd === 0.25, JSON.stringify(parsed.rows));
}

// ── 负数 token ──
{
  const agg = [{ sessionId: 's', rows: 1, take: { model: 'm', usage: { input: -1000, output: 0 } } }];
  const rows = toLedgerRows(agg, PRICES);
  t('★反例：负数 token ⇒ 拒绝（否则金额为负 = 「赚了钱」）',
    rows[0].value === null && /负/.test(rows[0].why), JSON.stringify({ v: rows[0].value, w: rows[0].why }));
}

console.log('\n  会话成本回算反例测试：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
