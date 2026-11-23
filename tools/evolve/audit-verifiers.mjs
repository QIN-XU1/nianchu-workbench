#!/usr/bin/env node
/**
 * T2 审计 —— **所有**验收器是否都经过反例检验
 *
 * ── T2 的判据 ────────────────────────────────────────────
 *   「所有验收器经过反例检验（每条的『应当失败的反例』都能让它红），
 *     fpr=0；度量本身可复算（两次结果一致）」
 *
 * 拆成三个可判定成分：
 *   ① 每个验收器都有 `--selftest`
 *   ② selftest 里有反例（断言「应当失败的情形确实失败」），不是只测正例
 *   ③ selftest 能通过
 *
 * ── 为什么反例是硬要求 ────────────────────────────────────
 * 一个只会说「通过」的检查是装饰。
 * 本项目已经实证过三次（都写在 git 历史里）：
 *   · audit-coverage 没有退出码 —— 对 22/22 和 0/22 返回同样的 0
 *   · audit-matrix-honesty 跳过证据清空的行 —— 最典型的假绿当没看见
 *   · size-guard 用取整 kb 判定 —— 漏网约 50 字节
 * 这三件**都是「检查存在但不管用」**，而且都是靠「构造应当失败的情形」才发现。
 *
 * 用法：node tools/evolve/audit-verifiers.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');

/**
 * 分类：这个验收器还在「验证链路」上吗？
 *
 * ── 为什么必须分类，而不是把 43 个全当同等要求 ────────────────
 * 43 个脚本里混着两种东西：
 *   · **在链路上**：被 verify-goal / L4 度量 / 审计器实际调用 —— 它们是门禁，缺反例就是假门禁
 *   · **历史脚本**：早期探索时的一次性验证（verify-s0 / verify-workbench3-7 / verify-e2e …），
 *     现在没有任何东西调用它们
 *
 * 对第二类要求「必须有反例」是错配的 —— 它们已经退役。
 * 但也**不能删掉了事**（那是在隐藏历史），正确做法是**如实标注为 dormant**，
 * 并在报告里同时给出两个数字：链路内覆盖率 + 历史脚本数。
 *
 * 判据（机械可查）：脚本名是否出现在这些「调用方」的源码里。
 */
const CHAIN_CALLERS = [
  'prototype/hermes-agents/verify-goal.mjs',
  'prototype/agent-ui/verify-evolve.mjs',
  'tools/evolve/audit-claims.mjs',
  'tools/evolve/measure-verifier-efficacy.mjs',
  'tools/evolve/measure-real-recall.mjs',
  'tools/benchmark/r5-regression.mjs',
];

function buildChainSet(scripts) {
  const callersText = CHAIN_CALLERS
    .filter((p) => fs.existsSync(path.join(REPO, p)))
    .map((p) => fs.readFileSync(path.join(REPO, p), 'utf8'))
    .join('\n');

  const active = new Set();
  for (const s of scripts) {
    const base = s.split('/').pop();
    const others = callersText.split(base).length - 1;
    if (others > 0) active.add(s);
  }
  return active;
}

/**
 * 链路基线 —— 防「删引用即降级」的游戏
 *
 * 【2026-11-15 · 第二轮复审 A7 指出的设计缺陷】
 * buildChainSet 的判据是「脚本名出现在调用方源码里」。
 * 那么把坏掉的验收器从所有调用方**删掉**，它就自动变成「历史」，
 * 不再计入 T2 缺口 —— **单向可游戏**。
 *
 * 缓解：维护一份基线快照 evidence/evolve/chain-baseline.json。
 * 曾经在链路里、这次不在的 → 报「降级」并要求解释（不是静默当历史）。
 *
 * 注意这不解决根本问题（基线文件本身也能被改），
 * 但它把「静默降级」变成「留痕的降级」—— 后者会在 git diff 里可见。
 */
