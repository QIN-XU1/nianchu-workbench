#!/usr/bin/env node
/**
 * 记忆批量导入 —— 原子性
 *
 * ── 为什么需要它（真实缺口）────────────────────────────────
 * store.mjs 只能一条一条 put。导入一批记忆时：
 *   第 1 条 ✓ 写进去
 *   第 2 条 ✓ 写进去
 *   第 3 条 ✗ 缺 source（拒绝）
 *   ⇒ 结果是**半批写入**，前 2 条已经在库里，第 3 条永远丢了。
 *
 * 这不是小事：批量导入通常来自「从旧系统迁移」或「从文档抽取」，
 * 半批写入意味着你不知道哪些进了、哪些没进，也没法重跑（重跑会撞重复）。
 *
 * 所以 bulk 的核心不是「快」，是**原子性**：
 *   先全量校验 → 有任何一条不合法就整批拒绝 → 一条都不写。
 *
 * ── 四态 ──────────────────────────────────────────────
 *   PASS(0)     全部导入（或全部已存在，等价成功）
 *   FAIL(1)     有非法记录 ⇒ 整批拒绝，一条都不写
 *   UNKNOWN(2)  输入读不出来
 */
import fs from 'node:fs';
import path from 'node:path';
import { put } from './store.mjs';

/**
 * 批量导入（原子）
 *
 * @param records  [{key, value, source, ttlSec?}]
 * @returns {ok, imported, touched, errors:[{index, why}]}
 */
export function bulk(db, records, { now = new Date(), by = 'bulk' } = {}) {
  if (!Array.isArray(records)) {
    return { ok: false, imported: 0, touched: 0, errors: [{ index: -1, why: '记录必须是数组' }] };
  }
  if (records.length === 0) {
    return { ok: false, imported: 0, touched: 0, errors: [{ index: -1, why: '空批次 —— 没有东西可导入' }] };
  }

  // ── 第一阶段：全量校验（不写任何东西）──
  const errors = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i] || {};
    if (!r.key || !String(r.key).trim()) errors.push({ index: i, why: 'key 不能为空' });
    else if (r.value === undefined || r.value === null || String(r.value) === '') errors.push({ index: i, why: 'value 不能为空' });
    else if (!r.source || !String(r.source).trim()) errors.push({ index: i, why: '没有来源（source）—— 溯源底线，整批不许进' });
    else if (r.ttlSec !== undefined && r.ttlSec !== null && !(Number(r.ttlSec) > 0)) errors.push({ index: i, why: 'ttlSec 必须是正数或 null' });
  }
  if (errors.length) {
    // 原子性：有任何一条不合法 ⇒ 整批拒绝，一条都不写
    return { ok: false, imported: 0, touched: 0, errors };
  }

  // ── 第二阶段：落库（此时不会再有校验失败）──
  let imported = 0, touched = 0;
  for (const r of records) {
    const res = put(db, {
      key: r.key, value: r.value, source: r.source,
      ttlSec: r.ttlSec === undefined ? null : r.ttlSec,
      now, by,
      disagreement: r.disagreement || null,
    });
    if (!res.ok) {
      // 理论上到不了这里（已校验），但真到这一步必须如实报，不许静默跳过
      errors.push({ index: -1, why: '落库意外失败：' + res.why });
    } else if (res.action === 'touch') touched++;
    else imported++;
  }
  return { ok: errors.length === 0, imported, touched, errors };
}

