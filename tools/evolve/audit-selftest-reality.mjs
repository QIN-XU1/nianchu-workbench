#!/usr/bin/env node
// syntax-guard:allow-bad-words
//   本脚本的突变表里必须写出 BAD_WORDS 的原始正则（它破坏的就是那个正则），
//   所以 `imporo` 等词会出现在本文件里。这是**合法引用**，不是损坏。
/**
 * 自检的元检验 —— **把被测代码打瘸，自检必须变红**
 *
 * ── 这个脚本要解决的问题 ──────────────────────────────────
 * T2 要求「所有验收器经过反例检验」。但审计（tools/evolve/audit-claims.mjs、
 * audit-verifiers.mjs）判断「有没有反例」的方式是**正则数断言文本里的关键词**
 * （「反例」「不许」「拒绝」…）。
 *
 * 那是在数关键词，不是在验证反例真的有效。
 * 一个自检完全可以写着「✓ 反例 · 超红线必须标红」，而实际实现根本不判。
 *
 * ── 真正的判据：突变检验（mutation test）────────────────────
 * 对每个有自检的验收器：
 *   ① 正常跑自检 → 应当全绿
 *   ② **把它的核心判定逻辑打瘸**（让它永远通过 / 永远不报）
 *   ③ 再跑自检 → **必须变红**
 *
 * 如果打瘸了它自检还是绿的 ⇒ 那个自检是装饰品，
 * 它并没有在测核心逻辑，只是在测「函数能跑不崩」。
 *
 * 这是我能想到的、唯一能机械化证明「反例是真的」的办法。
 *
 * ── 为什么每项要手写「怎么打瘸」──────────────────────────
 * 通用突变（随便改个符号）会产生语法错误，测不出东西。
 * 必须针对每个验收器的**核心判据**写出精确的破坏方式 ——
 * 这些破坏点本身就是一份"这个验收器到底靠什么在判"的说明书。
 *
 * 用法：node tools/evolve/audit-selftest-reality.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');

/**
 * 每个验收器：怎么把它的核心逻辑打瘸
 *
 * cripple: { file, find, replace } —— 精确替换，替换不到就报错（不许静默跳过）
 * why: 打瘸的是什么
 * expectRedOn: 打瘸后哪个断言会红（写出来便于人核对）
 */