const CHAIN_BASELINE = path.join(REPO, 'evidence/evolve/chain-baseline.json');

function loadChainBaseline() {
  if (!fs.existsSync(CHAIN_BASELINE)) return null;
  try { return JSON.parse(fs.readFileSync(CHAIN_BASELINE, 'utf8')); } catch { return null; }
}

function saveChainBaseline(set) {
  fs.mkdirSync(path.dirname(CHAIN_BASELINE), { recursive: true });
  fs.writeFileSync(CHAIN_BASELINE, JSON.stringify({
    what: '验证链路基线（曾在链路里的验收器）',
    at: new Date().toISOString(),
    verifiers: [...set].sort(),
  }, null, 2) + '\n', 'utf8');
}

/** 什么算「验收器」：文件名以 verify-/audit-/measure-/guard 开头或含这些词 */
const VERIFIER_RE = /^(verify-|audit-|measure-|.*-guard\.mjs$|.*guard\.mjs$)/;

/** 扫描目录 */
const DIRS = ['prototype/agent-ui', 'prototype/hermes-agents', 'tools/evolve', 'tools/quality',
  'tools/benchmark', 'tools/cost', 'tools/memory', 'tools/context', 'tools/net', 'tools/mcp',
  'tools/schedule', 'tools/state'];

function collect() {
  const out = [];
  for (const d of DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.mjs')) continue;
      if (!VERIFIER_RE.test(e.name)) continue;
      out.push(path.posix.join(d, e.name));
    }
  }
  return out.sort();
}