/** 自检 —— 5 条反例，核心是原子性 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);
  const t0 = new Date('2026-01-01T00:00:00Z');
  const mkdb = () => ({ entries: [] });

  // ── 反例 1（核心）：中间一条非法 ⇒ 整批拒绝，且**一条都不许写** ──
  let db = mkdb();
  const r1 = bulk(db, [
    { key: 'a', value: '1', source: 'f:1' },
    { key: 'b', value: '2', source: 'f:2' },
    { key: 'c', value: '3', source: '' },        // ← 非法：缺来源
  ], { now: t0 });
  T('反例 · 缺来源 ⇒ 整批拒绝', r1?.ok === false && (r1.errors || []).length === 1 && r1.errors[0]?.index === 2,
    JSON.stringify(r1.errors));
  T('反例 · 整批拒绝时**一条都不许写**（原子性）', db.entries.length === 0,
    'entries=' + db.entries.length);

  // ── 正例 1：全合法 ⇒ 全部导入 ──
  db = mkdb();
  const r2 = bulk(db, [
    { key: 'a', value: '1', source: 'f:1' },
    { key: 'b', value: '2', source: 'f:2' },
    { key: 'c', value: '3', source: 'f:3', ttlSec: 3600 },
  ], { now: t0 });
  T('正例 · 全合法 ⇒ 导入 3 条', r2.ok && r2.imported === 3 && db.entries.length === 3, JSON.stringify(r2));

  // ── 反例 2：空批次 ⇒ 拒绝（不是「成功导入 0 条」）──
  const r3 = bulk(mkdb(), [], { now: t0 });
  T('反例 · 空批次 ⇒ 拒绝（不许当成功）', r3.ok === false && /空批次/.test(r3.errors?.[0]?.why ?? ''), JSON.stringify(r3.errors));

  // ── 反例 3：同 key 同值 ⇒ touch 不新增（批量里也不许造重复）──
  db = mkdb();
  bulk(db, [{ key: 'a', value: '1', source: 'f:1' }], { now: t0 });
  const r4 = bulk(db, [{ key: 'a', value: '1', source: 'f:9' }], { now: t0 });
  T('反例 · 同 key 同值 ⇒ touch 不新增', r4.ok && r4.touched === 1 && r4.imported === 0 && db.entries.length === 1,
    JSON.stringify({ r4, n: db.entries.length }));

  // ── 反例 4：多条非法必须**全部**报出来（不许只报第一条）──
  const r5 = bulk(mkdb(), [
    { key: '', value: '1', source: 'f:1' },
    { key: 'b', value: '', source: 'f:2' },
    { key: 'c', value: '3', source: '' },
  ], { now: t0 });
  T('反例 · 3 条非法必须全部报出（index 0/1/2 都在）',
    (r5.errors || []).length === 3 && [0, 1, 2].every((i) => (r5.errors || []).some((e) => e.index === i)),
    JSON.stringify(r5.errors));

  // ── 反例 5：ttlSec 非正数 ⇒ 拒绝（不许写一条永远不过期或负 TTL 的）──
  const r6 = bulk(mkdb(), [{ key: 'a', value: '1', source: 'f:1', ttlSec: -5 }], { now: t0 });
  T('反例 · ttlSec 为负 ⇒ 拒绝', r6.ok === false && /ttlSec/.test(r6.errors?.[0]?.why ?? ''), JSON.stringify(r6.errors));

  // ── 反例 6：非数组输入 ⇒ 拒绝（不许抛异常崩掉）──
  const r7 = bulk(mkdb(), { not: 'array' }, { now: t0 });
  T('反例 · 非数组输入 ⇒ 拒绝而非崩溃', r7.ok === false && /数组/.test(r7.errors?.[0]?.why ?? ''), JSON.stringify(r7.errors));

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
    console.log('  记忆批量导入 · 自检（1 正例 + 4 反例，核心是原子性）');
    console.log('  ' + '─'.repeat(70));
    console.log(r.lines);
    console.log('');
    console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
    console.log('');
    process.exit(r.ok ? 0 : 1);
  }

  const REPO = path.resolve(import.meta.dirname, '../..');
  const STORE = path.join(REPO, 'evidence/memory/store.json');
  const flag = (n) => {
    const p = '--' + n + '=';
    const a = process.argv.find((x) => x.startsWith(p));
    return a ? a.slice(p.length) : null;
  };

  const file = flag('file');
  if (!file) { console.log('  ✗ 需要 --file=<json 文件路径>'); process.exit(1); }
  let records;
  try {
    // 第 95 轮：Windows 上常见带 BOM 的 UTF-8 文件，JSON.parse 会直接失败（实测踩到）
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    records = Array.isArray(raw) ? raw : raw.records;
  } catch (e) {
    console.log('  ❔ 读不出输入文件：' + String(e.message).slice(0, 60));
    process.exit(2);
  }

  let db = { entries: [] };
  // 【第 95 轮修】原来 `try { db = JSON.parse(...) } catch { /* 新库 */ }`：
  // 把「文件存在但解析失败（损坏）」和「文件不存在（新库）」混为一谈。
  // 后果：记忆库损坏时会以空库继续，saveDb 把损坏文件**覆盖成空库** → 静默丢数据。
  // 现在严格区分：不存在 → 新库；存在但解析失败 → 拒绝继续（先备份人工检查）。
  if (fs.existsSync(STORE)) {
    const txt = fs.readFileSync(STORE, 'utf8');
    try {
      db = JSON.parse(txt);
    } catch (e) {
      console.log('');
      console.log('  ✗ 记忆库文件存在但无法解析（疑似损坏）：' + STORE);
      console.log('    原因：' + String(e.message).slice(0, 80));
      console.log('    拒绝继续 —— 否则会用空库把它覆盖掉。请先备份该文件并人工检查。');
      console.log('');
      process.exit(2);
    }
  }

  const r = bulk(db, records);
  if (!r.ok) {
    console.log('');
    console.log('  ✗ 整批拒绝（原子性：一条都没写）');
    for (const e of r.errors) console.log('      · 第 ' + (e.index >= 0 ? e.index + 1 : '?') + ' 条：' + e.why);
    console.log('');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(db, null, 2) + '\n', 'utf8');
  console.log('');
  console.log('  ✓ 已导入 ' + r.imported + ' 条 · 同值刷新 ' + r.touched + ' 条');
  console.log('');
  process.exit(0);
}