const TARGETS = [
  {
    script: 'tools/quality/size-guard.mjs',
    cripple: {
      file: 'tools/quality/size-guard.mjs',
      find: 'red: own.filter((f) => f.bytes > redBytes && !allow[f.rel]),',
      replace: 'red: [],   // [crippled] 红线判定永远为空',
    },
    why: '把红线判定改成永远返回空数组 ⇒ 任何超大文件都不会被报',
    expectRedOn: '反例 · 只超红线 1 字节（32769B）→ 必须标红',
  },
  {
    script: 'tools/benchmark/audit-coverage.mjs',
    cripple: {
      file: 'tools/benchmark/audit-coverage.mjs',
      find: '    ...expected.filter((id) => !pSet.has(id)).map((id) => \'projects.json 缺项目：\' + id),',
      replace: '    // [crippled] projects 缺项目不报了',
    },
    why: '让三方对账忽略「projects.json 缺项目」⇒ 项目消失查不出',
    expectRedOn: '反例 · 只在 projects 消失 → 报出',
  },
  {
    script: 'prototype/hermes-agents/audit-matrix-honesty.mjs',
    cripple: {
      file: 'prototype/hermes-agents/audit-matrix-honesty.mjs',
      find: '      if (st === \'有\') {',
      replace: '      if (false) {   // [crippled] 声称「有」但零证据也不报了',
    },
    why: '让「声称有却零证据」不再报违规 ⇒ 最典型假绿被放过',
    expectRedOn: '反例 · 声称「有」但零证据 → 报假绿',
  },
  {
    script: 'prototype/hermes-agents/verify-goal.mjs',
    // verify-goal --selftest 测的是 four-state.mjs 的四态裁决
    cripple: {
      file: 'prototype/hermes-agents/four-state.mjs',
      find: '  if (n(counts.unknown) > 0) return 2;',
      replace: '  if (n(counts.unknown) > 0) return 0;   // [crippled] UNKNOWN 被算成通过',
    },
    why: '把「有 UNKNOWN 就退出 2」改成退出 0 ⇒ UNKNOWN 被并入通过（本项目最核心的纪律）',
    expectRedOn: '有 UNKNOWN 退出 2 / UNKNOWN 不许被算成通过',
  },
  {
    script: 'tools/evolve/evolve.mjs',
    cripple: {
      file: 'tools/evolve/evolve.mjs',
      find: '  const C2_MIN = 8;',
      replace: '  const C2_MIN = 0;   // [crippled] 样本量闸门被拆掉',
    },
    why: '把 C2 样本量门槛从 8 改成 0 ⇒ 样本不足也能下判定',
    expectRedOn: 'C2 · 样本量 3 < 8 → 不许下判定',
  },
  {
    script: 'tools/cost/meter.mjs',
    cripple: {
      file: 'tools/cost/meter.mjs',
      find: '  if (!res.id || unit === undefined || unit === null) {',
      replace: '  if (false) {   // [crippled] 无价模型也当成有价',
    },
    why: '让无价模型不再走 UNKNOWN 分支 ⇒ 金额会被算成 0 而不是 UNKNOWN',
    expectRedOn: '无价模型 → 金额 UNKNOWN（不是 0）',
  },
  {
    script: 'tools/memory/store.mjs',
    cripple: {
      file: 'tools/memory/store.mjs',
      find: '  if (!source || !String(source).trim()) {',
      replace: '  if (false) {   // [crippled] 无来源也允许写入',
    },
    why: '让「没有来源的记忆不许写入」失效 ⇒ 溯源纪律被拆掉（C3 的根）',
    expectRedOn: '无来源拒绝写入',
  },
  {
    script: 'tools/evolve/audit-claims.mjs',
    cripple: {
      file: 'tools/evolve/audit-claims.mjs',
      find: '      pass: exists && (strongOk || (weakOk && mutationMap.size === 0)),',
      replace: '      pass: true,   // [crippled] 一律判通过',
    },
    why: '让「不达标的主张」也被判通过 ⇒ T4 审计变成橡皮图章',
    expectRedOn: '反例 · 验收器不存在 → 判不通过 / 反例 · 突变 DECORATIVE → 必须判不通过',
  },
  {
    script: 'tools/evolve/measure-real-recall.mjs',
    cripple: {
      file: 'tools/evolve/measure-real-recall.mjs',
      find: '  const defectSilent = defectRun.code === 0;',
      replace: '  const defectSilent = false;   // [crippled] 第一版的错：B 类缺陷态永远算「没复现」',
    },
    why: '把 B 类判据退回第一版（缺陷态 exit 0 判成漏）⇒ 3/5 判错的历史 bug 复现',
    expectRedOn: 'B 类 · 缺陷态 exit 0 + 仅触发 exit 1 → 抓到 / 反例（第一版）',
  },
  {
    script: 'tools/evolve/measure-summary.mjs',
    cripple: {
      file: 'tools/evolve/measure-summary.mjs',
      find: '  const runsEnough = runs >= 2;',
      replace: '  const runsEnough = runs >= 0;   // [crippled] 单轮也算可复算（历史 bug 复现）',
    },
    why: '让「轮数 ≥2 才算验过可复算」失效 ⇒ 只跑一轮也声称一致（历史 bug 复现）',
    expectRedOn: '反例 · 单轮（runs=1）→ reproducible 必须是 null',
  },
  {
    script: 'tools/evolve/audit-verifiers.mjs',
    cripple: {
      file: 'tools/evolve/audit-verifiers.mjs',
      find: '  return /process\\.argv\\s*(?:\\.includes\\(|\\.indexOf\\(|\\[\\s*\\d+\\s*\\]\\s*===)/.test(text)',
      replace: '  return true;   // [crippled] 检测退化成「永远算有」\n  return /process\\.argv\\s*(?:\\.includes\\(|\\.indexOf\\(|\\[\\s*\\d+\\s*\\]\\s*===)/.test(text)',
    },
    why: '让「有没有自检」的检测永远返回 true ⇒ 调用别人的也算自己有（历史 bug 复现）',
    expectRedOn: '反例 · 只调用别人的 --selftest → 不算自己有',
  },
  {
    script: 'tools/evolve/audit-four-state-layers.mjs',
    cripple: {
      file: 'tools/evolve/audit-four-state-layers.mjs',
      find: 'export function stripStringsAndComments(src) {',
      replace: 'export function stripStringsAndComments(src) {\n  return src;   // [crippled] 不剥字符串/注释了',
    },
    why: '让「剥字符串与注释」失效 ⇒ 字符串里的 process.exit(7) 会被当成真代码（历史 bug 复现）',
    expectRedOn: '反例 · 字符串里的 process.exit(7) → 剥掉后不存在',
  },
  {
    script: 'prototype/agent-ui/verify-syntax-guard.mjs',
    cripple: {
      file: 'prototype/agent-ui/verify-syntax-guard.mjs',
      find: 'const BAD_WORDS = /\\b(imporo|conso|paoh|diso|oools|homl|BioFun)\\b/;',
      replace: 'const BAD_WORDS = /__never_matches_anything__/;   // [crippled] 损坏词检测被拆掉',
    },
    why: '让已知损坏词检测失效 ⇒ t→o 事故那类损坏不再被发现',
    expectRedOn: '损坏词相关断言',
  },
  {
    script: 'prototype/agent-ui/verify-no-abspath.mjs',
    cripple: {
      file: 'prototype/agent-ui/verify-no-abspath.mjs',
      find: '        if (p.re.test(line)) {',
      replace: '        if (false) {   // [crippled] 硬编码路径不再被报',
    },
    why: '让硬编码绝对路径检测失效 ⇒ 守卫形同虚设',
    expectRedOn: '硬编码路径的反例断言',
  },

];

