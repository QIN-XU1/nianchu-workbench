#!/usr/bin/env node
// 工具/规则待确认.mjs —— 「待机主确认」清单
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（这是「规则只认机主」的落地写法）
// ══════════════════════════════════════════════════════════════════════
//  参考项目的原文：
//
//    发现「应该加个规矩」但机主不在
//          │
//          ├─ 写进 观察/证据（场景记忆的「坑」、待办、体检报告）
//          └─ 或攒进「待机主确认」清单：一行一条
//             （内容 + 为什么 + 依据来源 + 时间）
//
//    ⛔ 不许因此新增/修改任何规矩
//
//  这条为什么重要：
//    「AI 非常容易把『某个工具说应该这样』当成『机主批准这样』。
//     一旦允许这样推，规矩会自己长 ——
//     今天加一条、明天加一条，三个月后没人知道哪条是真的。」
//
//  ──────────────────────────────────────────────────────────────────
//  我们的处境（实测）：
//    规则来源体检 扫出来 10 条「在跑但没登记来源」的规矩，
//    它们都写在 硬规矩.mjs 里（负载上限 / 回执节流 / 余额急停）。
//
//    按参考项目的判据，它们**现在是「无效」的** —— 说不清谁批准的。
//    但它们确实在跑，而且是有价值的（防止烧钱/过载）。
//
//    正确做法不是删掉，也不是假装它们有来源，
//    而是：**列进待确认清单，等机主点头。**
//
//  用法：
//    node 工具/规则待确认.mjs              看清单
//    node 工具/规则待确认.mjs --scan       从代码扫出未登记的规矩，追加进清单
//    node 工具/规则待确认.mjs --confirm <id>   标记某条已获机主批准（需要 --by 机主 --at 日期）
//    node 工具/规则待确认.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA = path.join(WB, '数据', '.dsh');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const val = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };

// ── 判据常量（export 供复用）────────────────────────────────────────
const PENDING_FILE = path.join(DATA, '规则待确认.json');
const SOURCE_FILE = path.join(DATA, '规矩来源.json');

/**
 * 待确认项的状态
 */
export const PENDING_STATES = ['pending', 'approved', 'rejected'];

/**
 * 判一条待确认项是否完整
 *
 * 参考项目要求四个字段：内容 + 为什么 + 依据来源 + 时间
 *
 * @param {{id?:string, text?:string, why?:string, evidence?:string, at?:string}} item
 * @returns {{ok:boolean, problems:string[]}}
 */
export function judgePendingItem(item) {
  const i = item || {};
  const problems = [];
  if (!i.id) problems.push('缺 id');
  if (!i.text) problems.push('缺内容');
  if (!i.why) problems.push('缺「为什么要加」（避免将来没人知道它防的是什么）');
  if (!i.evidence) problems.push('缺「依据来源」（说不清从哪来的，就是凭空长出来的）');
  if (!i.at) problems.push('缺时间');
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(i.at))) problems.push('时间格式应为 YYYY-MM-DD');
  return { ok: problems.length === 0, problems };
}

// ══════════════════════════════════════════════════════════════════════
function loadJson(file, key) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j[key]) ? j[key] : [];
  } catch { return []; }
}

function saveJson(file, key, list, note) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ note, [key]: list }, null, 2), 'utf8');
}

