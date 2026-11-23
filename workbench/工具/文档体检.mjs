#!/usr/bin/env node
/**
 * 文档体检 —— 生命周期四状态 + 密集目录索引检查
 *
 * ══════════════════════════════════════════════════════════════
 *  依据（参考项目 05-协作与规矩/二-标准化规范.md §2.7 / §2.10）
 * ══════════════════════════════════════════════════════════════
 *
 *  【§2.7 索引机制】
 *    每场景一份索引：`_文件索引.md`，四列：`| 文件 | 是什么 | 状态 | 复核日期 |`
 *    状态只有四个词：`活` / `常备` / `留档` / `待清`
 *    三条硬规矩：
 *      ① 新建文本 ⇒ 同时登记一行
 *      ② 删/改名/移动 ⇒ 同时改那一行（索引与文件同生共死）
 *      ③ 到期自己处置 —— 更新 / 合并 / 归档 / 清（**合并优先**）
 *    ⛔ 三禁：同一主题多份并存 · 已完成的一次性产物留在活目录 · 只删文件不删索引行
 *
 *  【§2.10 ⑥ 密集目录必须有索引】
 *    用户 2026-10-17 实测投诉：
 *      「很多会话在一些有大量复杂文档的文件夹不建立索引，规矩失效了」
 *    取证：9 个密集夹里 7 个没有索引（284 份 / 54 / 42 / 36 / 34 / 29 / 15）
 *    根因：**旧规矩只管全局台账，从没要求项目内的密集子目录建索引，
 *          也没有任何体检会报 ⇒ 规矩「看着在、实际没抓手」**
 *
 *  【判据（写死，用数字）】
 *    某个常驻目录（不是 _临时）的
 *      直接子文档 ≥ 30 个，或
 *      直接子文档 ≥ 8 个且合计 ≥ 500 KB，或
 *      同一主题文件 ≥ 10 个
 *    ⇒ 该目录必须有 `_索引.md`
 *
 *    ⚠ 最小份数 8 是必须的（实测裁决）：
 *      不加它，`≥500 KB` 会把「1 份 249 MB 的图鉴」误判成文档密集。
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/文档体检.mjs                    扫默认根
 *  node 工具/文档体检.mjs --root <目录>      扫指定目录
 *  node 工具/文档体检.mjs --dense            只看密集目录
 *  node 工具/文档体检.mjs --lifecycle        只看生命周期
 *  node 工具/文档体检.mjs --json
 *  node 工具/文档体检.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// ══════════════════════════════════════════════════════════════
//  四状态 + 复核期
// ══════════════════════════════════════════════════════════════
export const STATE = {
  '活': { name: '活', reviewDays: 0, desc: '每次干活都读写的（记忆/规范/入口）' },
  '常备': { name: '常备', reviewDays: 180, desc: '半年内还会用（手册、清单、脚本说明）' },
  '留档': { name: '留档', reviewDays: 0, desc: '只作证据，不再更新' },
  '待清': { name: '待清', reviewDays: 7, desc: '已经没用了，一周内必须处理掉' },
};

/** 到期四选一（合并优先） */
export const ACTIONS = ['更新', '合并', '归档', '清'];