function tryRun(script, arg) {
  try {
    const args = [path.join(REPO, script)];
    if (arg) args.push(arg);
    const out = execFileSync(process.execPath, args, {
      cwd: REPO, encoding: 'utf8', timeout: 900000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, code: 0, out };
  } catch (e) {
    return { ok: false, code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

/**
 * 该脚本有没有**自己的** `--selftest` 分支
 *
 * 【2026-11-15 修】第一版只判「源码里出现 --selftest 字样」—— 太宽。
 * 实测 9 个脚本里有 7 个是「调用**别的**脚本的 --selftest」，自己没有自检：
 *   verify-evolve.mjs:41  run(['tools/evolve/evolve.mjs', '--selftest'])
 *   verify-cost.mjs 等同理
 * 后果：本审计对它们跑 `X.mjs --selftest`，参数被忽略、跑的是**全量验证器**，
 * 既慢（有些要跑分钟级度量）又不是在测「自检」。
 *
 * 正确判据：源码里必须**读取** process.argv 判断 --selftest，才算自己有。
 */
export function hasSelfTestFlag(script) {
  const text = fs.readFileSync(path.join(REPO, script), 'utf8');
  // 常见写法：
  //   process.argv.includes('--selftest')
  //   const SELFTEST = process.argv.includes('--selftest')
  //   process.argv[2] === '--selftest'
  //   process.argv.includes('--selftest') 出现在 if 条件里
  return /process\.argv\s*(?:\.includes\(|\.indexOf\(|\[\s*\d+\s*\]\s*===)/.test(text)
    && /--selftest/.test(text)
    && /(?:includes|indexOf)\(\s*['"]--selftest['"]\s*\)|\[\s*\d+\s*\]\s*===?\s*['"]--selftest['"]/.test(text);
}

/** 解析结论 */
export function parseConclusion(out) {
  const m1 = /结论:\s*✓\s*(\d+)\/(\d+)/.exec(out);
  if (m1) return { ok: m1[1] === m1[2], pass: Number(m1[1]), total: Number(m1[2]) };
  const m2 = /自检结论：\s*(✓|✗)\s*(.+)/.exec(out);
  if (m2) {
    const lines = out.split('\n').filter((l) => /^\s*[✓✗]/.test(l));
    const bad = lines.filter((l) => /^\s*✗/.test(l)).length;
    return { ok: m2[1] === '✓' && bad === 0, pass: lines.length - bad, total: lines.length };
  }
  return null;
}

/** 数反例 */
const NEG_RE = /反例|应当失败|拒绝|→ ?FAIL|→ ?UNKNOWN|不该|不许|挡住|抓不到|漏|不许退出 0|假绿|不报|必须红|被判|UNKNOWN/;
export function countCases(out) {
  const lines = out.split('\n').filter((l) => /^\s*[✓✗]/.test(l));
  return { total: lines.length, negative: lines.filter((l) => NEG_RE.test(l)).length };
}

/**
 * 自检 —— 反例钉住两类真实 bug
 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  // ── 反例 1（真实 bug）：只「调用别人的 --selftest」不算自己有 ──
  // 历史 bug：判据是「源码含 --selftest 字符串」，于是 verify-evolve.mjs
  // （它只是 run(['tools/evolve/evolve.mjs','--selftest'])）被当成「自己有自检」，
  // 审计对它跑 X.mjs --selftest，参数被忽略、跑的是全量验证器（十几分钟）。
  const fakeCaller = path.join(REPO, 'tools/evolve/_av_selftest_fake_caller.mjs');
  fs.writeFileSync(fakeCaller, [
    "import { execFileSync } from 'node:child_process';",
    "execFileSync(process.execPath, ['other.mjs', '--selftest']);",
    '',
  ].join('\n'), 'utf8');
  try {
    T('反例 · 只调用别人的 --selftest → 不算自己有',
      hasSelfTestFlag('tools/evolve/_av_selftest_fake_caller.mjs') === false,
      'hasSelfTestFlag 返回了 true');
  } finally {
    if (fs.existsSync(fakeCaller)) fs.unlinkSync(fakeCaller);
  }

  // ── 正例 1：真的读 process.argv 判断 → 算自己有 ──
  const realSelftest = path.join(REPO, 'tools/evolve/_av_selftest_real.mjs');
  fs.writeFileSync(realSelftest, [
    "if (process.argv.includes('--selftest')) { console.log('x'); process.exit(0); }",
    '',
  ].join('\n'), 'utf8');
  try {
    T('正例 · 真的读 argv 判断 --selftest → 算自己有',
      hasSelfTestFlag('tools/evolve/_av_selftest_real.mjs') === true,
      'hasSelfTestFlag 返回了 false');
  } finally {
    if (fs.existsSync(realSelftest)) fs.unlinkSync(realSelftest);
  }

  // ── 正例 2/3：两种结论格式都能解析 ──
  const c1 = parseConclusion('  结论: ✓ 10/10\n');
  T('正例 · 解析「结论: ✓ N/N」', !!c1 && c1.ok && c1.pass === 10 && c1.total === 10, JSON.stringify(c1));
  const c2 = parseConclusion('  ✓ a\n  ✓ b\n  自检结论：✓ 四态机制成立\n');
  T('正例 · 解析「自检结论：✓」', !!c2 && c2.ok && c2.pass === 2, JSON.stringify(c2));

  // ── 反例 2/3：结论不通过必须 ok=false ──
  const c3 = parseConclusion('  结论: ✗ 3/5\n');
  T('反例 · 结论 ✗ → ok 必须为 false', !c3 || c3.ok === false, JSON.stringify(c3));
  const c4 = parseConclusion('  ✓ a\n  ✗ b\n  自检结论：✗ 有错\n');
  T('反例 · 自检结论 ✗ → ok 必须为 false', !c4 || c4.ok === false, JSON.stringify(c4));

  // ── 反例 4：没有结论行必须返回 null（不许猜通过）──
  T('反例 · 没有结论行 → 返回 null', parseConclusion('  something else\n') === null, '不是 null');

  // ── 正例 4：反例计数能数出来 ──
  const cnt = countCases('  ✓ 反例 · 应当拒绝\n  ✓ 正例 · 正常\n');
  T('正例 · 反例计数 ≥1', cnt.negative >= 1 && cnt.total === 2, JSON.stringify(cnt));

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  T2 审计器 · 自检（4 正例 + 4 反例）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

const scripts = collect();
const chainSet = buildChainSet(scripts);

// ── 链路基线对账：曾经在链路、这次不在的，必须显式说明 ──
const priorBaseline = loadChainBaseline();
const downgraded = priorBaseline
  ? (priorBaseline.verifiers || []).filter((v) => scripts.includes(v) && !chainSet.has(v))
  : [];
// 首次运行写基线；之后只在「没有降级」时更新（有降级时不更新，避免把缺口洗白）
if (!priorBaseline || downgraded.length === 0) {
  saveChainBaseline(chainSet);
}

/**
 * 突变检验结果（强证据）
 *
 * 【为什么要读这个】本审计判断「有没有反例」原来靠正则数断言文本里的关键词
 * （「反例」「不许」「拒绝」…）—— 那是在数关键词，不是验证反例真的有效。
 *
 * 真正能证明「反例是真的」的是突变检验（audit-selftest-reality.mjs）：
 *   把被测代码的核心判据打瘸 → 自检必须变红。
 *
 * 所以这里把突变结果作为**强证据**接进来：
 *   ✓ 突变检验通过 = 反例确实有效（强）
 *   ~ 只有关键词 = 未经突变检验（弱，只能算「声称有」）
 */
let mutationMap = new Map();
{
  const p = path.join(REPO, 'evidence/evolve/selftest-reality.json');
  if (fs.existsSync(p)) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const r of j.results || []) {
        if (r.state === 'REAL') mutationMap.set(r.script, 'REAL');
        else if (r.state === 'DECORATIVE') mutationMap.set(r.script, 'DECORATIVE');
      }
    } catch { /* 读不到就当没有强证据 */ }
  }
}

console.log('');
console.log('  T2 审计 —— 验收器是否都有反例检验（按「是否在验证链路上」分类）');
console.log('  ' + '='.repeat(80));
console.log('  扫到 ' + scripts.length + ' 个验收器 · 其中在验证链路上 ' + chainSet.size + ' 个');
console.log('  突变检验（强证据）覆盖：' + mutationMap.size + ' 个'
  + (mutationMap.size ? '' : '  ← 先跑 audit-selftest-reality.mjs'));
if (priorBaseline) {
  console.log('  链路基线对账：基线 ' + (priorBaseline.verifiers || []).length + ' 个'
    + (downgraded.length
      ? '  ✗ **降级 ' + downgraded.length + ' 个**（曾被调用，这次不在链路里）：' + downgraded.join('、')
      : '  ✓ 无降级'));
}
console.log('');

const rows = [];
for (const s of scripts) {
  const inChain = chainSet.has(s);
  const hasFlag = hasSelfTestFlag(s);
  const mutation = mutationMap.get(s) || null;
  let res = { hasFlag, ran: false, concl: null, cases: { total: 0, negative: 0 }, detail: '' };

  if (hasFlag) {
    const r = tryRun(s, '--selftest');
    const concl = parseConclusion(r.out);
    const cases = countCases(r.out);
    res = {
      hasFlag, ran: true, concl, cases, code: r.code,
      detail: concl ? concl.pass + '/' + concl.total : '无结论行',
    };
  }

  // 强判据：突变检验通过；弱判据：有反例关键词且自检通过
  const weakOk = hasFlag && res.ran && res.concl && res.concl.ok && res.cases.negative > 0;
  const strongOk = mutation === 'REAL';
  const ok = strongOk || (weakOk && mutation === null);   // 有突变结果就只看突变
  rows.push({ script: s, inChain, mutation, ...res, weakOk, strongOk, pass: ok });
}

// ── 分组：链路内 vs 历史 ──
const chainRows = rows.filter((r) => r.inChain);
const dormantRows = rows.filter((r) => !r.inChain);

const chainGood = chainRows.filter((r) => r.pass);
const chainBad = chainRows.filter((r) => !r.pass);
const dormantGood = dormantRows.filter((r) => r.pass);

function whyOf(r) {
  if (!r.hasFlag) return '**没有 --selftest**';
  if (!r.ran) return '跑不起来';
  if (!r.concl) return '无结论行';
  if (!r.concl.ok) return r.detail + ' 未通过';
  return '**没有反例**（' + r.cases.total + ' 条断言全是正例）';
}

/** 证据强度标记 */
function strengthOf(r) {
  if (r.mutation === 'REAL') return '【强·突变检验通过】';
  if (r.mutation === 'DECORATIVE') return '【装饰·打瘸仍绿】';
  if (r.weakOk) return '【弱·仅有关键词】';
  return '';
}

console.log('  ① 验证链路上（' + chainRows.length + ' 个）—— 这些是门禁，必须有反例');
console.log('');
if (chainGood.length) {
  console.log('     ✓ 有反例且通过（' + chainGood.length + '）');
  for (const r of chainGood) {
    console.log('        ' + strengthOf(r).padEnd(18)
      + r.script.replace(/^(prototype|tools)\//, '').padEnd(42)
      + r.detail.padEnd(9) + '反例 ' + r.cases.negative + '/' + r.cases.total);
  }
}
if (chainBad.length) {
  console.log('');
  console.log('     ✗ 缺反例（' + chainBad.length + '）');
  for (const r of chainBad) console.log('        ' + r.script.padEnd(50) + whyOf(r));
}

console.log('');
console.log('  ② 历史/休眠脚本（' + dormantRows.length
  + ' 个）—— 没有任何东西调用它们，不构成本轮门禁要求，但如实列出');
if (dormantGood.length) {
  console.log('     其中有反例的 ' + dormantGood.length + ' 个：'
    + dormantGood.map((r) => r.script.split('/').pop()).join('、'));
}
console.log('     （不删：删了是在隐藏历史。它们不在验证链路上，所以不算门禁缺口）');

// ── 四态：只看链路内 ──
const pass = chainGood.length;
// A7 缓解：链路降级也算问题 —— 不许「删引用就变历史」
const state = !chainRows.length ? 'UNKNOWN'
  : (chainBad.length || downgraded.length) ? (pass === 0 ? 'FAIL' : 'WARN')
    : 'PASS';

console.log('');
console.log('  ' + '─'.repeat(80));
console.log('  链路内 有反例 ' + pass + '/' + chainRows.length
  + (chainBad.length ? '  缺 ' + chainBad.length : '  ✓ 全覆盖'));

const OUT = {
  what: 'T2 审计：验收器的反例覆盖（链路内 / 历史分离）',
  at: new Date().toISOString(),
  state,
  chain: { pass, total: chainRows.length, missing: chainBad.map((r) => ({ script: r.script, reason: whyOf(r) })), downgraded },
  dormant: { total: dormantRows.length, withCounterExamples: dormantGood.map((r) => r.script) },
  rows,
};
const outPath = path.join(REPO, 'evidence/evolve/verifiers-audit.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(OUT, null, 2) + '\n', 'utf8');

console.log('');
console.log('  四态: ' + state + ' —— ' + (
  state === 'PASS' ? '链路内 ' + chainRows.length + ' 个验收器全部有反例检验'
    : state === 'FAIL' ? '链路内验收器一个都没有反例'
      : '链路内 ' + chainBad.length + ' 个验收器缺反例（机制在位，覆盖不全）'
));
console.log('  → ' + path.relative(REPO, outPath));
console.log('');

if (process.argv.includes('--json')) console.log(JSON.stringify(OUT, null, 2));
process.exit(state === 'PASS' ? 0 : state === 'WARN' ? 3 : state === 'FAIL' ? 1 : 2);
