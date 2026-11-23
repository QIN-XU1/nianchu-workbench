#!/usr/bin/env node
/**
 * 拆解完整性审计 —— 找出遗漏
 *
 * 判据来自 research/拆解/标准.md：
 *   六维度都要有内容（界面可写「无」但要有理由）
 *   优势 ≥3 条、缺点 ≥3 条
 *   可照搬 ≥1、要超过 ≥1
 *
 * 这个脚本不填充内容，只**量出哪里空**。
 *
 * ── 2026-11-15 修（独立验证方 R5 + R4）──────────────────────
 * R5：原来只遍历 projects.json 里**列出来的**项目 ⇒ 整个项目消失时
 *     它打印「PASS —— 全部 21 个项目达标」并 exit 0。
 *     即「少了一个项目」这个最严重的问题，它**看不到**。
 *     （而本体论 :176 正拿它当 22/22 达标的证据。）
 *     修法：引入**独立的应有清单** EXPECTED，与 projects.json / analysis.json 三方对账。
 *
 * R4：原来用相对路径 `apps/vouch-web/...`，依赖 cwd —— 换个目录跑就找不到文件。
 *     修法：从 import.meta.dirname 推导。
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const A = path.join(REPO, 'apps/vouch-web/src/web-ui/src/app/scenes/benchmark/data/analysis.json');
const P = path.join(REPO, 'apps/vouch-web/src/web-ui/src/app/scenes/benchmark/data/projects.json');

/**
 * 应有的项目 id 清单 —— **独立于数据文件**
 *
 * 为什么写死在代码里：如果它也放在 projects.json 里，那么删项目时两边一起删，
 * 对账就永远成立（自证）。这个清单是**外部锚点**，来自用户给的 22 项需求
 * （17 项列表去重后 16 个 GitHub 项目 + 7 个闭源产品 = 22）。
 *
 * 加项目/删项目时**必须同时改这里**，且改动会在 git 里可见。
 */
const EXPECTED = [
  'openbitfun', 'chatgpt-codex', 'claude-code', 'cursor', 'trae',
  'workbuddy', 'codebuddy', 'qoder', 'dsh', 'openclaw',
  'ecc', 'hermes', 'open-design', 'omp-studio', 'orca',
  'pi', 'luanyujia', 'craft-anything', 'solo-to-team-skills',
  'cl4r1t4s', 'aionui', 'weknora',
];

const DIMS = ['arch', 'exec', 'features', 'ui', 'strengths', 'weaknesses', 'borrow', 'surpass'];
const MIN = { strengths: 3, weaknesses: 3, borrow: 1, surpass: 1, arch: 2, exec: 2, features: 1 };

/**
 * 三方对账 —— 抽成纯函数便于自检
 *
 * 这个函数是**两次真实 bug 的产物**：
 *   ① 原来脚本没有退出码，对 22/22 和 0/22 返回同样的 0（只能靠人读输出）
 *   ② 修了退出码还不够：它只遍历 projects.json 里**列出来的**项目，
 *      所以「整个项目消失」时它会打印「PASS —— 全部 21 个项目达标」并 exit 0
 *      （独立验证方 R5 的攻击）
 */
export function reconcile(expected, projectIds, analysisIds) {
  const expectedSet = new Set(expected);
  const pSet = new Set(projectIds);
  const aSet = new Set(analysisIds);

  const issues = [
    ...expected.filter((id) => !pSet.has(id)).map((id) => 'projects.json 缺项目：' + id),
    ...expected.filter((id) => !aSet.has(id)).map((id) => 'analysis.json 缺项目：' + id),
    ...[...pSet].filter((id) => !expectedSet.has(id)).map((id) => 'projects.json 出现清单外项目：' + id),
    ...[...aSet].filter((id) => !expectedSet.has(id)).map((id) => 'analysis.json 出现清单外项目：' + id),
  ];
  return issues;
}

/** 逐项目量缺口 —— 纯函数 */
export function measureGaps(projects, analysis, dims = DIMS, min = MIN) {
  const rows = [];
  for (const p of projects) {
    const a = analysis[p.id] || {};
    const gaps = [];
    for (const d of dims) {
      const n = Array.isArray(a[d]) ? a[d].length : 0;
      const need = min[d] ?? 1;
      if (n < need) gaps.push(d + '(' + n + '/' + need + ')');
    }
    const total = dims.reduce((s, d) => s + (Array.isArray(a[d]) ? a[d].length : 0), 0);
    rows.push({ id: p.id, name: p.name, kind: p.kind, hasSource: !!p.measured, total, gaps });
  }
  rows.sort((x, y) => y.gaps.length - x.gaps.length || x.total - y.total);
  return rows;
}

