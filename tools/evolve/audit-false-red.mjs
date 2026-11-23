#!/usr/bin/env node
/**
 * 假失败审计 —— 检验「验收器会不会把真实证据判成没证据」
 *
 * ── 为什么需要它 ────────────────────────────────────────
 * 2026-11-16 发现 evidence-grade.mjs 有三个 bug，导致 3 个**真实存在**的实现
 * 被判成「纯文字，无法核验」：
 *   ① PATH_RE 带 /g，exec 的 lastIndex 跨调用残留
 *   ② 扩展名交替 ts|tsx 使 .tsx 被截成 .ts
 *   ③ 字符类不含 CJK，中文目录路径匹配不上
 *
 * 这三个 bug 的共同点：**错误方向是「让项目看起来更差」**。
 * 项目里所有机制（audit-matrix-honesty / selftest 反例 / 四态）都在防
 * 「假的通过」（假绿），**没有任何一个在防「假的失败」（假红）**。
 *
 * ── 这个脚本做什么 ────────────────────────────────────────
 * 对每个验收器，除了跑它的 --selftest（验反例会红），再检查它有没有
 * **正例**（应当通过的输入确实通过）。没有正例的验收器，无法排除假红。
 *
 * 判定：
 *   PASS    有 selftest 且至少有 1 条正例断言
 *   WARN    有 selftest 但全是反例（可能假红，无法排除）
 *   FAIL    selftest 跑不过
 *   UNKNOWN 无法读取或无法判断
 *
 * 用法：node tools/evolve/audit-false-red.mjs [--selftest] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const NODE = process.execPath;

/** 我们认定的「正例断言」写法（中文/英文都收） */
const POSITIVE = [
  /[\u4e00-\u9fff]?正例/,           // 「正例 · ...」
  /\bpositive\b/i,
  /应当通过/,
  /应判 pass/i,
  /must pass/i,
  /应返回 path/,
  /应返回 true/,
  // 【2026-11-16 加】很多 selftest 用「<合法输入> → <成功结果>」的写法，
  // 不写「正例」二字。之前只认字面「正例」，把 evolve.mjs 里
  // 「合法假设 → 登记成功」「独立验证方 → 结案 closed」这类真正例判成了缺失。
  // 收紧条件：必须同时出现「合法/独立/正常」等正向输入词 + 「成功/通过/closed」等正向结果词。
  /(合法|独立验证方|正常输入|完整输入)[^。\n]{0,40}(成功|通过|closed|PASS|接受|登记)/,
  // 【2026-11-16 加】领域标签式正例：断言用「A 类 · 缺陷态 exit 1 → 抓到」这种写法，
  // 完全不出现「正例」二字。要求：句子以类别标签开头 + 含明确的正向结果词。
  // 收紧条件：必须是 T('<短标签>·<描述含正向结果词>') 这种形状，
  // 且正向结果词是「抓到/命中/判为/识别出」等明确词，不是泛泛的「成功」。
  /T\('[^']{0,12}[·：:][^']{0,60}(抓到|命中|判为|识别出|算 matched|rate=100)'/,
];

/** 反例断言写法 */
const NEGATIVE = [
  /反例/,
  /\bnegative\b/i,
  /应当失败/,
  /应判 fail/i,
  /must fail/i,
];

/**
 * 分析一个 selftest 源码，统计正例/反例断言数
 * 只数「断言行」附近出现的关键词，避免把注释里的说明也算进去
 */
export function analyzeSelftest(src) {
  const lines = src.split('\n');
  let pos = 0, neg = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // 只看看起来像断言调用的行（含 T( 或 assert 或 expect）
    const isAssert = /\bT\(|assert\(|expect\(|check\(/.test(l);
    if (!isAssert) continue;
    const hasPos = POSITIVE.some((r) => r.test(l));
    const hasNeg = NEGATIVE.some((r) => r.test(l));
    if (hasPos) pos++;
    if (hasNeg) neg++;
  }
  return { positive: pos, negative: neg, total: pos + neg };
}

/**
 * 抽取 selftest 里的断言三元组（名称 / 条件 / 是否正例）
 * 只做保守解析：抓 T('名', 条件, ...) 这一种最常见形态，解析不了的不计入。
 */
export function extractAssertions(src) {
  const out = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // 【2026-11-16 修】跳过「字符串字面量里的 T(」——
    // 自检里故意写坏夹具（如 "  T('正例 · 假的', true, '');"）用来验证检测器，
    // 那是字符串不是真断言，不该被算进本文件的断言质量。
    if (/^\s*["'`]/.test(l)) continue;
    if (/^\s*(\/\/|\*)/.test(l)) continue; // 注释里的 T( 不算断言
    const m = /T\(\s*'([^']*)'\s*,\s*(.+)$/.exec(l);
    if (!m) continue;
    let rest = m[2];
    // 去掉最外层尾部的 ); 或 )；
    rest = rest.replace(/\)\s*;?\s*$/, '');
    // 按括号深度找深度 0 的第一个逗号 —— 那是 cond 与 why 的分界
    let depth = 0, cut = -1;
    for (let k = 0; k < rest.length; k++) {
      const c = rest[k];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0) { cut = k; break; }
    }
    const cond = (cut >= 0 ? rest.slice(0, cut) : rest).trim();
    const isPos = POSITIVE.some((r) => r.test(l));
    const isNeg = NEGATIVE.some((r) => r.test(l));
    out.push({ name: m[1], cond, line: i + 1, positive: isPos, negative: isNeg });
  }
  return out;
}

/** ① 恒真断言检测 */
export function checkTautology(assertions) {
  const bad = [];
  for (const a of assertions) {
    const c = a.cond.replace(/\s+/g, '');
    if (!c) { bad.push({ ...a, why: '条件为空' }); continue; }
    if (c === 'true') { bad.push({ ...a, why: '条件就是字面 true' }); continue; }
    if (c === '1===1' || c === '0===0' || c === '!!1') { bad.push({ ...a, why: '常量比较恒真' }); continue; }
    // 自反：x === x / x !== x（后者恒假，同样是垃圾）
    const reflex = /^([A-Za-z_$][\w$.]*)(===|==|!==|!=)\1$/.exec(c);
    if (reflex) { bad.push({ ...a, why: '自反比较恒真/恒假（' + reflex[0] + '）' }); continue; }
    if (/^\(?true\)?$/.test(c)) bad.push({ ...a, why: '括号包裹的 true' });
  }
  return bad;
}

/**
 * ② 重复探针检测 —— 同一组字面量实参被反复使用
 *
 * 【2026-11-16 改进】原来只在断言内部找探针，漏了最常见的造假形态：
 *   先 `const r3 = reconcile(EXP, ['a','b'], ['a','b','c']);` 再断言 r3，
 *   然后在**另一条**断言里把同样的实参再写一遍。
 * 这正是 H-0081 的形态 —— 实参逐字符相同，谓词被前者严格蕴涵，检出力为 0。
 *
 * 现在扫描整个源码里的「函数名+字面量实参」形态，出现 >=2 次且至少一次在 T() 内 ⇒ 报重复。
 */
export function checkDuplicateProbes(assertions, fullSrc) {
  const src = String(fullSrc || '');
  const probes = new Map();
  // 抓 fn( ... ) 里只含字面量/标识符的调用（保守：不含嵌套函数定义）
  const re = /([A-Za-z_$][\w$.]*)\(([^()]*)\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const probe = (m[1] + '(' + m[2] + ')').replace(/\s+/g, '');
    if (probe.length < 10) continue;              // 太短的调用没什么判别力
    if (/^(if|for|while|switch|catch|T|JSON\.stringify|String|Number|Boolean)$/.test(m[1])) continue;
    const line = src.slice(0, m.index).split('\n').length;
    if (!probes.has(probe)) probes.set(probe, []);
    probes.get(probe).push(line);
  }
  const dups = [];
  const taplines = assertions.map((a) => a.line);
  for (const [probe, lines] of probes) {
    if (lines.length < 2) continue;
    // 至少一次出现在某条断言行附近（±3 行，因为断言可能跨行）
    const nearAssert = lines.some((l) => taplines.some((tl) => Math.abs(tl - l) <= 3));
    if (!nearAssert) continue;
    dups.push({ probe: probe.slice(0, 80), lines });
  }
  return dups;
}

/** ③ 是否引用了被测模块的导出符号 */
export function checkModuleRefs(assertions, exports) {
  if (!exports || !exports.length) return [];
  const out = [];
  for (const a of assertions) {
    if (!a.positive) continue; // 只要求正例引用被测模块
    const hit = exports.some((e) => new RegExp('\\b' + e.replace(/[$]/g, '\\$') + '\\b').test(a.cond));
    if (!hit) out.push({ ...a, why: '正例条件里没有引用被测模块的任何导出符号（' + exports.slice(0, 6).join('/') + '）' });
  }
  return out;
}

/** 综合质量检查 */
export function checkAssertionQuality(assertions, exports, fullSrc) {
  const taut = checkTautology(assertions);
  const dup = checkDuplicateProbes(assertions, fullSrc);
  const noref = checkModuleRefs(assertions, exports);
  const problems = [];
  for (const x of taut) problems.push('恒真断言「' + x.name + '」（L' + x.line + '）：' + x.why);
  for (const d of dup) problems.push('重复探针「' + d.probe + '」出现在 L' + d.lines.join(',L') + ' —— 后出现的检出力可能为 0（H-0081 形态）');
  for (const x of noref) problems.push('正例「' + x.name + '」（L' + x.line + '）' + x.why);
  return { tautology: taut, duplicates: dup, noRef: noref, problems };
}

/** 判定一个验收器 */
export function judge(name, src, selftestExit) {
  if (selftestExit !== 0) {
    return { name, state: 'FAIL', why: 'selftest 退出码 ' + selftestExit };
  }
  const a = analyzeSelftest(src);
  if (a.total === 0) {
    return { name, state: 'UNKNOWN', why: 'selftest 里找不到可识别的断言' };
  }
  if (a.positive === 0) {
    return {
      name, state: 'WARN',
      why: '只有 ' + a.negative + ' 条反例、0 条正例 —— 无法排除假红',
      ...a,
    };
  }
  // 【2026-11-16 加】标签对了不等于断言有效 —— 这里再查一次「断言质量」：
  // 恒真断言（T('x', true)）、重复探针（同一实参写两遍，H-0081 形态）、
  // 正例完全不引用被测模块。任一命中就把 PASS 降为 WARN。
  // 【2026-11-16 修】checkModuleRefs 会误伤「先赋值再断言」的正常写法
  // （`const r1 = reconcile(...)` 然后 `T('正例', r1.length === 0)`），
  // 实测把 27/42 误降级。所以只让「恒真断言」和「重复探针」触发降级，
  // 未引用模块仅作为诊断记录，不影响判定。
  // 【2026-11-16 如实降级】只有**恒真断言**触发降级（精确、零误报）。
  // 「重复探针」检测实测误报率过高：42 个验收器里降了 18 个，抽查 6 个全是误报
  // （夹具重复构造 mkAna(...)、字符串里的 fix(logging) 被当成调用、同行子表达式）。
  // 它无法把 H-0081 那种真造假与上述三种区分开，所以降为**仅诊断**，不参与判定。
  const q = checkAssertionQuality(extractAssertions(src), [], src);
  if (q.tautology.length) {
    return {
      name, state: 'WARN',
      why: '含恒真断言（' + q.tautology.length + ' 条）：'
        + q.tautology.slice(0, 2).map((x) => '「' + x.name + '」' + x.why).join('；'),
      quality: q.problems,
      ...a,
    };
  }
  return {
    name, state: 'PASS',
    why: a.positive + ' 正例 / ' + a.negative + ' 反例'
      + (q.duplicates.length ? '（诊断：' + q.duplicates.length + ' 组疑似重复探针，未计入判定）' : ''),
    ...a,
    diagnostics: q.duplicates.length ? q.duplicates : undefined,
  };
}

/**
 * 从源码里抽被测模块的导出符号名（用于检查正例有没有真的引用它）
 */
export function exportsOf(src) {
  const out = [];
  const res = [
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+const\s+([A-Za-z_$][\w$]*)/g,
    /export\s+class\s+([A-Za-z_$][\w$]*)/g,
  ];
  for (const re of res) {
    let m;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
  }
  return [...new Set(out)];
}

/** 自检 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  const onlyNeg = "  T('反例 · 应当失败的反例必须让它红', f() === 'red', '');";
  const a1 = analyzeSelftest(onlyNeg);
  T('反例 · 只有反例的 selftest 必须判 positive=0',
    a1.positive === 0 && a1.negative === 1, JSON.stringify(a1));

  const withPos = "  T('正例 · 应当通过的输入确实通过', f() === 'ok', '');\n" + onlyNeg;
  const a2 = analyzeSelftest(withPos);
  T('正例 · 有正例时必须数到 1 正 1 反',
    a2.positive === 1 && a2.negative === 1, JSON.stringify(a2));

  const j1 = judge('x', onlyNeg, 0);
  T('反例 · 只有反例 ⇒ WARN（不许判 PASS）', j1.state === 'WARN', j1.state);

  const j2 = judge('x', withPos, 0);
  T('正例 · 正反都有 ⇒ PASS', j2.state === 'PASS', j2.state);

  const j3 = judge('x', withPos, 1);
  T('反例 · selftest 跑不过 ⇒ FAIL（不许当 PASS）', j3.state === 'FAIL', j3.state);

  const empty = "  console.log('nothing');";
  // 新增写法：应当被认成正例
  const posStyle = "  T('合法假设 → 登记成功', ok1.ok === true, '');\n  T('反例 · 无基线 → 拒绝登记', !r1.ok, '');";
  const a3 = analyzeSelftest(posStyle);
  T('正例 · 「合法假设 → 登记成功」这种写法必须被认成正例',
    a3.positive === 1, JSON.stringify(a3));

  // 不许滥判：只是提到「成功」但没说输入合法的，不算正例
  const loose = "  T('反例 · 失败时不该说成功', x === false, '');";
  const a4 = analyzeSelftest(loose);
  T('反例 · 只在反例句里提到「成功」不许算正例',
    a4.positive === 0, JSON.stringify(a4));

  // 领域标签式正例
  const domainPos = "  T('A 类 · 缺陷态 exit 1 → 抓到', judge(dA, R(1), R(0)).caught === true, '');\n  T('反例 · 缺陷态 exit 0 → 必须判漏', judge(dA, R(0), R(0)).caught === false, '');";
  const a5 = analyzeSelftest(domainPos);
  T('正例 · 「A 类 · ... → 抓到」这种领域标签写法必须被认成正例',
    a5.positive === 1, JSON.stringify(a5));

  // 不许滥判：只说「判漏」的仍是反例
  const domainNeg = "  T('A 类 · 缺陷态 exit 0 → 必须判漏', judge(dA, R(0), R(0)).caught === false, '');";
  const a6 = analyzeSelftest(domainNeg);
  T('反例 · 「A 类 · ... → 必须判漏」不许算正例',
    a6.positive === 0, JSON.stringify(a6));

  const j4 = judge('x', empty, 0);
  T('反例 · 无断言 ⇒ UNKNOWN（不许当 PASS）', j4.state === 'UNKNOWN', j4.state);
  // ── 反刷分检查的自检（2026-11-16）────────────────────────
  // 缘起：我加 2 条「伴生断言」让自检 8→10，但独立验证方 v-h0081 证明检出能力
  // 增量恒为 0 —— 实参逐字符相同、谓词被已有断言严格蕴涵。当时本审计只数标签，抓不到。

  const tautSrc = [
    "  T('正例 · 真的假的正例', true, '');",
    "  T('反例 · 自反比较', x === x, '');",
  ].join('\n');
  const tauts = checkTautology(extractAssertions(tautSrc));
  T('反例 · 字面 true 必须被认成恒真断言',
    tauts.length >= 1 && tauts.some((x) => /true/.test(x.why)),
    JSON.stringify(tauts.map((x) => x.why)));
  T('反例 · 自反比较 x===x 必须被认成恒真',
    tauts.some((x) => /自反/.test(x.why)), JSON.stringify(tauts.map((x) => x.why)));

  const dupSrc = [
    "  T('反例 · 只在 projects 消失 → 报出', reconcile(EXP, ['a', 'b'], ['a', 'b', 'c']).length === 1, '');",
    "  T('正例 · 三方一致的反面：结果必须非空', reconcile(EXP, ['a', 'b'], ['a', 'b', 'c']).length > 0, '');",
  ].join('\n');
  const dups = checkDuplicateProbes(extractAssertions(dupSrc), dupSrc);
  T('反例 · 同一探针出现两次必须被认出（H-0081 就是这种假改进）',
    dups.length === 1 && /reconcile/.test(dups[0].probe), JSON.stringify(dups));

  const okSrc = [
    "  T('正例 · 甲', f(1).length === 2, '');",
    "  T('正例 · 乙', g(2).length === 3, '');",
  ].join('\n');
  T('正例 · 探针各不相同 ⇒ 不报重复',
    checkDuplicateProbes(extractAssertions(okSrc), okSrc).length === 0, '');

  const noRefSrc = "  T('正例 · 用的是外部常量', EXTERNAL_THING === 1, '');";
  const noRefs = checkModuleRefs(extractAssertions(noRefSrc), ['myFunc', 'myConst']);
  T('反例 · 正例没引用被测模块导出 ⇒ 报出',
    noRefs.length === 1, JSON.stringify(noRefs.map((x) => x.name)));

  const hasRefSrc = "  T('正例 · 真的调了被测函数', myFunc(1) === 2, '');";
  T('正例 · 正例引用了导出 ⇒ 不报',
    checkModuleRefs(extractAssertions(hasRefSrc), ['myFunc']).length === 0, '');


  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

const isMain = /[\\/]audit-false-red\.mjs$/.test(process.argv[1] || '');
if (!isMain) { /* imported */ }

if (isMain && process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  假失败审计 · 自检');
  console.log('  ' + '─'.repeat(70));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

if (isMain) {
  const dirs = ['tools', 'prototype/hermes-agents'];
  const files = [];
  const walk = (d) => {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, e.name);
      if (e.isDirectory()) { if (!/node_modules|dist|_tmp/.test(e.name)) walk(path.relative(REPO, p)); }
      else if (e.name.endsWith('.mjs')) files.push(p);
    }
  };
  dirs.forEach(walk);

  const results = [];
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (!/--selftest/.test(src)) continue;
    const rel = path.relative(REPO, f).replace(/\\/g, '/');
    let code = 0;
    try {
      execFileSync(NODE, [f, '--selftest'], { cwd: REPO, stdio: 'ignore', timeout: 300000 });
    } catch (e) { code = typeof e.status === 'number' ? e.status : 1; }
    results.push(judge(rel, src, code));
  }

  const by = { PASS: [], WARN: [], FAIL: [], UNKNOWN: [] };
  for (const r of results) by[r.state].push(r);

  console.log('');
  console.log('  假失败审计 —— 检验验收器会不会把真实证据判成没证据');
  console.log('  ' + '='.repeat(78));
  console.log('  验收器数: ' + results.length);
  console.log('    PASS    有正有反：' + by.PASS.length);
  console.log('    WARN    只有反例（无法排除假红）：' + by.WARN.length);
  console.log('    FAIL    selftest 跑不过：' + by.FAIL.length);
  console.log('    UNKNOWN 判断不了：' + by.UNKNOWN.length);
  console.log('');

  if (by.FAIL.length) {
    console.log('  ❌ selftest 失败:');
    for (const r of by.FAIL) console.log('      ' + r.name + '  (' + r.why + ')');
    console.log('');
  }
  if (by.WARN.length) {
    console.log('  ⚠ 只有反例、无正例（可能假红）:');
    for (const r of by.WARN) console.log('      ' + r.name + '  (' + r.why + ')');
    console.log('');
  }

  const healthy = by.FAIL.length === 0;
  console.log('  ' + (healthy ? '✅ 没有验收器跑不过' : '❌ 有验收器跑不过'));
  console.log('  ' + (by.WARN.length === 0
    ? '✅ 全部验收器都有正例，可以排除假红'
    : '⚠ ' + by.WARN.length + ' 个验收器只有反例 —— 它们可能把真实证据判成没证据'));
  console.log('');

  const out = path.join(REPO, 'evidence/evolve/false-red-audit.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    at: new Date().toISOString(),
    total: results.length,
    pass: by.PASS.length, warn: by.WARN.length, fail: by.FAIL.length, unknown: by.UNKNOWN.length,
    rows: results,
  }, null, 2) + '\n', 'utf8');
  console.log('  → ' + path.relative(REPO, out));
  console.log('');

  process.exit(by.FAIL.length ? 1 : 0);
}