// ══════════════════════════════════════════════════════════════
//  密集目录判据（写死，用数字）
// ══════════════════════════════════════════════════════════════
export const DENSE = {
  /** 直接子文档 ≥ 这个数 ⇒ 密集 */
  MIN_FILES: 30,
  /** 或：直接子文档 ≥ MIN_FILES_WITH_SIZE 且合计 ≥ MIN_SIZE_KB */
  MIN_FILES_WITH_SIZE: 8,
  MIN_SIZE_KB: 500,
  /** 或：同一主题文件 ≥ 这个数 */
  MIN_SAME_TOPIC: 10,
  /** 豁免目录（临时目录不要求索引） */
  EXEMPT: /^_临时|^node_modules|^\.git|^_tmp|^回滚快照|^归档层|^备份/,
};

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  检查一个目录是否「密集但无索引」
// ══════════════════════════════════════════════════════════════
export function checkDirectory(dir) {
  const base = path.basename(dir);
  if (DENSE.EXEMPT.test(base)) {
    return { dir, exempt: true, reason: '豁免目录（' + base + '）' };
  }

  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {
    return { dir, error: '读不到' };
  }

  // 只看直接子文件（不含子目录）
  const files = entries.filter((e) => e.isFile());
  const docFiles = files.filter((e) => /\.(md|txt|json|yaml|yml|csv|log)$/i.test(e.name));

  let totalBytes = 0;
  for (const f of docFiles) {
    try { totalBytes += fs.statSync(path.join(dir, f.name)).size; } catch { /* ignore */ }
  }

  const hasIndex = files.some((e) => /^_索引\.md$|^_文件索引\.md$/i.test(e.name));

  // 判断密集
  const reasons = [];
  if (docFiles.length >= DENSE.MIN_FILES) {
    reasons.push('直接子文档 ' + docFiles.length + ' ≥ ' + DENSE.MIN_FILES);
  }
  const kb = totalBytes / 1024;
  if (docFiles.length >= DENSE.MIN_FILES_WITH_SIZE && kb >= DENSE.MIN_SIZE_KB) {
    reasons.push('文档 ' + docFiles.length + ' 份且 ' + Math.round(kb) + ' KB ≥ ' + DENSE.MIN_SIZE_KB + ' KB');
  }

  // 同主题检测（按文件名前缀，去掉扩展名和数字）
  const topicCount = {};
  for (const f of docFiles) {
    const baseName = f.name.replace(/\.[^.]+$/, '');
    // 去掉尾部数字/日期，取主题词
    const topic = baseName.replace(/[-_\d]+$/, '').replace(/\d{6,}/g, '').trim();
    if (topic.length >= 2) topicCount[topic] = (topicCount[topic] || 0) + 1;
  }
  let maxTopic = { name: '', count: 0 };
  for (const [t, c] of Object.entries(topicCount)) {
    if (c > maxTopic.count) maxTopic = { name: t, count: c };
  }
  if (maxTopic.count >= DENSE.MIN_SAME_TOPIC) {
    reasons.push('同主题「' + maxTopic.name + '」' + maxTopic.count + ' 份 ≥ ' + DENSE.MIN_SAME_TOPIC);
  }

  const isDense = reasons.length > 0;

  return {
    dir,
    docCount: docFiles.length,
    totalKB: Math.round(kb),
    isDense,
    hasIndex,
    reasons,
    missingIndex: isDense && !hasIndex,
    maxTopic: maxTopic.count > 1 ? maxTopic : null,
  };
}

