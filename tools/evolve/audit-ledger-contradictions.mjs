#!/usr/bin/env node
/**
 * 台账字段级矛盾审计 —— 抓「notes 说什么」与「字段说什么」打架
 *
 * 【2026-11-17 起因】
 *   独立验证方 v-h0023 发现：H-0023 的 notes 写着
 *     「C5：验证方与实现方是同一个（lead）⇒ 状态降为「部分」，不算独立验证」
 *   但它的 status=closed、independent=true、attestedBy=verifier-r3b。
 *
 *   实测台账：28 条 closed 里 **25 条**有这种矛盾 —— 包括当前被算作
 *   「协议口径有效」的全部 4 条（H-0074/H-0080/H-0123/H-0124）。
 *
 * 【为什么这是真问题】
 *   tools/evolve/evolve.mjs 的完整性检查只看 e.independent，**不看 notes**。
 *   所以「字段说已升级、notes 说没独立」这种矛盾永远不会被体检抓出来。
 *   而 T1 的判定正是建立在 status/independent 上 —— 如果 notes 才是真的，
 *   T1 的协议口径就该是 0，不是 4。
 *
 * 【本工具不裁决谁对】
 *   它只做一件事：把矛盾摆出来，要求**显式解决**（要么删过期 note，
 *   要么写 upgradeReason 说明为什么升级）。判断类的事不机械化。
 *
 * 四态：exit 0=PASS(无矛盾) / 3=WARN(有矛盾需显式解决) / 1=FAIL / 2=UNKNOWN
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const LEDGER = path.join(REPO, 'research/改进台账.json');

/** 从 notes 里判断「它自己说过不算独立验证」 */
const PARTIAL_NOTE = /降为「?部分」?|不算独立验证|验证方与实现方是同一个|验证方\s*==\s*实现方/;

/**
 * 审计一条记录，返回矛盾列表
 * @returns {string[]} 矛盾描述（空=无矛盾）
 */
export function contradictionsOf(e) {
  const out = [];
  const notes = Array.isArray(e.notes) ? e.notes.join(' ') : String(e.notes || '');

  // ① notes 说不算独立，但字段说已结案且独立
  //
  // 【2026-11-17 修·自曝假阳性】第一版把 25 条全报成矛盾。
  // 自查发现它们全都有 attestEvidence（升级理由，如「第三轮独立复审直接调用实测 countLedger()」）。
  // notes 里的「降为部分」是**升级前的历史**，不是当前状态 ⇒ 我报的是假阳性。
  //
  // 检测「假绿」的工具自己假红，比假绿更危险：会让人去修不存在的问题。
  // 修法：有非空 attestEvidence 也视为「已显式解决」（与 upgradeReason 同等）。
  if (PARTIAL_NOTE.test(notes) && e.status === 'closed' && e.independent === true) {
    const resolved = Boolean(e.upgradeReason) || Boolean(String(e.attestEvidence || '').trim());
    if (!resolved) {
      out.push('notes 说「不算独立验证」，但 status=closed 且 independent=true，且无 upgradeReason/attestEvidence');
    }
  }

  // ② verdict=unknown 却 closed（UNKNOWN 不许当通过）
  if (e.verdict === 'unknown' && e.status === 'closed') {
    out.push('verdict=unknown 但 status=closed（UNKNOWN 不许并入通过）');
  }

  // ③ closed 但缺 samples / baseline / after
  if (e.status === 'closed') {
    if (e.samples == null) out.push('status=closed 但缺 samples');
    if (e.baseline === undefined || e.baseline === null) out.push('status=closed 但缺 baseline');
    if (e.after === undefined || e.after === null) out.push('status=closed 但缺 after');
  }

  return out;
}

export function auditLedger(entries) {
  const rows = [];
  for (const e of entries) {
    const c = contradictionsOf(e);
    if (c.length) rows.push({ id: e.id, status: e.status, verifier: e.verifier, contradictions: c });
  }
  const closed = entries.filter((e) => e.status === 'closed').length;
  return { total: entries.length, closed, flagged: rows.length, rows };
}

