#!/usr/bin/env node
/**
 * append-only 台账基元 —— 全仓统一的「只追加」实现。
 *
 * ══════════════════════════════════════════════════════════════════
 * 【2026-11-18 大修 · 起因：独立审计员判 FAIL，给出可复现反例】
 *
 * 原实现有四个真 bug，每一个都能用几行脚本推翻它自己的宣称：
 *
 *  ① **哈希不覆盖嵌套对象**。原来用
 *       JSON.stringify(rest, Object.keys(rest).sort())
 *     这是 **array replacer（属性白名单）**，对**所有层级**生效：
 *       JSON.stringify({at:'x', meta:{amount:10}}, ['at','meta']) → {"at":"x","meta":{}}
 *     嵌套内容一律变 `{}` ⇒ 改 tokens.input、改 frozenPrice.prompt，
 *     链校验全返回 ok:true。而真实成本台账行的核心字段恰好全是嵌套对象。
 *     ⇒ 改成**深度规范化序列化**（canon）。
 *
 *  ② **文件损坏 fail-open**。原来 `catch { return emptyLedger() }`：
 *     截断 JSON → 加载成空台账 → verifyChain 报 ok:true,count:0 → 接口返回 HTTP 200。
 *     更糟：下一次 append+save 会把原有历史**静默覆盖**。
 *     ⇒ 损坏必须显式报错（corrupt 标记），绝不冒充「空台账且验证通过」。
 *
 *  ③ **尾部截断不可检测**。原来没有条数/链尾锚点，pop() 一条或删光都 ok:true。
 *     ⇒ 台账落盘时同时写 `count` 与 `tail`，校验时必须一致。
 *
 *  ④ **append 不校验历史**。注释写「append 时若发现历史被改过直接报错」，
 *     实际只取上一条 hash 就 push。⇒ 现在 append 前先 verifyChain。
 * ══════════════════════════════════════════════════════════════════
 *
 * 三条硬规则：
 *   ① 只追加：已有条目永不被修改（改了就查得出）
 *   ② hash 链：每条记 prev（上条 hash）与 hash（本条**深度**内容+prev 的 sha256）
 *   ③ 无值不许造：值为 undefined 时记 null 并标 why，不许写 0 或空串蒙混
 *
 * 已知边界（如实标注，不假装）：
 *   · 无密钥哈希链只能防「手滑改」，防不住有意伪造（攻击者可重算整条链）。
 *     要防伪造需要签名/外部锚点，本模块不做。
 *   · 这些台账用 JSON 文件 + hash 链而非数据库，因为要能被 git 跟踪与人工 diff。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const APPEND_ONLY_VERSION = 2;

const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

/**
 * 深度规范化序列化 —— 保证嵌套对象的键序稳定，且**所有层级都进哈希**。
 *
 * 为什么不能直接用 JSON.stringify(v, keys)：第二个参数是 array replacer，
 * 它会对每一层都按白名单过滤，嵌套对象因此变成 `{}`（这是原实现的致命 bug）。
 */
export function canon(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  const t = typeof v;
  if (t === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  return JSON.stringify(String(v));
}

function hashOf(prev, row) {
  const { hash: _h, ...rest } = row;
  return sha256(String(prev ?? '') + '|' + canon(rest));
}

export function emptyLedger(what = 'append-only 台账') {
  return { what, version: APPEND_ONLY_VERSION, appendOnly: true, at: new Date().toISOString(), count: 0, tail: null, entries: [] };
}

/**
 * 读台账。
 * **文件存在但读不出来时返回 corrupt 标记**，不冒充空台账 —— 这是审计组件的基本要求。
 * @returns {{corrupt?:boolean, why?:string, entries:Array, count?:number, tail?:string|null}}
 */
export function loadLedger(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return emptyLedger();   // 真的还没有这个文件
    return { corrupt: true, why: '读不出文件：' + String(e && e.message).slice(0, 80), entries: [] };
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    return { corrupt: true, why: '文件不是合法 JSON（可能被截断或手改）：' + String(e && e.message).slice(0, 80), entries: [] };
  }
  if (!j || !Array.isArray(j.entries)) {
    return { corrupt: true, why: '文件结构不对（没有 entries 数组）', entries: [] };
  }
  return j;
}