// ══════════════════════════════════════════════════════════════
//  递归扫描
// ══════════════════════════════════════════════════════════════
export function scanDirs(root, opts) {
  const o = opts || {};
  const maxDepth = o.maxDepth || 4;
  const results = [];

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    const r = checkDirectory(dir);
    if (!r.exempt && !r.error) results.push(r);

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (DENSE.EXEMPT.test(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  }

  walk(root, 0);
  return results;
}

// ══════════════════════════════════════════════════════════════
//  解析索引文件的状态分布
// ══════════════════════════════════════════════════════════════
export function parseIndexStates(indexPath) {
  const md = readTextSafe(indexPath);
  if (!md) return { ok: false, error: '读不到' };

  const states = { '活': 0, '常备': 0, '留档': 0, '待清': 0, '未知': 0 };
  const rows = [];

  for (const line of md.split('\n')) {
    if (!/^\|/.test(line)) continue;
    if (/^\|[\s:-]+\|/.test(line)) continue;   // 分隔行
    const cells = line.split('|').map((x) => x.trim()).filter((x, i, a) => i > 0 && i < a.length - 1);
    if (cells.length < 3) continue;
    if (/^(文件|文件名)$/.test(cells[0])) continue;   // 表头

    const state = cells[2] || '';
    if (states[state] !== undefined) states[state]++;
    else states['未知']++;

    rows.push({ file: cells[0], what: cells[1], state, review: cells[3] || '' });
  }

  return {
    ok: true,
    total: rows.length,
    states,
    rows,
    invalidStates: rows.filter((r) => !STATE[r.state]),
  };
}

// ══════════════════════════════════════════════════════════════
//  ⚠ 2026-11-12 新增：区分「当前在用的数据」和「不该按现状维护的历史/兼容树」
//
//  为什么加（判据错误：环境状态当判据）
//
//  原判据：凡是带 _文件索引.md 的目录，都按「索引必须与目录对得上」检查。
//  错在哪：工作台有两种数据布局（见 外壳/main.js 第 539-540 行）：
//    ① 独立模式 <workbench>/数据/.dsh        ← 当前环境跑的是这个
//    ② 兼容模式 <workbench>/引擎数据/.dsh    ← 回退树，独立模式下引擎根本不读
//  实测：引擎/ 下有 package.json + cli + node.exe ⇒ 当前是独立模式，
//        引擎数据/.dsh 里那份是历史残留，**引擎不会读它**。
//        按「现状」去要求它的索引对得上，等于拿一份没人维护的旧数据判失败。
//
//  还有 归档/：只增不改的冻结历史（L5 归档层），
//  它的意义就是「当时是什么样就永远是什么样」，不能要求它跟随现状。
//  ——这两类都不是「索引写错了」，是**这个判据不该用在这棵树上**。
//
//  所以：不静默跳过，而是明确给出跳过理由（reason），
//        这样报告里能看到「跳过了什么、为什么跳过」，而不是假装全绿。
// ══════════════════════════════════════════════════════════════
export function inactiveReason(dir) {
  const norm = String(dir).replace(/\\/g, '/');
  if (/(^|\/)归档(\/|$)/.test(norm)) {
    return '归档层（L5 只增不改的冻结历史，不按现状维护）';
  }
  if (/(^|\/)引擎数据(\/|$)/.test(norm)) {
    // 只有确认「独立模式生效」时，兼容树才算不活跃
    const standalone = fs.existsSync(path.join(WB, '引擎', 'package.json')) &&
      fs.existsSync(path.join(WB, '数据', '.dsh'));
    if (standalone) {
      return '引擎数据 是兼容模式回退树，当前独立模式（数据/.dsh 生效）不读它';
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
//  索引准确性检查（2026-11-12 新增）
//
//  为什么加：这个工具叫「文档体检（生命周期 + 密集目录索引）」，
//  但原来**只查目录密不密、有没有索引文件**，
//  从来不打开索引看里面写了什么。后果：
//    · 索引里列着早就删掉的文件（幽灵行）→ 不报
//    · 目录里新增的文件没登记 → 不报（违反 §2.7 硬规矩①）
//    · 状态写了四个词以外的词 → 不报（违反四状态定义）
//  这三条正是用户投诉「规矩失效」的内核 —— 有索引文件 ≠ 索引是对的。
//
//  判据（写死，都能造出反例）：
//    ① 幽灵行：索引里引用的文件名，目录里不存在 ⇒ 报
//    ② 漏登记：目录里的 .md/.txt 文档，索引里一次都没出现 ⇒ 报
//    ③ 非法状态：内容表第三列不是 活/常备/留档/待清 ⇒ 报
//
//  ⚠ 豁免清单必须显式（INFRA_FILES）：
//     AGENTS.local.md 是引擎注入文件（工具/场景注入.mjs 生成），
//     不属于「场景产出」，不登记索引是对的。
//     不豁免它，9 个场景会各报一条假问题 —— 判据必须区分
//     「该登记的没登记」和「本来就不该登记的」。
// ══════════════════════════════════════════════════════════════
export const INFRA_FILES = [
  'AGENTS.local.md',        // 引擎注入的场景上下文
  '_索引.md', '_文件索引.md',  // 索引自身
  '_临时.md',
];

/** 目录里的文档是否属于「基础设施文件」（不要求登记索引） */
export function isInfraFile(name) {
  return INFRA_FILES.includes(name) || /^\./.test(name);
}

/**
 * 检查一份索引文件是否与目录内容对得上。
 * @param {string} dir 目录
 * @param {string} [indexPath] 索引文件路径（默认自动找 _索引.md / _文件索引.md）
 */
export function checkIndexAccuracy(dir, indexPath) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {
    return { ok: false, error: '读不到目录', problems: [] };
  }
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);

  const idxName = indexPath
    ? path.basename(indexPath)
    : (files.find((f) => /^_索引\.md$|^_文件索引\.md$/i.test(f)) || null);
  if (!idxName) {
    return { ok: false, error: '这个目录没有索引文件', hasIndex: false, problems: [] };
  }

  const full = indexPath || path.join(dir, idxName);
  const md = readTextSafe(full);
  if (md === null) return { ok: false, error: '索引读不到', problems: [] };

  const problems = [];
  const referenced = new Set();     // 索引里出现过的文件名
  const badStates = [];

  let inTable = false;
  for (const line of md.split(/\r?\n/)) {
    // 只认表格行
    if (!/^\s*\|/.test(line)) { inTable = false; continue; }
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;   // 分隔行
    inTable = true;

    const cells = line.split('|').map((x) => x.trim()).slice(1, -1);
    if (cells.length < 2) continue;
    // 表头行（含「文件 / 目录」「类型」「路径」等）
    if (/^(文件|文件名|类型|路径)\s*$/.test(cells[0])) continue;

    // 把这一行里所有反引号内容当「引用到的路径」
    for (const c of cells) {
      for (const m of c.matchAll(/`([^`]+)`/g)) {
        const raw = m[1].trim();
        if (!raw) continue;
        const norm = raw.replace(/\\/g, '/');
        const base = norm.split('/').pop();
        if (!/\.(md|txt|json|ya?ml|csv|log)$/i.test(base)) continue;

        if (norm.includes('/')) {
          // 带路径的：相对 workbench 解析，看真实存不存在
          //
          // ⚠ 2026-11-12 修（破坏性验证抓出来的缺陷）：
          //   原来写的是 `path.join('workbench', norm)` —— 相对路径会按 **cwd** 解析。
          //   而 cwd 是不确定的：在 workbench/ 里跑就变成
          //   `workbench/workbench/数据/...`（不存在）⇒ 9 个索引全报幽灵行 54 处，
          //   工具在正常状态下就恒 FAIL；换到项目根跑又全绿。
          //   「同一份数据，换个目录跑结论相反」= 判据依赖环境，不是判据。
          //   改成锚定 WB（workbench 根），与 cwd 无关。
          const rel = norm.startsWith('workbench/')
            ? path.join(path.dirname(WB), norm)
            : path.join(WB, norm);
          if (!fs.existsSync(rel)) problems.push('幽灵行（引用的路径不存在）：' + raw);
          referenced.add(base);
        } else {
          referenced.add(base);
          if (!files.includes(base)) {
            problems.push('幽灵行（索引里有、目录里没有）：' + base);
          }
        }
      }
    }

    // 内容表：第一列是 `文件名`，第三列是状态
    if (/^`[^`]+`$/.test(cells[0]) && cells[2] !== undefined && cells[2] !== '') {
      if (!STATE[cells[2]]) badStates.push(cells[0] + ' → ' + cells[2]);
    }
  }

  for (const b of badStates) {
    problems.push('非法状态：' + b + '（只能是 活/常备/留档/待清）');
  }

  // 漏登记：目录里的真文档，索引里一次都没提到
  const docFiles = files.filter((f) => /\.(md|txt)$/i.test(f) && !isInfraFile(f));
  const unregistered = docFiles.filter((f) => !referenced.has(f));
  for (const u of unregistered) {
    problems.push('漏登记（目录里有、索引里没提）：' + u);
  }

  return {
    ok: problems.length === 0,
    dir,
    indexFile: idxName,
    docCount: docFiles.length,
    referencedCount: referenced.size,
    ghostCount: problems.filter((p) => p.startsWith('幽灵行')).length,
    unregisteredCount: unregistered.length,
    badStateCount: badStates.length,
    unregistered,
    problems,
  };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  文档体检 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 四状态
  chk('四状态齐全', Object.keys(STATE).length === 4, Object.keys(STATE).join(','));
  chk('常备 180 天', STATE['常备'].reviewDays === 180, String(STATE['常备'].reviewDays));
  chk('待清 7 天', STATE['待清'].reviewDays === 7, String(STATE['待清'].reviewDays));
  chk('四选一动作', ACTIONS.length === 4, ACTIONS.join(','));
  chk('合并优先', ACTIONS[1] === '合并', ACTIONS.join(' → '));

  // ② 密集判据
  chk('密集阈值 30 份', DENSE.MIN_FILES === 30, String(DENSE.MIN_FILES));
  chk('最小份数 8（防误判）', DENSE.MIN_FILES_WITH_SIZE === 8, String(DENSE.MIN_FILES_WITH_SIZE));
  chk('同主题 ≥10', DENSE.MIN_SAME_TOPIC === 10, String(DENSE.MIN_SAME_TOPIC));

  // 准备临时目录
  const tmp = path.join(WB, 'prototype', '_tmp-doc');
  fs.rmSync(tmp, { recursive: true, force: true });

  // ③ 反例：少量文档不判密集
  const d1 = path.join(tmp, 'sparse');
  fs.mkdirSync(d1, { recursive: true });
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(d1, 'f' + i + '.md'), 'x', 'utf8');
  const r1 = checkDirectory(d1);
  chk('反例：5 份不判密集', r1.isDense === false, r1.docCount + ' 份');

  // ④ 30 份以上判密集
  const d2 = path.join(tmp, 'dense30');
  fs.mkdirSync(d2, { recursive: true });
  for (let i = 0; i < 32; i++) fs.writeFileSync(path.join(d2, 'f' + i + '.md'), 'x', 'utf8');
  const r2 = checkDirectory(d2);
  chk('32 份判密集', r2.isDense === true, r2.reasons.join(';'));
  chk('缺索引被检出', r2.missingIndex === true, '');

  // ⑤ 有索引就不报缺失
  fs.writeFileSync(path.join(d2, '_索引.md'), '# 索引\n', 'utf8');
  const r3 = checkDirectory(d2);
  chk('有索引后不再报缺失', r3.missingIndex === false, '');

  // ⑥ 同主题检测：10 份同名前缀
  const d3 = path.join(tmp, 'topic');
  fs.mkdirSync(d3, { recursive: true });
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(d3, '日报-' + i + '.md'), 'x', 'utf8');
  const r4 = checkDirectory(d3);
  chk('同主题 12 份判密集', r4.isDense === true, r4.reasons.join(';'));

  // ⑦ 反例：_临时 目录豁免
  const d4 = path.join(tmp, '_临时');
  fs.mkdirSync(d4, { recursive: true });
  for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(d4, 'f' + i + '.md'), 'x', 'utf8');
  const r5 = checkDirectory(d4);
  chk('反例：_临时 目录豁免', r5.exempt === true, r5.reason);

  // ⑧ 索引状态解析
  const idx = path.join(tmp, '_test-index.md');
  fs.writeFileSync(idx, [
    '# 索引',
    '',
    '| 文件 | 是什么 | 状态 | 复核日期 |',
    '|---|---|---|---|',
    '| a.md | 规范 | 活 | 2026-11-11 |',
    '| b.md | 手册 | 常备 | 2026-05-01 |',
    '| c.md | 报告 | 留档 | — |',
    '| d.md | 垃圾 | 待清 | 2026-11-10 |',
  ].join('\n'), 'utf8');
  const p1 = parseIndexStates(idx);
  chk('能解析索引', p1.ok === true && p1.total === 4, p1.total + ' 行');
  chk('统计四状态', p1.states['活'] === 1 && p1.states['常备'] === 1 &&
      p1.states['留档'] === 1 && p1.states['待清'] === 1,
      JSON.stringify(p1.states));

  // ⑨ 反例：非法状态
  fs.writeFileSync(idx, [
    '| 文件 | 是什么 | 状态 | 复核日期 |',
    '|---|---|---|---|',
    '| a.md | 规范 | 活跃 | 2026-11-11 |',
  ].join('\n'), 'utf8');
  const p2 = parseIndexStates(idx);
  chk('反例：非法状态被检出', p2.invalidStates.length === 1, p2.invalidStates[0]?.state);

  // ⑩ 真实扫描（只扫一个受控目录）
  const realScan = scanDirs(path.join(WB, '数据', '.dsh', 'skills'), { maxDepth: 2 });
  chk('真实扫描能跑', Array.isArray(realScan), realScan.length + ' 个目录');

  // ⑪ 关键：能检出「看着在、实际没抓手」的规矩
  chk('关键：密集无索引能被检出',
      r2.missingIndex === true && r3.missingIndex === false,
      '这正是用户投诉「规矩失效」的那类问题');

  // ══════════════════════════════════════════════════════════════
  //  ⑫ 索引内容准确性（2026-11-12 新增的反例组）
  //
  //  这一组是本次修改的核心验证：上面 ⑪ 只证明「没索引文件」能被抓到，
  //  但真正让人吃亏的是「有索引文件、内容却是错的」——
  //  原来这个工具对此**完全不检查**。
  //  下面每条都造一次破坏，确认它会红。
  // ══════════════════════════════════════════════════════════════
  const idxDir = path.join(tmp, 'idx');
  fs.mkdirSync(idxDir, { recursive: true });
  const BT = String.fromCharCode(96);   // 反引号
  const idxFile = path.join(idxDir, '_文件索引.md');
  const cleanIdx = [
    '# 索引', '',
    '| 文件 | 是什么 | 状态 | 复核日期 |',
    '|---|---|---|---|',
    '| ' + BT + '产出A.md' + BT + ' | 摘要 | 活 | - |',
    '| ' + BT + '产出B.md' + BT + ' | 摘要 | 常备 | - |',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(idxDir, '产出A.md'), 'x', 'utf8');
  fs.writeFileSync(path.join(idxDir, '产出B.md'), 'x', 'utf8');
  fs.writeFileSync(idxFile, cleanIdx, 'utf8');

  // 正例：索引与目录对得上必须通过（否则判据太严，会天天误报）
  const i1 = checkIndexAccuracy(idxDir);
  chk('正例：索引与目录对得上 ⇒ 通过', i1.ok === true, i1.problems.join(';') || 'ok');

  // 反例①：幽灵行（索引里有、目录里没有）
  fs.appendFileSync(idxFile, '| ' + BT + '早就删了.md' + BT + ' | 摘要 | 活 | - |\n', 'utf8');
  const i2 = checkIndexAccuracy(idxDir);
  chk('反例：幽灵行被检出', i2.ok === false && i2.ghostCount === 1,
      i2.problems.filter((p) => p.startsWith('幽灵行')).join(';') || '没检出');
  fs.writeFileSync(idxFile, cleanIdx, 'utf8');

  // 反例②：漏登记（目录里有、索引里没提）
  fs.writeFileSync(path.join(idxDir, '新产出C.md'), 'x', 'utf8');
  const i3 = checkIndexAccuracy(idxDir);
  chk('反例：漏登记被检出', i3.ok === false && i3.unregisteredCount === 1,
      i3.problems.filter((p) => p.startsWith('漏登记')).join(';') || '没检出');
  fs.unlinkSync(path.join(idxDir, '新产出C.md'));

  // 反例③：非法状态（四状态以外的词）
  fs.writeFileSync(idxFile, cleanIdx.replace('| 活 |', '| 活跃 |'), 'utf8');
  const i4 = checkIndexAccuracy(idxDir);
  chk('反例：非法状态被检出', i4.ok === false && i4.badStateCount === 1,
      i4.problems.filter((p) => p.startsWith('非法状态')).join(';') || '没检出');

  // 反例④：基础设施文件不该被要求登记（否则 9 个场景各报一条假问题）
  fs.writeFileSync(idxFile, cleanIdx, 'utf8');
  fs.writeFileSync(path.join(idxDir, 'AGENTS.local.md'), '# 注入', 'utf8');
  const i5 = checkIndexAccuracy(idxDir);
  chk('反例：AGENTS.local.md 豁免（不算漏登记）', i5.ok === true,
      i5.problems.join(';') || 'ok —— 它是引擎注入文件，不是场景产出');
  fs.unlinkSync(path.join(idxDir, 'AGENTS.local.md'));

  // 反例⑤：没有索引文件
  fs.unlinkSync(idxFile);
  const i6 = checkIndexAccuracy(idxDir);
  chk('反例：无索引文件 ⇒ 明确报没有', i6.ok === false && i6.hasIndex === false, i6.error || '');

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  const root = val('--root') || WB;
  const depth = Number(val('--depth')) || 4;
  const results = scanDirs(root, { maxDepth: depth });

  // ⚠ 2026-11-12 新增：索引内容准确性
  //
  //  原 CLI 只统计「密集目录有没有索引文件」，从不打开索引看内容。
  //  于是「索引里列着已删的文件」「新增文件没登记」「状态写了非法词」
  //  这三类问题永远不会让这个工具变红 —— 检查形同虚设。
  //
  //  现在：把所有带索引的目录都过一遍 checkIndexAccuracy。
  //  判据见该函数上方的注释。
  const indexResults = [];
  {
    const seen = new Set();
    const walk = (dir, d) => {
      if (d > depth) return;
      if (seen.has(dir)) return;
      seen.add(dir);
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      const hasIdx = entries.some((e) => e.isFile() && /^_索引\.md$|^_文件索引\.md$/i.test(e.name));
      if (hasIdx) {
        const inactive = inactiveReason(dir);
        if (inactive) {
          // 不查，但**明确记下为什么**（报告里要能看到）
          indexResults.push({ ok: true, skipped: true, dir, reason: inactive, problems: [] });
        } else {
          const r = checkIndexAccuracy(dir);
          if (!r.error) indexResults.push(r);
        }
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (DENSE.EXEMPT.test(e.name)) continue;
        walk(path.join(dir, e.name), d + 1);
      }
    };
    walk(root, 0);
  }
  const idxBad = indexResults.filter((r) => !r.ok);
  const idxSkipped = indexResults.filter((r) => r.skipped);
  const idxChecked = indexResults.length - idxSkipped.length;
  const idxProblemCount = idxBad.reduce((n, r) => n + r.problems.length, 0);

  if (has('--json')) {
    console.log(JSON.stringify({ root, results, indexResults }, null, 2));
    // ⚠ 退出码要真实反映：原来 --json 分支无条件 exit 0，
    //   等于「用 JSON 跑就永远绿」—— 又一条装饰路径。
    process.exit((missingCount(results) > 0 || idxProblemCount > 0) ? 1 : 0);
  }

  console.log('═'.repeat(78));
  console.log('  文档体检（生命周期 + 密集目录索引）');
  console.log('═'.repeat(78));
  console.log();
  console.log('  扫描根: ' + root);
  console.log('  目录数: ' + results.length);
  console.log();

  // 密集但无索引
  const missing = results.filter((r) => r.missingIndex);
  if (missing.length > 0) {
    console.log('  🔴 密集但缺索引（' + missing.length + ' 个）:');
    for (const m of missing.slice(0, 15)) {
      const rel = path.relative(root, m.dir).replace(/\\/g, '/') || '.';
      console.log('    · ' + rel);
      console.log('      ' + m.docCount + ' 份 / ' + m.totalKB + ' KB  ← ' + m.reasons[0]);
    }
    if (missing.length > 15) console.log('    …还有 ' + (missing.length - 15) + ' 个');
    console.log();
  }

  const denseOk = results.filter((r) => r.isDense && r.hasIndex);
  if (denseOk.length > 0) {
    console.log('  ✓ 密集且有索引（' + denseOk.length + ' 个）');
    console.log();
  }

  if (missing.length === 0) {
    console.log('  ✓ 没有「密集但缺索引」的目录');
    console.log();
  }

  // ── 索引内容准确性 ──
  console.log('  ' + '─'.repeat(70));
  console.log('  索引内容对账（检查 ' + idxChecked + ' 个，跳过 ' + idxSkipped.length + ' 个）');
  console.log('  ' + '─'.repeat(70));
  if (idxBad.length === 0) {
    console.log('  ✓ 所有在用的索引都与目录内容对得上（无幽灵行 / 无漏登记 / 状态合法）');
  } else {
    console.log('  🔴 ' + idxBad.length + ' 个索引对不上（共 ' + idxProblemCount + ' 处）:');
    for (const r of idxBad.slice(0, 8)) {
      const rel = path.relative(root, r.dir).replace(/\\/g, '/') || '.';
      console.log('    · ' + rel + '   [' + r.indexFile + ']');
      console.log('      幽灵行 ' + r.ghostCount + ' / 漏登记 ' + r.unregisteredCount +
        ' / 非法状态 ' + r.badStateCount);
      for (const p of r.problems.slice(0, 4)) console.log('      - ' + p);
      if (r.problems.length > 4) console.log('      …还有 ' + (r.problems.length - 4) + ' 处');
    }
    if (idxBad.length > 8) console.log('    …还有 ' + (idxBad.length - 8) + ' 个目录');
  }
  if (idxSkipped.length > 0) {
    console.log();
    console.log('  ○ 明确跳过（不是通过，是不该用这个判据）:');
    for (const r of idxSkipped) {
      const rel = path.relative(root, r.dir).replace(/\\/g, '/') || '.';
      console.log('    · ' + rel + '  ← ' + r.reason);
    }
  }
  console.log();

  console.log('─'.repeat(78));
  console.log('  判据：≥30 份 / ≥8 份且≥500KB / 同主题≥10 ⇒ 必须有 _索引.md');
  console.log('        有索引 ⇒ 索引必须与目录对得上（幽灵行/漏登记/非法状态都算错）');
  console.log('  来源：用户 2026-10-17 投诉「很多会话在有大量文档的文件夹不建索引，规矩失效了」');
  console.log('        2026-11-12 补：有索引文件 ≠ 索引是对的（原工具只看有没有文件）');
  console.log('─'.repeat(78));

  process.exit((missing.length > 0 || idxProblemCount > 0) ? 1 : 0);
}