// ── 自检 ──
export function selfTest() {
  const cases = [];
  const T = (n, ok) => cases.push([n, !!ok]);

  // 共用完整字段，避免触发「缺 samples/baseline/after」规则
  const full = { samples: 8, baseline: 1, after: 2, verdict: 'keep' };
  // 反例：notes 说降为 partial + closed + independent ⇒ 必须报
  T('反例 · notes 说降为 partial 但 closed+independent ⇒ 报矛盾',
    contradictionsOf({ ...full, status: 'closed', independent: true, notes: ['C5：验证方与实现方是同一个（lead）⇒ 状态降为「部分」'] }).length === 1);
  // 正例：有 upgradeReason 就视为已显式解决
  T('正例 · 有 upgradeReason ⇒ 不算矛盾（显式解决过）',
    contradictionsOf({ ...full, status: 'closed', independent: true, upgradeReason: 'v-h0074 独立复算通过', notes: ['C5：降为「部分」'] }).length === 0);
  // 【2026-11-17 加】有 attestEvidence 也算已解决 —— 这是我第一版漏掉、导致 25 条假阳性的原因
  T('正例 · 有 attestEvidence ⇒ 不算矛盾（升级理由已留痕）',
    contradictionsOf({ ...full, status: 'closed', independent: true, attestEvidence: '第三轮独立复审实测通过', notes: ['C5：降为「部分」'] }).length === 0);
  // 反例：既无 upgradeReason 又无 attestEvidence ⇒ 必须报（真矛盾）
  T('反例 · 既无 upgradeReason 又无 attestEvidence ⇒ 必须报',
    contradictionsOf({ ...full, status: 'closed', independent: true, attestUpgradedFrom: 'partial', notes: ['C5：降为「部分」'] }).length === 1);
  // 正例：notes 没说 partial 就不报
  T('正例 · notes 正常 ⇒ 不报',
    contradictionsOf({ ...full, status: 'closed', independent: true, notes: ['正常'] }).length === 0);
  // 反例：verdict=unknown 但 closed ⇒ 报
  T('反例 · verdict=unknown 但 closed ⇒ 报',
    contradictionsOf({ status: 'closed', independent: true, verdict: 'unknown', notes: [], samples: 8, baseline: 1, after: 2 }).length === 1);
  // 反例：closed 缺 samples ⇒ 报
  T('反例 · closed 但缺 samples ⇒ 报',
    contradictionsOf({ status: 'closed', independent: true, notes: [], baseline: 1, after: 2 }).length === 1);
  // 正例：完整记录不报
  T('正例 · 完整且自洽 ⇒ 不报',
    contradictionsOf({ status: 'closed', independent: true, verdict: 'keep', notes: ['ok'], samples: 8, baseline: 1, after: 2 }).length === 0);
  // 反例：partial 状态本身不报（它没自称独立）
  T('反例 · status=partial 不报（本来就没声称独立）',
    contradictionsOf({ status: 'partial', independent: false, notes: ['C5：降为「部分」'], samples: 8, baseline: 1, after: 2 }).length === 0);

  const bad = cases.filter(([, ok]) => !ok);
  return { pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok]) => '  ' + (ok ? '✓' : '✗') + ' ' + n).join('\n') };
}

// ── CLI ──
if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('\n  台账字段级矛盾审计 · 自检');
  console.log('  ' + '─'.repeat(64));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

const d = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
const entries = d.entries || d.rounds || d;
const res = auditLedger(entries);

console.log('');
console.log('  台账字段级矛盾审计 —— notes 与 status 打架');
console.log('  ' + '='.repeat(74));
console.log('  台账 ' + res.total + ' 条 · closed ' + res.closed + ' 条 · 有矛盾 ' + res.flagged + ' 条');
console.log('');
if (res.rows.length) {
  console.log('  矛盾清单（需显式解决：删过期 note 或写 upgradeReason）：');
  for (const r of res.rows.slice(0, 40)) {
    console.log('    ' + String(r.id).padEnd(8) + ' [' + r.status + '] ' + r.contradictions.join('；'));
  }
  if (res.rows.length > 40) console.log('    ... 还有 ' + (res.rows.length - 40) + ' 条');
}
console.log('');

// ── 集成断言（验证方 v-h0134 硬伤 D：单元自检不碰真实台账）──
// 这两条是**对真实数据**的断言，不是对构造样例的断言。
const allStatus = entries.map((e) => e.status);
const statusCounts = allStatus.reduce((m, s) => { m[s || '(空)'] = (m[s || '(空)'] || 0) + 1; return m; }, {});
const sumByStatus = Object.values(statusCounts).reduce((a, b) => a + b, 0);
const integ = [
  ['分类总和 = 总条数（防漏算）', sumByStatus === res.total, sumByStatus + ' vs ' + res.total],
  ['closed 数与逐条统计一致', statusCounts.closed === res.closed, statusCounts.closed + ' vs ' + res.closed],
];
let integBad = 0;
console.log('  集成断言（对真实台账）：');
for (const [name, ok, detail] of integ) {
  if (!ok) integBad++;
  console.log('    ' + (ok ? '✓' : '✗') + ' ' + name + (ok ? '' : '  [' + detail + ']'));
}
console.log('');

console.log('  四态: ' + (res.flagged === 0 && integBad === 0 ? 'PASS' : res.flagged > 0 ? 'WARN' : 'FAIL')
  + ' —— ' + (res.flagged === 0 ? '无矛盾' : res.flagged + ' 条矛盾需显式解决（不是自动判错，是要人看）'));
console.log('');

// --assert-clean：CI 用，有任何矛盾或集成断言失败就 exit 1
if (process.argv.includes('--assert-clean')) {
  const bad = res.flagged + integBad;
  console.log('  --assert-clean: ' + (bad === 0 ? '✓ 干净' : '✗ ' + bad + ' 项需处理'));
  console.log('');
  process.exit(bad === 0 ? 0 : 1);
}

if (integBad > 0) process.exit(1);
process.exit(res.flagged === 0 ? 0 : 3);