function runSelfTest(script) {
  try {
    const out = execFileSync(process.execPath, [path.join(REPO, script), '--selftest'], {
      cwd: REPO, encoding: 'utf8', timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out, green: true };
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    return { code: e.status ?? 1, out, green: false };
  }
}

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  \u53d8\u5f02\u68c0\u9a8c\u5143\u68c0\u67e5 \u00b7 \u81ea\u68c0\uff08\u6821\u9a8c\u7a81\u53d8\u8868\u951a\u70b9\uff0c4 \u6b63\u4f8b + 6 \u53cd\u4f8b\uff09');
  console.log('  ' + '-'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  \u7ed3\u8bba: ' + (r.ok ? '\u2713 ' + r.pass + '/' + r.total : '\u2717 ' + (r.total - r.pass) + ' \u9879\u4e0d\u6210\u7acb'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}


const results = [];

console.log('');
console.log('  自检的元检验 —— 把被测代码打瘸，自检**必须变红**');
console.log('  ' + '='.repeat(80));
console.log('  为什么：审计靠正则数「反例」关键词，那证明不了反例是真的。');
console.log('  只有当核心逻辑被打瘸时自检会红，才说明它真的在测核心逻辑。');
console.log('');

for (const t of TARGETS) {
  if (t.skip) {
    results.push({ script: t.script, state: 'SKIP', why: t.why });
    console.log('  ⏭  ' + t.script.padEnd(50) + '跳过（' + t.why + '）');
    continue;
  }

  const crippleFile = path.join(REPO, t.cripple.file);
  if (!fs.existsSync(crippleFile)) {
    results.push({ script: t.script, state: 'UNKNOWN', why: '打瘸目标文件不存在' });
    console.log('  ❔ ' + t.script.padEnd(50) + '目标文件不存在');
    continue;
  }

  // ① 基线：打瘸之前自检应当绿
  const before = runSelfTest(t.script);
  if (!before.green) {
    results.push({ script: t.script, state: 'BASELINE_RED', why: '打瘸之前自检就不绿，无法判定' });
    console.log('  ⚠ ' + t.script.padEnd(50) + '基线不绿（自检本来就没过）');
    continue;
  }

  // ② 打瘸
  const old = fs.readFileSync(crippleFile, 'utf8');
  if (!old.includes(t.cripple.find)) {
    results.push({ script: t.script, state: 'CRIPPLE_FAILED', why: '打瘸锚点没找到：' + t.cripple.find.slice(0, 50) });
    console.log('  ✗ ' + t.script.padEnd(50) + '打瘸锚点没找到（判据变了？）');
    continue;
  }

  let after;
  try {
    fs.writeFileSync(crippleFile, old.replace(t.cripple.find, t.cripple.replace), 'utf8');
    after = runSelfTest(t.script);
  } finally {
    fs.writeFileSync(crippleFile, old);
  }

  // ③ 判定
  const survived = after.green;
  const redLine = after.out.split('\n').filter((l) => /^\s*✗/.test(l)).slice(0, 1).join('').trim();

  results.push({
    script: t.script, state: survived ? 'DECORATIVE' : 'REAL',
    why: t.why, expectRedOn: t.expectRedOn,
    redLine: redLine || null,
  });

  if (survived) {
    console.log('  ✗ ' + t.script.padEnd(50) + '**打瘸了自检还是绿的 ⇒ 这个自检是装饰**');
    console.log('      打瘸方式: ' + t.why);
  } else {
    console.log('  ✓ ' + t.script.padEnd(50) + '打瘸后自检变红');
    console.log('      打瘸: ' + t.why.slice(0, 60));
    if (redLine) console.log('      变红的断言: ' + redLine.slice(0, 66));
  }
}

// ── 汇总 ──
const measured = results.filter((r) => r.state === 'REAL' || r.state === 'DECORATIVE');
const real = results.filter((r) => r.state === 'REAL');
const decorative = results.filter((r) => r.state === 'DECORATIVE');
const skipped = results.filter((r) => r.state === 'SKIP');

console.log('');
console.log('  ' + '─'.repeat(80));
console.log('  检验 ' + measured.length + ' 个 · 真实 ' + real.length + ' · 装饰 ' + decorative.length
  + (skipped.length ? ' · 跳过 ' + skipped.length : ''));

const state = measured.length === 0 ? 'UNKNOWN'
  : decorative.length ? 'FAIL'
    : 'PASS';

if (decorative.length) {
  console.log('');
  console.log('  ✗ 这些自检是装饰（打瘸核心逻辑仍绿）：');
  for (const d of decorative) console.log('      ' + d.script + '  —— ' + d.why);
}

console.log('');
console.log('  四态: ' + state + ' —— ' + (
  state === 'PASS' ? real.length + ' 个自检经突变检验确认是真的（打瘸核心逻辑必红）'
    : state === 'FAIL' ? decorative.length + ' 个自检是装饰（打瘸了还绿）'
      : '没有可检验的目标'
));

const OUT = {
  what: '自检的元检验：突变后自检必须变红',
  at: new Date().toISOString(),
  state,
  measured: measured.length, real: real.length, decorative: decorative.length,
  results,
};
const outPath = path.join(REPO, 'evidence/evolve/selftest-reality.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(OUT, null, 2) + '\n', 'utf8');
console.log('  → ' + path.relative(REPO, outPath));
console.log('');

if (process.argv.includes('--json')) console.log(JSON.stringify(OUT, null, 2));
process.exit(state === 'PASS' ? 0 : state === 'FAIL' ? 1 : 2);

/**
 * 自检 —— 校验突变表本身是否完好（4 正例 + 6 反例）
 *
 * 正例钉住的是**内容**：表恰好 14 条、14 个锚点全命中、14 个不同目标文件、
 * 只坏一条时精确红 1 条。表被清空或写残时这些会立刻红，反例则大都会空转变绿。
 * （若将来新增/合并突变目标，第 14 这个数字要**有意**改，别让正例悄悄漂移。）
 *
 * 【为什么必须有这个】
 * 这个脚本的结论是「14 个自检是真实的」。它的全部可信度压在 TARGETS 表上：
 * 每条 cripple 的 `find` 锚点必须**真的能在目标文件里找到**。
 *
 * 锚点一旦因为重构失效，会发生什么：
 *   · 替换不生效 → 代码没被打瘸 → 自检照常通过 → 被记成「装饰」或「跳过」
 *   · 更糟：如果判据只看「打完瘸自检 exit!=0」，而锚点失效导致**脚本崩溃**，
 *     也会 exit!=0，被误记成 **REAL** —— 这就是把崩溃当成「检验有效」。
 *
 * 已经踩过两次陈旧锚点（RT-03/RT-04）。这份自检把这类问题挡在门口。
 */
/**
 * 校验一张突变表本身 —— 6 条反例
 *
 * 抽成独立函数（不写在 selfTest 里），是为了让**正例**能把一张夹具表直接喂进来复核，
 * 而不必递归调用 selfTest（2026-11-16 踩过：正例里自调用 ⇒ 无限递归 / 栈溢出）。
 */
function auditTable(list) {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  // ── 反例 1：突变表不能为空 ──
  T('反例 · 突变表不能为空（空表 = 什么都没验）', list.length > 0, 'length=' + list.length);

  // ── 反例 2：每条必须有 script / cripple / why / expectRedOn ──
  const missing = [];
  for (const x of list) {
    for (const k of ['script', 'cripple', 'why', 'expectRedOn']) {
      if (!x[k]) missing.push((x.script || '?') + ' 缺 ' + k);
    }
    if (x.cripple && (!x.cripple.file || !x.cripple.find || x.cripple.replace === undefined)) {
      missing.push((x.script || '?') + ' cripple 字段不全');
    }
  }
  T('反例 · 每条必须有 script/cripple/why/expectRedOn', missing.length === 0, missing.slice(0, 3).join(' / '));

  // ── 反例 3（核心）：每条 cripple.find 锚点必须**真的在目标文件里** ──
  const stale = [];
  for (const x of list) {
    const rel = x.cripple && x.cripple.file;
    if (!rel) continue;
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) { stale.push((x.script || '?') + ' 目标文件不存在：' + rel); continue; }
    const text = fs.readFileSync(abs, 'utf8');
    if (!text.includes(x.cripple.find)) {
      stale.push((x.script || '?') + ' 锚点不在 ' + rel + '：' + String(x.cripple.find).slice(0, 40));
    }
  }
  T('反例 · 每条 cripple 锚点必须真的在目标文件里（陈旧锚点=假绿）',
    stale.length === 0, stale.slice(0, 3).join(' / '));

  // ── 反例 4：script 文件也必须存在 ──
  // 【注】不要求 script === cripple.file：打瘸**依赖文件**是合法的
  // （如 verify-goal 依赖 four-state.mjs，打瘸后者同样能让前者变红）
  const ghostScript = list.filter((x) => x.script && !fs.existsSync(path.join(REPO, x.script)));
  T('反例 · script 文件必须存在', ghostScript.length === 0,
    ghostScript.map((x) => x.script).slice(0, 2).join(','));

  // ── 反例 5：replace 不许与 find 完全相同（那样等于没打瘸）──
  const noop = list.filter((x) => x.cripple && x.cripple.replace === x.cripple.find);
  T('反例 · replace 不许与 find 相同（等于没打瘸）', noop.length === 0,
    noop.map((x) => x.script).join(','));

  // ── 反例 6：expectRedOn 必须是一句有内容的描述（不许空/太短）──
  const ghostExpect = list.filter((x) => !x.expectRedOn || String(x.expectRedOn).trim().length < 5);
  T('反例 · expectRedOn 必须有实际内容', ghostExpect.length === 0,
    ghostExpect.map((x) => x.script).slice(0, 2).join(','));

  return cases;
}

export function selfTest(TARGETS_IN = TARGETS) {
  const list = TARGETS_IN || [];
  const cases = auditTable(list);
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  // ══ 正例 ══════════════════════════════════════════════════════
  // 【2026-11-16 补】上面 6 条全是「不许坏」。但**表本身被清空/写残**时，
  // 其中 5 条会空转变绿（空表当然没有坏条目）—— 剩下的唯一锚点只有反例 1。
  // 所以补 4 条正例：表里必须真的有东西，且条数 / 锚点命中数 / 目标文件数
  // 必须等于**精确值 14**（不是「非空即过」）。

  // 正例 1：拿一张完好的单条夹具表，校验必须精确 6/6 全绿（不许一律判红）
  const SELF_FILE = 'tools/evolve/audit-selftest-reality.mjs';
  const goodEntry = {
    script: SELF_FILE,
    cripple: {
      file: SELF_FILE,
      find: "const REPO = path.resolve(import.meta.dirname, '../..');",
      replace: 'const REPO = null;',
    },
    why: '正例夹具：把仓库根改成 null',
    expectRedOn: '正例夹具：目标脚本自检变红即可',
  };
  const good = auditTable([goodEntry]);
  T('正例 · 一张完好的突变表必须精确 6/6 全绿、0 条判红（不许一律判红）',
    good.length === 6 && good.filter(([, ok]) => !ok).length === 0,
    'length=' + good.length + ' bad=' + good.filter(([, ok]) => !ok).length);

  // 正例 2：真实突变表必须恰好 14 条，且 14 条锚点逐条命中目标文件
  const anchorHits = list.filter((x) => {
    const abs = path.join(REPO, x.cripple.file);
    return fs.existsSync(abs) && fs.readFileSync(abs, 'utf8').includes(x.cripple.find);
  }).length;
  T('正例 · 真实突变表必须恰好 14 条，且 14 条锚点全部命中（命中数精确等于 14）',
    list.length === 14 && anchorHits === 14,
    'length=' + list.length + ' anchorHits=' + anchorHits);

  // 正例 3：14 条必须覆盖 14 个互不相同的打瘸目标文件
  const crippleFiles = new Set(list.map((x) => x.cripple.file));
  T('正例 · 14 条打瘸目标必须是 14 个互不相同的文件（不许两处打同一个）',
    crippleFiles.size === 14, 'files=' + crippleFiles.size);

  // 正例 4：只坏一条锚点时必须精确红 1 条（5/6）—— 证明它既不全绿也不全红
  const probeBroken = list.map((x, i) => (i === 0
    ? { ...x, cripple: { ...x.cripple, find: '正例探针：这条锚点故意不存在' } }
    : x));
  const oneBroken = auditTable(probeBroken);
  const oneBrokenBad = oneBroken.filter(([, ok]) => !ok).length;
  T('正例 · 只坏一条锚点 ⇒ 必须精确 6 条里红 1 条（5/6，既不许全红也不许全绿）',
    oneBroken.length === 6 && oneBrokenBad === 1,
    'length=' + oneBroken.length + ' bad=' + oneBrokenBad);

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