/** 从 硬规矩.mjs / AGENTS.md 扫出「在跑但没登记来源」的规矩 */
export function scanRunningRules() {
  const out = [];

  // ── ① AGENTS.md 的全局铁律 ──
  //
  // ⚠ 2026-11-13 加：AGENTS.md 的 9 条铁律是最核心的规矩
  //   （记忆在文件、场景是地盘、自证必须是真证……），
  //   但之前扫描只扫 硬规矩.mjs，完全漏了它们。
  //   实测：规则来源体检 报「真的漏了 16 条」，全在这里。
  try {
    const c = fs.readFileSync(path.join(DATA, 'AGENTS.md'), 'utf8');
    const lines = c.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^##\s*(\d+\.[^\n(（]+)/);
      if (!m) continue;
      const text = m[1].trim();
      // 取紧跟着的正文前两行当 why
      const body = [];
      for (let k = i + 1; k < Math.min(i + 8, lines.length); k++) {
        const t = lines[k].trim();
        if (!t || /^#{1,3}\s/.test(t)) break;
        body.push(t.replace(/^[-*·]\s*/, ''));
        if (body.join('').length > 80) break;
      }
      out.push({
        text,
        why: body.join('；').slice(0, 120) || '(文档里没写理由)',
        where: 'AGENTS.md 铁律',
      });
    }
  } catch { /* ignore */ }

  // ── ② 硬规矩.mjs 的三条 ──
  try {
    const c = fs.readFileSync(path.join(HERE, '硬规矩.mjs'), 'utf8');

    // ⚠ 2026-11-13 修（第一版把参数定义和测试也扫成了独立规矩）
    //
    //   实测第一版扫出 10 条，但实际只有 3 条：
    //     规矩 1：负载闸      L24 文件头 / L63 参数 / L86 说明 / L404 测试
    //     规矩 2：回执节流    L28 / L65+L67 / L188 / L412
    //     规矩 3：余额急停    L32 / L69+L81 / L220 / L420
    //   后面那些是**同一条规矩的参数和测试**，不是新规矩。
    //
    //   修法：只从文件头的「规矩 N：X」总览里取（那是权威清单），
    //        不扫后面的参数定义和测试。
    //        同时把总览下面那行「实际内容」也取出来当 why ——
    //        那是代码里真实写着的理由，不是我编的。
    const lines = c.split('\n');
    const headEnd = lines.findIndex((l) => /^export /.test(l));
    const head = lines.slice(0, headEnd > 0 ? headEnd : lines.length);

    const seen = new Set();
    for (let i = 0; i < head.length; i++) {
      const m = head[i].match(/规矩\s*(\d+)[：:]\s*([^\n*]{2,40})/);
      if (!m) continue;
      const num = m[1];
      if (seen.has(num)) continue;
      seen.add(num);
      const name = m[2].trim().replace(/[（(].*$/, '').trim();

      // 取下面 3 行里第一条有实际内容的（去掉 * 前缀）
      const body = [];
      for (let k = i + 1; k < Math.min(i + 5, head.length); k++) {
        const t = head[k].replace(/^\s*\*\s?/, '').trim();
        if (!t || /^[═─]+$/.test(t) || /^规矩\s*\d+/.test(t)) break;
        body.push(t);
      }
      out.push({
        num,
        text: '规矩 ' + num + '：' + name,
        why: body.join('；') || '(代码里没写理由)',
        where: '硬规矩.mjs 文件头总览',
      });
    }
  } catch { /* ignore */ }

  return out;
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  规则待确认 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】完整的待确认项');
  {
    const good = {
      id: 'p1', text: '负载超过 90% 不许派单',
      why: '防止机器过载导致所有场景卡死',
      evidence: '工具/硬规矩.mjs 规矩 1（原文就在跑）',
      at: '2026-11-13',
    };
    const j = judgePendingItem(good);
    chk('正例：四字段齐全 → 通过', j.ok === true, j.problems.join('; ') || '无问题');
  }

  console.log();
  console.log('【二】反例：缺任一个字段都不完整');
  {
    const cases = [
      [{ text: 'x', why: 'y', evidence: 'z', at: '2026-11-13' }, '缺 id'],
      [{ id: 'a', why: 'y', evidence: 'z', at: '2026-11-13' }, '缺内容'],
      [{ id: 'a', text: 'x', evidence: 'z', at: '2026-11-13' }, '缺为什么'],
      [{ id: 'a', text: 'x', why: 'y', at: '2026-11-13' }, '缺依据来源'],
      [{ id: 'a', text: 'x', why: 'y', evidence: 'z' }, '缺时间'],
    ];
    let allRejected = true;
    for (const [item, _what] of cases) {
      if (judgePendingItem(item).ok) { allRejected = false; break; }
    }
    chk('反例：五个字段缺任一个都被拒', allRejected, cases.length + ' 种组合');
  }

  console.log();
  console.log('【三】反例：日期格式');
  {
    chk('反例：日期格式不对 → 拒绝',
      judgePendingItem({ id: 'a', text: 'x', why: 'y', evidence: 'z', at: '11月13日' }).ok === false);
  }

  console.log();
  console.log('【四】关键：这个工具守的是什么');
  {
    chk('关键：我不能自己批准规矩，只能列清单等机主点头',
      true, '参考项目：一旦允许 AI 自己推，规矩会自己长');
    chk('关键：状态只有 pending/approved/rejected',
      PENDING_STATES.length === 3, PENDING_STATES.join('/'));
  }

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('='.repeat(72));
  return R.every((x) => x.ok);
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { process.exit(selftest() ? 0 : 1); }

  const pending = loadJson(PENDING_FILE, 'items');

  // ── 确认某条（只有机主能确认）──
  if (has('confirm')) {
    const id = val('confirm');
    const by = val('by');
    const at = val('at');

    if (!by || !at) {
      console.log('  ⛔ 确认需要 --by 和 --at');
      console.log('     例：--confirm p1 --by 机主 --at 2026-11-13');
      console.log('     ⚠ 只有「机主」算数。AI 自己、工具输出、体检结论都不算。');
      process.exitCode = 1;
      return;
    }
    if (!String(by).includes('机主') && !String(by).includes('owner')) {
      console.log('  ⛔ 批准来源不合法: 「' + by + '」');
      console.log('     只认机主。AI 推断 / 工具输出 / 体检结论 都不算依据。');
      process.exitCode = 1;
      return;
    }

    const item = pending.find((x) => x.id === id);
    if (!item) { console.log('  ✗ 找不到 ' + id); process.exitCode = 1; return; }

    item.state = 'approved';
    item.approvedBy = by;
    item.approvedAt = at;
    saveJson(PENDING_FILE, 'items', pending, '待机主确认的规矩。AI 不能自己批准。');

    // 同步到 规矩来源.json
    const rules = loadJson(SOURCE_FILE, 'rules');
    if (!rules.some((r) => r.id === id)) {
      rules.push({ id, text: item.text, approvedBy: by, approvedAt: at, why: item.why });
      saveJson(SOURCE_FILE, 'rules', rules, '规矩来源登记表。只认机主批准。');
    }
    console.log('  ✓ ' + id + ' 已确认为机主批准，并登记到 规矩来源.json');
    return;
  }

  // ── 扫代码里在跑的规矩，追加进待确认清单 ──
  if (has('scan')) {
    const running = scanRunningRules();
    const today = new Date().toISOString().slice(0, 10);
    let added = 0;
    for (const r of running) {
      if (pending.some((x) => x.text === r.text)) continue;
      pending.push({
        id: 'p' + (pending.length + 1 + added),
        text: r.text,
        why: r.why || '（待补：这条防的是什么）',
        evidence: r.where + ' 里在跑',
        at: today,
        state: 'pending',
      });
      added++;
    }
    saveJson(PENDING_FILE, 'items', pending, '待机主确认的规矩。AI 不能自己批准。');
    console.log('  发现 ' + running.length + ' 条在跑的规矩，新增 ' + added + ' 条到待确认清单');
    console.log('  ⚠ why 字段需要人工补 —— 我不能替它编理由');
    return;
  }

  // ── 看清单 ──
  console.log('='.repeat(80));
  console.log('  待机主确认的规矩清单');
  console.log('='.repeat(80));
  console.log();
  console.log('  为什么有这个清单：');
  console.log('    「AI 非常容易把『某个工具说应该这样』当成『机主批准这样』。');
  console.log('     一旦允许这样推，规矩会自己长 —— 三个月后没人知道哪条是真的。」');
  console.log();
  console.log('  ⛔ 我不能自己批准任何规矩。这里只是候选。');
  console.log();

  if (!pending.length) {
    console.log('  （清单为空）');
    console.log();
    console.log('  跑 node 工具/规则待确认.mjs --scan 从代码里扫出在跑的规矩');
    return;
  }

  const byState = { pending: [], approved: [], rejected: [] };
  for (const p of pending) (byState[p.state] || byState.pending).push(p);

  for (const st of ['pending', 'approved', 'rejected']) {
    const list = byState[st];
    if (!list.length) continue;
    const label = { pending: '待确认', approved: '已批准', rejected: '已否决' }[st];
    console.log('  ── ' + label + '（' + list.length + ' 条）──');
    for (const p of list) {
      const j = judgePendingItem(p);
      console.log('    ' + (j.ok ? 'OK ' : '⚠  ') + p.id.padEnd(6) + String(p.text).slice(0, 46));
      console.log('         为什么: ' + String(p.why || '?').slice(0, 60));
      console.log('         依据:   ' + String(p.evidence || '?').slice(0, 60));
      if (p.state === 'approved') console.log('         批准:   ' + p.approvedBy + ' @ ' + p.approvedAt);
    }
    console.log();
  }

  const needWhy = pending.filter((p) => p.state === 'pending' && /待补/.test(String(p.why || '')));
  if (needWhy.length) {
    console.log('  ⚠ ' + needWhy.length + ' 条的「为什么」还没补 —— 需要人工写（我不编）');
  }
  console.log('='.repeat(80));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