/**
 * 自检 —— 反例全部围绕「少了一个项目」这个最严重的完整性缺陷
 *
 * 为什么这类反例最重要：漏一个项目**在输出里看不出来**。
 * 输出会理直气壮地说「全部 N 个达标」—— N 少了一个而已，读的人不会注意。
 * 只有对账能发现。
 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);
  const EXP = ['a', 'b', 'c'];
  const mkProj = (ids) => ids.map((id) => ({ id, name: id.toUpperCase(), kind: 'oss', measured: {} }));
  const mkAna = (ids) => Object.fromEntries(ids.map((id) => [id, {
    arch: [1, 2], exec: [1, 2], features: [1], ui: [1],
    strengths: [1, 2, 3], weaknesses: [1, 2, 3], borrow: [1], surpass: [1],
  }]));

  // ── 正例 1：三方一致 → 无问题 ──
  const r1 = reconcile(EXP, ['a', 'b', 'c'], ['a', 'b', 'c']);
  T('正例 · 三方一致 → 无对账问题', (r1 || []).length === 0, JSON.stringify(r1));

  // ── 反例 1（R5 的核心）：整个项目从两个文件同时消失 ──
  //   这是最危险的情况：数据自洽（两边都少），但比应有清单少一个
  const r2 = reconcile(EXP, ['a', 'b'], ['a', 'b']);
  T('反例 · 项目同时从两个文件消失 → 必须报出',
    (r2 || []).length === 2 && (r2 || []).some((x) => /projects.*缺项目：c/.test(x)) && (r2 || []).some((x) => /analysis.*缺项目：c/.test(x)),
    JSON.stringify(r2));

  // ── 反例 2：只在 projects 里消失 ──
  const r3 = reconcile(EXP, ['a', 'b'], ['a', 'b', 'c']);
  T('反例 · 只在 projects 消失 → 报出', (r3 || []).length === 1 && /projects/.test(r3[0]), JSON.stringify(r3));

  // ── 反例 3：只在 analysis 里消失 ──
  const r4 = reconcile(EXP, ['a', 'b', 'c'], ['a', 'b']);
  T('反例 · 只在 analysis 消失 → 报出', (r4 || []).length === 1 && /analysis/.test(r4[0]), JSON.stringify(r4));

  // ── 反例 4：冒出一个清单外项目（凭空多一个）──
  const r5 = reconcile(EXP, ['a', 'b', 'c', 'ghost'], ['a', 'b', 'c', 'ghost']);
  T('反例 · 多出清单外项目 → 报出',
    (r5 || []).length === 2 && (r5 || []).every((x) => /清单外/.test(x)), JSON.stringify(r5));

  // ── 反例 5：某项目某维度清空 → 量出缺口 ──
  const ana = mkAna(['a', 'b', 'c']);
  ana.a.strengths = [];
  const g1 = measureGaps(mkProj(['a', 'b', 'c']), ana);
  T('反例 · 某项目 strengths 清空 → 报缺口',
    g1.find((r) => r.id === 'a').gaps.some((x) => /strengths\(0\/3\)/.test(x)),
    JSON.stringify(g1.find((r) => r.id === 'a').gaps));

  // ── 反例 6：项目在 projects 里但 analysis 里完全没有 → 全维缺口 ──
  const g2 = measureGaps(mkProj(['a', 'b', 'c']), mkAna(['a', 'b']));
  const cRow = g2.find((r) => r.id === 'c');
  T('反例 · analysis 里完全没有该项目 → 8 维全缺',
    !!cRow && cRow.gaps.length === 8, cRow ? cRow.gaps.length + ' 维缺' : '找不到该行');

  // ── 正例 2：全部达标 → 无缺口 ──
  const g3 = measureGaps(mkProj(['a', 'b', 'c']), mkAna(['a', 'b', 'c']));
  T('正例 · 全部达标 → 无缺口', g3.every((r) => r.gaps.length === 0),
    JSON.stringify(g3.map((r) => r.gaps)));

  // 【2026-11-16 撤回】这里曾加过 2 条「伴生断言」，声称要钉住「空集恒真」。
  // 独立验证方 v-h0081 证明它们是假改进：
  //   · 实参与已有 r3 / g2 逐字符相同，而 r3/g2 的谓词严格蕴涵新谓词
  //   · reconcile 恒返 [] 在原 8 条里就已红 4 项（r2/r3/r4/r5）
  //   · measureGaps 恒返 [] 在原 8 条里由 g1.find(...).gaps 抛 TypeError 变红
  // ⇒ 8→10 是行数增长，不是检出能力增长。已删除，自检回到 8 条。
  // 教训：T() 条数是可被刷高的度量；证明断言承重只能靠突变，不能靠数条数。

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  拆解完整性审计 · 自检（2 正例 + 6 反例，反例围绕「少一个项目」）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

const analysis = JSON.parse(fs.readFileSync(A, 'utf8')).byId;
const projects = JSON.parse(fs.readFileSync(P, 'utf8')).projects;

// ── 三方对账（在逐项审计之前，先看「东西还在不在」）──
const reconcileIssues = reconcile(EXPECTED, projects.map((p) => p.id), Object.keys(analysis));
const rows = measureGaps(projects, analysis);

console.log('');
console.log('  拆解完整性审计');
console.log('  ' + '─'.repeat(78));

// 对账结果先打出来
console.log('');
console.log('  ⓪ 三方对账（应有 ' + EXPECTED.length + ' 个 · projects ' + projects.length
  + ' · analysis ' + Object.keys(analysis).length + '）');
if (reconcileIssues.length) {
  for (const x of reconcileIssues) console.log('    ✗ ' + x);
} else {
  console.log('    ✓ 三份清单一致');
}
console.log('  ' + '项目'.padEnd(22) + '源码'.padEnd(6) + '条数'.padEnd(6) + '缺什么');
console.log('  ' + '─'.repeat(78));

let bad = 0;
for (const r of rows) {
  const mark = r.gaps.length === 0 ? '✓' : r.gaps.length >= 4 ? '✗' : '⚠';
  if (r.gaps.length) bad++;
  console.log('  ' + mark + ' ' + r.name.padEnd(20) + (r.hasSource ? '有' : '无').padEnd(6) +
    String(r.total).padEnd(6) + (r.gaps.join(' ') || '—'));
}

console.log('  ' + '─'.repeat(78));
console.log('  达标 ' + (rows.length - bad) + '/' + rows.length
  + '  不达标 ' + bad
  + (reconcileIssues.length ? '  对账问题 ' + reconcileIssues.length : ''));

// 汇总各维度的总覆盖率
console.log('');
console.log('  各维度总覆盖');
const dimStat = {};
for (const d of DIMS) {
  const filled = projects.filter((p) => Array.isArray(analysis[p.id]?.[d]) && analysis[p.id][d].length > 0).length;
  dimStat[d] = filled;
  const bar = '█'.repeat(Math.round((filled / projects.length) * 24)).padEnd(24, '·');
  console.log('  ' + d.padEnd(12) + bar + ' ' + filled + '/' + projects.length);
}

// 无源码的项目：它们的 ui / exec 维度天然弱
const noSource = rows.filter((r) => !r.hasSource);
console.log('');
console.log('  无本机源码的 ' + noSource.length + ' 个：' + noSource.map((r) => r.name).join('、'));
console.log('  （这些项目的 ui/exec 维度只能靠文档，缺是合理的）');

// ── 退出码 ──────────────────────────────────────────────────
//
// 【2026-11-15 修一】原来这个脚本**没有退出码** —— 从来不调 process.exit()，
// 所以永远 exit 0，无论有多少项目不达标。它只能靠人读输出，**不能当门禁**。
// 发现方式：L4 度量的 F02（清空某项目的 strengths）后它仍 exit 0。
//
// 【2026-11-15 修二 · 独立验证方 R5】修一还不够：
// 它只遍历 projects.json 里**列出来的**项目，所以**整个项目消失**时
// 它打印「PASS —— 全部 21 个项目达标」并 exit 0。
// 「少一个项目」是最严重的完整性缺陷，它却看不到。
// 修法：⓪ 三方对账（EXPECTED ↔ projects.json ↔ analysis.json），对账不齐直接 FAIL。
//
// 四态：
//   UNKNOWN  项目列表为空（连输入都没有）
//   FAIL     对账不齐 或 有项目不达标
//   PASS     对账一致 且 全部达标
const state = !rows.length ? 'UNKNOWN'
  : (reconcileIssues.length || bad) ? 'FAIL'
    : 'PASS';
console.log('');
console.log('  四态: ' + state + ' —— ' + (
  !rows.length ? '项目列表为空'
    : reconcileIssues.length ? '对账不齐（' + reconcileIssues.length + ' 项）' + (bad ? ' 且 ' + bad + ' 个项目不达标' : '')
      : bad ? bad + ' 个项目不达标'
        : '对账一致 · 全部 ' + EXPECTED.length + ' 个项目达标'
));

process.exit(state === 'PASS' ? 0 : state === 'UNKNOWN' ? 2 : 1);