/** 落盘时同步写入 count 与 tail —— 让尾部截断可被检出 */
export function saveLedger(ledger, filePath) {
  if (!ledger || !Array.isArray(ledger.entries)) throw new Error('saveLedger：ledger 结构不对');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  ledger.at = new Date().toISOString();
  ledger.version = APPEND_ONLY_VERSION;
  ledger.count = ledger.entries.length;
  ledger.tail = ledger.entries.length ? ledger.entries[ledger.entries.length - 1].hash ?? null : null;
  fs.writeFileSync(filePath, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
  return ledger;
}

/**
 * 追加一条。**先校验历史完好**，再追加 —— 历史被改过就拒绝。
 * @returns {{ok:boolean, entry?:object, why?:string}}
 */
export function append(ledger, row) {
  if (!ledger || !Array.isArray(ledger.entries)) return { ok: false, why: 'ledger 结构不对' };
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return { ok: false, why: 'row 必须是对象' };

  // ④ 追加前先校验历史（原实现只在注释里承诺，代码没做）
  const v = verifyChain(ledger);
  if (!v.ok) return { ok: false, why: '拒绝追加：历史链已损坏（' + v.why + '）' };

  const prev = ledger.entries.length ? ledger.entries[ledger.entries.length - 1].hash ?? null : null;
  const entry = { at: row.at || new Date().toISOString(), ...row };
  // ③ 无值不许造
  if (row.value === undefined) {
    entry.value = null;
    entry.why = row.why || '无值';
  }
  entry.prev = prev;
  entry.hash = hashOf(prev, entry);
  ledger.entries.push(entry);
  // 追加后同步条数与链尾锚点 —— 否则下一次 append 的「先校验历史」会误判为尾部截断
  ledger.count = ledger.entries.length;
  ledger.tail = entry.hash;
  return { ok: true, entry };
}

/**
 * 校验整条链 + 条数锚点 + 链尾锚点。
 * @returns {{ok:boolean, brokenAt?:number, why?:string, count:number, corrupt?:boolean}}
 */
export function verifyChain(ledger) {
  if (!ledger || typeof ledger !== 'object') return { ok: false, why: 'ledger 不是对象', count: 0 };
  if (ledger.corrupt) return { ok: false, why: '台账文件损坏：' + (ledger.why || '未知'), count: 0, corrupt: true };

  const entries = ledger.entries;
  if (!Array.isArray(entries)) return { ok: false, why: '没有 entries 数组', count: 0 };

  // ② 尾部截断检测：落盘时的 count/tail 必须与当前内容一致
  if (typeof ledger.count === 'number' && ledger.count !== entries.length) {
    return {
      ok: false, count: entries.length,
      why: '条数不符：记录 ' + ledger.count + ' 条，实际 ' + entries.length + ' 条（尾部被截断或追加未落盘）',
    };
  }

  let prev = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e === null || typeof e !== 'object') return { ok: false, brokenAt: i, why: '第 ' + i + ' 条不是对象', count: entries.length };
    if ((e.prev ?? null) !== prev) {
      return { ok: false, brokenAt: i, why: '第 ' + i + ' 条的 prev 不匹配（历史被插入或删除）', count: entries.length };
    }
    const expect = hashOf(prev, e);
    if (e.hash !== expect) {
      return { ok: false, brokenAt: i, why: '第 ' + i + ' 条的 hash 不匹配（内容被改写，含嵌套字段）', count: entries.length };
    }
    prev = e.hash;
  }

  if (ledger.tail !== undefined && ledger.tail !== null && ledger.tail !== prev) {
    return { ok: false, why: '链尾不符：记录 tail=' + String(ledger.tail).slice(0, 12) + '… 实际 ' + String(prev).slice(0, 12) + '…', count: entries.length };
  }

  return { ok: true, count: entries.length };
}

/** 汇总：有值 / 无值分开计数（无值不许当 0） */
export function summarize(ledger) {
  const entries = ledger?.entries ?? [];
  let withValue = 0;
  let withoutValue = 0;
  for (const e of entries) {
    if (e.value === null || e.value === undefined) withoutValue++;
    else withValue++;
  }
  return { entries: entries.length, withValue, withoutValue };
}
