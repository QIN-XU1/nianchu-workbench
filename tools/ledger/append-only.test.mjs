#!/usr/bin/env node
/**
 * append-only 基元的反例测试 —— 每条都要能红。
 * 用法：node tools/ledger/append-only.test.mjs
 *
 * 【2026-11-18 重写】独立审计员判 FAIL，给出 4 个可复现反例：
 *   ① 嵌套对象被改，链仍 ok（原 hash 用 array replacer，嵌套一律序列化成 {}）
 *   ② 文件损坏/清空 fail-open（截断 JSON → 空台账 → 报 ok:true）
 *   ③ 尾部截断不可检测（pop 一条或删光都 ok）
 *   ④ append 不校验历史（注释承诺了但代码没做）
 * 现在每一条都有一组反例盯着。**这些反例必须能真的报红** —— 审计员用变异测试
 * 证明过原测试有「断言恒真」的情况，所以这里每条都尽量让「改坏实现」能红。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyLedger, append, verifyChain, summarize, canon, loadLedger, saveLedger, APPEND_ONLY_VERSION } from './append-only.mjs';

let pass = 0;
let fail = 0;
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

// ── canon：深度规范化（这是 ① 的根）──
{
  t('正例：canon 稳定（键序无关）', canon({ b: 1, a: 2 }) === canon({ a: 2, b: 1 }), canon({ b: 1, a: 2 }));
  t('★反例：canon 必须覆盖**嵌套**字段（原实现丢成 {}）',
    canon({ meta: { amount: 10 } }) === '{"meta":{"amount":10}}', canon({ meta: { amount: 10 } }));
  t('★反例：canon 必须覆盖数组里的对象', canon({ xs: [{ a: 1 }] }) === '{"xs":[{"a":1}]}', canon({ xs: [{ a: 1 }] }));
  t('★反例：嵌套值不同 ⇒ canon 必须不同', canon({ m: { a: 1 } }) !== canon({ m: { a: 2 } }));
}

// ── 基本追加 ──
{
  const L = emptyLedger('测试台账');
  const r1 = append(L, { kind: 'a', value: 1 });
  const r2 = append(L, { kind: 'b', value: 2 });
  t('正例：能追加两条', r1.ok && r2.ok && L.entries.length === 2);
  t('正例：台账标记 appendOnly', L.appendOnly === true && L.version === APPEND_ONLY_VERSION);
  t('正例：第二条 prev 指向第一条 hash', L.entries[1].prev === L.entries[0].hash);
  t('正例：链校验通过', verifyChain(L).ok === true, JSON.stringify(verifyChain(L)));
}

// ── ① 嵌套篡改（审计员的核心发现）──
{
  const L = emptyLedger();
  append(L, { kind: 'a', value: 1, meta: { amount: 10, who: 'alice' } });
  append(L, { kind: 'b', value: 2 });
  L.entries[0].meta.amount = 999999;
  const v = verifyChain(L);
  t('★反例：改**嵌套**字段 ⇒ 链必须失败（原实现漏了这条）', v.ok === false && v.brokenAt === 0, JSON.stringify(v));
}
{
  // 用真实成本台账行的形状：tokens / frozenPrice 都是嵌套对象
  const L = emptyLedger();
  append(L, {
    kind: 'cost', model: 'auto/claude-fable-5-2',
    tokens: { input: 71, output: 1, cacheRead: 0, cacheWrite: 0 },
    frozenPrice: { prompt: 0.000008, completion: 0.00004, cacheRead: 0, cacheWrite: 0 },
    value: 0.00000808,
  });
  L.entries[0].tokens.input = 7100000;         // 用量改 10 万倍
  L.entries[0].frozenPrice.prompt = 999;       // 单价改 12 万倍
  t('★反例：真实成本行形状（tokens+frozenPrice 嵌套）被改 ⇒ 链必须失败',
    verifyChain(L).ok === false, JSON.stringify(verifyChain(L)));
}

// ── ② 文件损坏不许 fail-open ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
{
  const f = path.join(tmp, 'truncated.json');
  fs.writeFileSync(f, '{"entries": [ {"kind":"a"', 'utf8');   // 截断的 JSON
  const L = loadLedger(f);
  t('★反例：截断的 JSON ⇒ loadLedger 必须标 corrupt（不许冒充空台账）', L.corrupt === true, JSON.stringify(L).slice(0, 90));
  t('★反例：损坏文件 ⇒ verifyChain 必须失败（原实现返回 ok:true,count:0）',
    verifyChain(L).ok === false, JSON.stringify(verifyChain(L)));
}
{
  const f = path.join(tmp, 'notarray.json');
  fs.writeFileSync(f, '{"foo":1}', 'utf8');
  t('★反例：结构不对（无 entries）⇒ 必须标 corrupt', loadLedger(f).corrupt === true);
}
{
  const f = path.join(tmp, 'missing.json');
  const L = loadLedger(f);
  t('正例：文件真的不存在 ⇒ 空台账（这是合法初态，不是损坏）', !L.corrupt && L.entries.length === 0, JSON.stringify(L).slice(0, 60));
}
{
  // 损坏文件上 append 必须被拒，不许「静默覆盖历史」
  const f = path.join(tmp, 'trunc2.json');
  fs.writeFileSync(f, '{"entries": [ {"kind":"a"', 'utf8');
  const L = loadLedger(f);
  const r = append(L, { kind: 'b', value: 2 });
  t('★反例：损坏台账上 append 必须被拒（否则会把历史静默覆盖）', r.ok === false, JSON.stringify(r));
}

// ── ③ 尾部截断 ──
{
  const f = path.join(tmp, 'tail.json');
  const L = emptyLedger();
  append(L, { kind: 'a', value: 1 });
  append(L, { kind: 'b', value: 2 });
  append(L, { kind: 'c', value: 3 });
  saveLedger(L, f);
  t('正例：落盘后链校验通过', verifyChain(loadLedger(f)).ok === true, JSON.stringify(verifyChain(loadLedger(f))));

  const back = loadLedger(f);
  back.entries.pop();                       // 删掉尾部一条
  const v = verifyChain(back);
  t('★反例：pop 掉尾部一条 ⇒ 必须失败（原实现 ok:true）', v.ok === false, JSON.stringify(v));
}
{
  const f = path.join(tmp, 'tail2.json');
  const L = emptyLedger();
  append(L, { kind: 'a', value: 1 });
  saveLedger(L, f);
  const back = loadLedger(f);
  back.entries.splice(0, 1);                // 删光
  t('★反例：删光所有条目 ⇒ 必须失败', verifyChain(back).ok === false, JSON.stringify(verifyChain(back)));
}

// ── ④ append 先校验历史 ──
{
  const L = emptyLedger();
  append(L, { kind: 'a', value: 1 });
  L.entries[0].value = 999;                 // 偷偷改历史
  const r = append(L, { kind: 'c', value: 3 });
  t('★反例：历史被改后 append 必须被拒（原实现返回 ok:true）', r.ok === false, JSON.stringify(r));
}

// ── 中间删除 / 插入伪造 ──
{
  const L = emptyLedger();
  append(L, { kind: 'a', value: 1 });
  append(L, { kind: 'b', value: 2 });
  L.entries.splice(0, 1);
  t('★反例：删除中间条目 ⇒ 必须失败', verifyChain(L).ok === false);
}
{
  const L = emptyLedger();
  append(L, { kind: 'a', value: 1 });
  append(L, { kind: 'b', value: 2 });
  L.entries.splice(1, 0, { at: 'x', kind: 'fake', value: 666, prev: L.entries[0].hash, hash: 'deadbeef' });
  t('★反例：插入伪造条目 ⇒ 必须失败', verifyChain(L).ok === false);
}
{
  const L = emptyLedger();
  append(L, { kind: 'a', value: 1 });
  L.entries[0].at = '1999-01-01T00:00:00.000Z';
  t('★反例：只改时间戳也要能查出来', verifyChain(L).ok === false);
}

// ── 无值不许造 ──
{
  const L = emptyLedger();
  append(L, { kind: 'x', value: undefined });
  t('★反例：value 为 undefined ⇒ 记 null 并要求 why', L.entries[0].value === null && !!L.entries[0].why);
}
{
  const L = emptyLedger();
  append(L, { kind: 'x', value: 0 });
  t('★反例：value 真的是 0 时必须保留 0', L.entries[0].value === 0);
}
{
  const L = emptyLedger();
  append(L, { kind: 'a', value: 1 });
  append(L, { kind: 'b' });
  const s = summarize(L);
  t('★反例：汇总时有值/无值分开计数', s.withValue === 1 && s.withoutValue === 1, JSON.stringify(s));
}

// ── 结构异常 ──
{
  t('★反例：append 到 null ⇒ 拒绝', append(null, { value: 1 }).ok === false);
  t('★反例：append 非对象 ⇒ 拒绝', append(emptyLedger(), 'x').ok === false);
  t('★反例：append 数组 ⇒ 拒绝（数组也是 object，容易漏）', append(emptyLedger(), [1]).ok === false);
  t('★反例：verifyChain 对坏结构 ⇒ 失败', verifyChain({}).ok === false);
  t('★反例：verifyChain 对 null ⇒ 失败', verifyChain(null).ok === false);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n  append-only 基元反例测试：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
