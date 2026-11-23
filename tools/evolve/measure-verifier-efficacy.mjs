#!/usr/bin/env node
// syntax-guard:allow-bad-words  (contains intentional fault fixture)
/**
 * L4 · 度量器：验收器发现真问题的能力
 *
 * ── 指标定义（必须可复算，所以写死）────────────────────────────
 *   召回率 recall  = 注入的已知故障中，被验收器抓到（exit != 0）的比例
 *   误报率 fpr     = 干净状态下，报错的验收器数 / 被检查的验收器数
 *   可复算性       = 同一轮跑两次，recall 必须完全一致（不一致 ⇒ UNKNOWN）
 *
 * ── 为什么这个指标有意义 ────────────────────────────────────
 * 22 个参照系统里 7 份报告都提到「结论不可独立验证」。
 * 而「验收器能不能抓到问题」本身，几乎没有项目去量 —— 它们只是**假定**自己的检查有效。
 *
 * 本轮实测的动机：我们自己的 3 个验收器被一次 `t`→`o` 替换损坏（dda2fbed），
 * **没有任何检查报「你的脚本坏了」** —— R8 报的是「界面层判不了」。
 * 这就是「验收器有效吗」这个问题必须被量化的原因。
 *
 * ── 四态 ──────────────────────────────────────────────────
 *   PASS    recall = 1.0 且 fpr = 0 且两次一致
 *   WARN    recall < 1.0 或 fpr > 0（度量成功，但结果不理想）
 *   FAIL    两次结果不一致（度量本身不可信）
 *   UNKNOWN 无法注入任何故障（环境问题）
 *
 * 用法：
 *   node tools/evolve/measure-verifier-efficacy.mjs
 *   node tools/evolve/measure-verifier-efficacy.mjs --runs 2
 *   node tools/evolve/measure-verifier-efficacy.mjs --json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { summarize, selfTest as summarizeSelfTest } from './measure-summary.mjs';
import { checkAll as checkFaultAnchors } from './check-fault-anchors.mjs';
import { requireGate } from '../quality/inject-gate.mjs';

// 注入 8 个文件，不许并发（理由见 inject-gate.mjs）
requireGate('measure-verifier-efficacy', '度量');

const REPO = path.resolve(import.meta.dirname, '../..');
const FAULTS = JSON.parse(fs.readFileSync(path.join(REPO, 'tools/evolve/faults.json'), 'utf8'));

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  L4 度量器 · 自检（校验故障目录 + 汇总口径集成，7 条反例）');
  console.log('  ' + '-'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

/**
 * 自检 —— 校验测量自己的「数据」是不是完好
 *
 * 度量器的可信度取决于两样东西：**故障目录**和**汇总口径**。
 * 汇总口径已被 measure-summary 的 8 条自检覆盖（这里再跑一遍做集成确认）；
 * 故障目录没有被任何东西校验过 —— 这份自检补上。
 *
 * 【为什么必须校验故障目录】
 * 目录里一条写错（缺 expected / id 重复 / inject 缺 kind），
 * 后果不是报错，而是**静默少测一条**，recall 分母变小、数字变好看。
 * 这正是「度量工具自己不自洽，却拿它去量别人」的经典假绿。
 */
export function selfTest(FAULTS_IN = FAULTS) {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  // ── 正例：判定核心必须能**正确识别抓到**，不只是「不许漏判」──────────
  // 为什么需要它：上面 7 条全是对「故障目录配置」的校验。
  // 如果 judge() 永远返回 { caught:false }，那 7 条照样全绿 ——
  // 但整个工具就变成了「永远报告抓到 0 条」的废器。
  // 必须显式断言 judge 在**该抓到时确实抓到**。
  const fNoOut = { id: 'p1', expected: 'exit 1' };
  T('正例 · 判定核心：缺陷态 exit 1（无 expectOutput）⇒ caught=true',
    judge(fNoOut, { code: 1, out: '' }).caught === true,
    JSON.stringify(judge(fNoOut, { code: 1, out: '' })));

  const fOut = { id: 'p2', expected: 'exit 1', expectOutput: '损坏词' };
  T('正例 · 判定核心：exit 1 且输出含期望串 ⇒ caught=true',
    judge(fOut, { code: 1, out: '... 损坏词: imporo ...' }).caught === true,
    JSON.stringify(judge(fOut, { code: 1, out: '... 损坏词: imporo ...' })));

  // ── 反例：不该抓到时不许误判 ──
  T('反例 · 判定核心：缺陷态 exit 0 ⇒ caught=false（没报就是没抓到）',
    judge(fNoOut, { code: 0, out: '一切正常' }).caught === false,
    JSON.stringify(judge(fNoOut, { code: 0, out: '一切正常' })));

  T('反例 · 判定核心：exit 1 但输出缺期望串 ⇒ 不算抓到（结构性红≠抓到）',
    judge(fOut, { code: 1, out: 'SyntaxError: something else' }).caught === false,
    JSON.stringify(judge(fOut, { code: 1, out: 'SyntaxError: something else' })));

  T('反例 · 判定核心：exit 2 也算报错（不许只认 exit 1）',
    judge(fNoOut, { code: 2, out: '' }).caught === true,
    JSON.stringify(judge(fNoOut, { code: 2, out: '' })));

  const faults = (FAULTS_IN && FAULTS_IN.faults) || [];

  // ── 反例 1：至少要有 1 条故障（空目录 = 分母 0 = 什么都测不了）──
  T('反例 · 故障目录不能为空', faults.length > 0, 'faults.length=' + faults.length);

  // ── 反例 2：id 不许重复（重复会让两条互相顶替，静默少测一条）──
  const ids = faults.map((f) => f.id);
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  T('反例 · 故障 id 不许重复', dup.length === 0, '重复：' + [...new Set(dup)].join(','));

  // ── 反例 3：每条必须有 target / expected / name / inject ──
  const missing = [];
  for (const f of faults) {
    for (const k of ['id', 'target', 'expected', 'name', 'inject']) {
      if (!f[k]) missing.push((f.id || '?') + ' 缺 ' + k);
    }
    if (f.inject && !f.inject.kind) missing.push((f.id || '?') + ' 缺 inject.kind');
  }
  T('反例 · 每条故障必须字段齐全', missing.length === 0, missing.slice(0, 4).join(' / '));

  // ── 反例 4：expected 必须可判定（含 exit / 包含 / 出现 这类可机械比较的词）──
  const vague = faults.filter((f) => f.expected && !/exit|包含|出现|不能|必须|==|!=|>|</.test(String(f.expected)));
  T('反例 · expected 必须可机械判定', vague.length === 0,
    '太笼统：' + vague.map((f) => f.id + '=' + f.expected).slice(0, 3).join(' / '));

  // ── 反例 5：target 指向的文件必须存在（除非该故障就是造新文件）──
  const CREATES = new Set(['createFile', 'createExactSizeFile']);
  const ghost = faults.filter((f) => {
    if (f.inject && CREATES.has(f.inject.kind)) return false;
    // target 可能是「文件 + 参数」（如 `verify-goal.mjs --only R2`），只取第一段当路径
    const tf = String(f.target || '').trim().split(/\s+/)[0];
    if (tf && !fs.existsSync(path.join(REPO, tf))) return true;
    return false;
  });
  T('反例 · target 指向的文件必须存在', ghost.length === 0,
    '不存在：' + ghost.map((f) => f.id + '→' + f.target).slice(0, 3).join(' / '));

  // ── 反例 6（集成）：汇总口径的 8 条自检必须仍然通过 ──
  let sumOk = false, sumDetail = '';
  try {
    const s = summarizeSelfTest();
    sumOk = s.ok;
    sumDetail = s.pass + '/' + s.total;
  } catch (e) { sumDetail = String(e.message).slice(0, 50); }
  T('反例 · 汇总口径自检必须通过（集成）', sumOk, sumDetail);

  // ── 反例 7：未知 inject.kind 不许静默放过 ──
  const KNOWN = new Set(['createFile', 'appendLine', 'replaceInFile', 'createExactSizeFile', 'editJson']);
  const unknown = faults.filter((f) => f.inject && f.inject.kind && !KNOWN.has(f.inject.kind));
  T('反例 · 未知 inject.kind 不许静默放过', unknown.length === 0,
    unknown.map((f) => f.id + ':' + f.inject.kind).join(','));

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

/** 跑一个目标，返回 { code, out } */
function runTarget(target, cwd) {
  const m = target.match(/^(\S+)(?:\s+(.*))?$/);
  const script = m[1];
  const extra = m[2] ? m[2].split(/\s+/).filter(Boolean) : [];
  try {
    const out = execFileSync(process.execPath, [path.join(REPO, script), ...extra], {
      cwd: cwd ? path.join(REPO, cwd) : REPO,
      encoding: 'utf8',
      timeout: 300000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

/**
 * 判定一条故障是否被「抓到」
 *
 * 两档判据：
 *   1. 退出码非 0（基本要求）
 *   2. 若有 expectOutput ⇒ 输出里必须出现该证据串
 *
 * 为什么需要第 2 条：有的验收器因**结构性原因**永久非 0
 * （实测 F04：typography:audit 缺 Rust 侧 owner 文件，永远 exit 1）。
 * 只看退出码的话，「抓到」是假的 —— 它本来就在报错。
 * 首轮度量就是这么发现这个问题的。
 */
export function judge(fault, r) {
  if (r.code === 0) return { caught: false, why: 'exit 0（没报）' };
  if (fault.expectOutput) {
    const hit = r.out.includes(fault.expectOutput);
    return hit
      ? { caught: true, why: 'exit ' + r.code + ' + 输出含「' + fault.expectOutput + '」' }
      : { caught: false, why: 'exit ' + r.code + ' 但输出缺「' + fault.expectOutput + '」（结构性失败，非本次故障）' };
  }
  return { caught: true, why: 'exit ' + r.code };
}

/** 注入一个故障，返回恢复函数 */
function inject(fault) {
  const spec = fault.inject;
  const abs = path.join(REPO, spec.path);

  if (spec.kind === 'createFile') {
    const had = fs.existsSync(abs);
    const old = had ? fs.readFileSync(abs) : null;
    const body = spec.repeat ? spec.content.repeat(spec.repeat) : spec.content;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
    return () => { if (had) fs.writeFileSync(abs, old); else if (fs.existsSync(abs)) fs.unlinkSync(abs); };
  }

  if (spec.kind === 'appendLine') {
    const had = fs.existsSync(abs);
    const old = had ? fs.readFileSync(abs) : null;
    fs.appendFileSync(abs, spec.line, 'utf8');
    return () => { if (had) fs.writeFileSync(abs, old); else if (fs.existsSync(abs)) fs.unlinkSync(abs); };
  }

  if (spec.kind === 'replaceInFile') {
    const old = fs.readFileSync(abs, 'utf8');
    if (!old.includes(spec.find)) throw new Error('找不到锚点：' + spec.find);
    fs.writeFileSync(abs, old.split(spec.find).join(spec.replace), 'utf8');
    return () => fs.writeFileSync(abs, old);
  }

  if (spec.kind === 'createExactSizeFile') {
    // 恰好 N 字节的文件 —— 用来测边界判据是 < 还是 <=
    const had = fs.existsSync(abs);
    const old = had ? fs.readFileSync(abs) : null;
    const header = '// 边界故障注入\n';
    const pad = Math.max(0, spec.bytes - Buffer.byteLength(header, 'utf8'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, header + 'x'.repeat(pad), 'utf8');
    const actual = fs.statSync(abs).size;
    if (actual !== spec.bytes) throw new Error('注入尺寸不符：期望 ' + spec.bytes + ' 实际 ' + actual);
    return () => { if (had) fs.writeFileSync(abs, old); else if (fs.existsSync(abs)) fs.unlinkSync(abs); };
  }

  if (spec.kind === 'editJson') {
    const old = fs.readFileSync(abs, 'utf8');
    const j = JSON.parse(old);
    const op = spec.mutate;
    const allDims = () => j.dimensions.flatMap((g) => g.items);

    if (op.startsWith('emptyFirstArrayField:')) {
      const field = op.split(':')[1];
      const victim = Object.keys(j.byId).find((k) => Array.isArray(j.byId[k][field]) && j.byId[k][field].length > 0);
      if (!victim) throw new Error('找不到含 ' + field + ' 的项目');
      j.byId[victim][field] = [];
    } else if (op === 'setFirstUsEvidenceToBorrowed') {
      const dim = allDims().find((d) => d.us[0] === '有');
      if (!dim) throw new Error('找不到状态为「有」的维度');
      dim.us = ['有', 'hermes 能做到这个，实测可用。'];
    } else if (op === 'emptyFirstUsEvidence') {
      // 证据整条清空，但状态仍写「有」
      const dim = allDims().find((d) => d.us[0] === '有' && d.us.length > 1);
      if (!dim) throw new Error('找不到有证据的「有」维度');
      dim.us = ['有'];
      dim.__faultNote = '证据被清空但状态仍声称「有」';
    } else if (op === 'dropDimensions') {
      if (Array.isArray(j.dimensions)) j.dimensions = j.dimensions.slice(0, 1);
    } else if (op === 'dropOneProject') {
      const keys = Object.keys(j.byId);
      if (keys.length < 2) throw new Error('项目太少');
      delete j.byId[keys[0]];
    } else if (op === 'duplicateOneDim') {
      // 维度总数不变，但有一条重复 ⇒ 独立维度少一个
      const g = j.dimensions.find((x) => Array.isArray(x.items) && x.items.length > 1);
      if (!g) throw new Error('找不到可复制的维度组');
      const dup = JSON.parse(JSON.stringify(g.items[g.items.length - 1]));
      dup.id = g.items[0].id;          // 复用第一个的 id ⇒ 重复
      dup.name = g.items[0].name;
      g.items[g.items.length - 1] = dup;
    } else {
      throw new Error('未知 mutate: ' + op);
    }

    fs.writeFileSync(abs, JSON.stringify(j, null, 2) + '\n', 'utf8');
    return () => fs.writeFileSync(abs, old);
  }

  throw new Error('未知注入类型: ' + spec.kind);
}

/** 一轮测量：返回每个故障的命中情况 */
function oneRound(gitDirty) {
  const results = [];

  for (const f of FAULTS.faults) {
    // 需要干净树的用例在脏树上**不能测量** ——
    // 树本来就脏，R8 必然红，会被算成「抓到」，但那是假通过。
    // 按四态纪律判 UNKNOWN，并从 recall 分母里排除。
    if (f.dependsOnCleanGit && gitDirty) {
      results.push({
        id: f.id, name: f.name, target: f.target,
        injected: false, caught: null, unknown: true,
        why: '树不干净 ⇒ 无法有效测量（R8 本来就红，会假通过）',
        exit: null, err: '',
      });
      continue;
    }

    let restore = () => {};
    let injected = false;
    let r = { code: null, out: '' }, err = '', verdict = { caught: false, why: '' };

    try {
      restore = inject(f);
      injected = true;
      r = runTarget(f.target, f.cwd);
      verdict = judge(f, r);
    } catch (e) {
      err = String(e.message).slice(0, 80);
    } finally {
      try { restore(); } catch { /* 恢复失败在下游校验 */ }
    }

    results.push({
      id: f.id, name: f.name, target: f.target,
      injected, caught: verdict.caught, why: verdict.why,
      exit: r.code, err,
    });
  }

  return results;
}

const RUNS = (() => {
  const i = process.argv.indexOf('--runs');
  return i > 0 ? Math.max(1, Math.min(5, Number(process.argv[i + 1]) || 2)) : 2;
})();

// ── 飞行前检查 ───────────────────────────────────────────────
//
// 【为什么需要】2026-11-15 实测：一次被中断的运行把注入文件
// `prototype/agent-ui/_fault_big.mjs`（146.9KB）留在了磁盘上，
// 结果下一轮度量的**基线**里 size-guard 报「超红线」exit=1，
// 被误判成「验收器误报」—— 实际是**度量工具自己没清干净**。
//
// 所以：开工前必须确认没有残留的注入产物；有就报错，不静默继续。
const PREFLIGHT = (() => {
  const leftovers = [];
  for (const f of FAULTS.faults) {
    const spec = f.inject;
    if (spec.kind === 'createFile' || spec.kind === 'appendLine' || spec.kind === 'createExactSizeFile') {
      // 注入文件是我们自己命名的探针，正常状态下不该存在
      if (/_fault_|fault-probe|_selftest_/.test(spec.path) && fs.existsSync(path.join(REPO, spec.path))) {
        leftovers.push(spec.path);
      }
    }
  }
  return leftovers;
})();

if (PREFLIGHT.length && !process.argv.includes('--allow-dirty-probes')) {
  console.log('');
  console.log('  ❌ 飞行前检查失败：发现上次运行的残留注入产物');
  console.log('  ' + '─'.repeat(76));
  for (const p of PREFLIGHT) console.log('      ' + p + '  (' + Math.round(fs.statSync(path.join(REPO, p)).size / 1024) + 'KB)');
  console.log('');
  console.log('  这会污染基线（让「验收器误报」看起来成立），所以不许静默继续。');
  console.log('  处置：删除上述文件后重跑；或加 --allow-dirty-probes 强制继续（不推荐）。');
  console.log('');
  process.exit(4);
}

// ── 前置体检②：故障锚点还在不在 ──
//
// 【为什么加这个】faults.json 的注入靠**写死的源码文本锚点**。
// 只要被测代码一重构，锚点就失效 —— 失效后注入抛错、该条被算成「注入失败」，
// 从分母排除，度量变 UNKNOWN。这是诚实的，但**发现得太晚**：
// 要跑完所有 13 条才知道有 2 条锚点没了。
// 已经踩过两次（RT-03/RT-04 因重构失效）。
{
  const anchorRes = checkFaultAnchors(
    FAULTS.faults,
    (p) => fs.existsSync(p),
    (p) => fs.readFileSync(p, 'utf8'),
    (p) => JSON.parse(fs.readFileSync(p, 'utf8')),
  );
  if (!anchorRes.ok) {
    console.log('');
    console.log('  ❌ 前置体检：' + anchorRes.bad.length + ' 条故障的注入锚点失效');
    for (const b of anchorRes.bad) console.log('      · ' + b.id + '  ' + b.why);
    console.log('');
    console.log('  锚点失效会让对应故障「注入失败」→ 从分母排除 → 度量变 UNKNOWN。');
    console.log('  处置：先跑 node tools/evolve/check-fault-anchors.mjs 看清，再修锚点。');
    console.log('');
    process.exit(4);
  }
}

// ── 前置体检③：故障目标文件是否留有上次注入的残留 ──
//
// 【为什么加这个（2026-11-15 实际踩到）】
// 上一次跑度量时中途被 kill，`finally` 里的还原没执行，留下两处残留：
//   tools/benchmark/survey.mjs           import → imporo（F06）
//   .../VouchShared.scss                 多了一行 calc() 字体（F09）
//
// **前置体检②（锚点体检）没抓到它** —— 因为 F06 的锚点是 `import `，
// 而 survey.mjs 里有很多 `import `，改掉一行后锚点**仍能匹配**。
// 也就是说：「锚点存在」不等于「文件干净」。
//
// 正解：直接问 git —— 故障目标文件有没有未提交改动。
// 有 ⇒ 要么是上次残留，要么是人正在改。两种都不该继续度量。
{
  const targets = [...new Set(FAULTS.faults
    .map((f) => f.inject && f.inject.path)
    .filter(Boolean))];

  const dirty = [];
  for (const rel of targets) {
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) continue;
    let out = '';
    try {
      out = execFileSync('git', ['status', '--porcelain', '--', rel], {
        cwd: REPO, encoding: 'utf8', timeout: 20000,
      }).trim();
    } catch { continue; }   // 不是 git 仓/不是跟踪文件 ⇒ 跳过
    if (out) dirty.push(rel + '  (' + out.split('\n')[0].trim().slice(0, 40) + ')');
  }

  // 【2026-11-15 修 · 复审指出 recall 在 0.923↔1.000 飘】
  // 根因：F07-dirty-git 测的就是「工作树脏不脏」。树上有任何未提交文件时，
  // F07 的**干净基线本身就是红的** ⇒ recall/fpr 随树状态变化 ⇒ 不可复算。
  // 所以：只要树不干净且要跑 F07，就必须拒跑（而不是让数字悄悄变）。
  const TREE_DIRTY = (() => {
    try {
      return execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8', timeout: 20000 }).trim();
    } catch { return ''; }
  })();
  const HAS_F07 = FAULTS.faults.some((f) => f.id === 'F07-dirty-git');
  if (TREE_DIRTY && HAS_F07 && !process.argv.includes('--allow-dirty-probes')) {
    console.log('');
    console.log('  ❌ 前置体检：工作树不干净，而 F07 测的就是「树脏不脏」');
    console.log('      ' + TREE_DIRTY.split('\n').slice(0, 5).join('\n      '));
    console.log('');
    console.log('  树脏时 F07 的干净基线本身就会红 ⇒ recall/fpr 随树状态变化 ⇒ **数字不可复算**。');
    console.log('  处置：先提交或 stash，再跑度量。或加 --allow-dirty-probes 明确接受「这次数字不可比」。');
    console.log('');
    process.exit(4);
  }

  if (dirty.length && !process.argv.includes('--allow-dirty-probes')) {
    console.log('');
    console.log('  ❌ 前置体检：' + dirty.length + ' 个故障目标文件有未提交改动');
    for (const d of dirty) console.log('      · ' + d);
    console.log('');
    console.log('  这不一定是上次注入的残留 —— 也可能是你正在改这些文件。');
    console.log('  但两种情况下都不该继续度量：残留会污染基线，改动中的文件会让锚点漂移。');
    console.log('  处置：git checkout -- <文件> 还原，或先提交。确认无残留后可加 --allow-dirty-probes。');
    console.log('');
    process.exit(4);
  }
}

console.log('');
console.log('  L4 · 度量：验收器发现真问题的能力');
console.log('  ' + '='.repeat(76));
console.log('  指标：recall = 抓到的已知故障 / 注入的故障总数');
console.log('        fpr    = 干净状态下报错的验收器数 / 检查数');
console.log('');

// ── 干净基线：先确认没注入时全部通过 ──
console.log('  ① 干净基线（未注入，应当全部通过）');
console.log('  ' + '─'.repeat(76));

/**
 * 树是否干净 —— F07（dirty git）只能在干净树上测
 *
 * 【为什么需要】实测：改代码的过程中跑度量，git 本来就是脏的，
 * F07 的基线必然 exit 1，被算成「验收器误报」。
 * 但那是**验证环境不在**，不是验收器错 —— 按四态纪律应当判 UNKNOWN。
 */
const gitDirty = (() => {
  try {
    const s = execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8', timeout: 30000 });
    return s.trim().length > 0;
  } catch { return null; }   // 取不到 ⇒ 判不了
})();

/**
 * 跑一遍干净基线
 *
 * 【2026-11-15 修 · 独立验证方 R3】原来基线只跑一次，所以 fpr 的可复算性
 * 从来没被验证过 —— 而 PASS 的措辞却写着「两次一致」，那是对 recall 说的，
 * 读者会以为 fpr 也验了。现在基线与注入测量都跑 RUNS 轮，两者都比对。
 */
function oneBaseline(gitDirty) {
  const rows = [];
  for (const f of FAULTS.faults) {
    const needsClean = f.dependsOnCleanGit === true;

    if (needsClean && gitDirty) {
      rows.push({ id: f.id, target: f.target, exit: null, clean: true, unknown: true,
        why: '树不干净（' + (gitDirty === null ? '取不到 git 状态' : '有未提交改动') + '）⇒ 该用例判 UNKNOWN，不计入误报' });
      continue;
    }

    const r = runTarget(f.target, f.cwd);
    // 有 expectOutput 的验收器可能因结构性原因非 0，此时基线判据是「不该出现该证据串」
    const clean = f.expectOutput ? !r.out.includes(f.expectOutput) : r.code === 0;
    rows.push({ id: f.id, target: f.target, exit: r.code, clean, structural: f.expectOutput && r.code !== 0 });
  }
  return rows;
}

const baselines = [];
console.log('  ① 干净基线（未注入，应当全部通过）· ' + RUNS + ' 轮');
console.log('  ' + '─'.repeat(76));
for (let r = 0; r < RUNS; r++) {
  const rows = oneBaseline(gitDirty);
  baselines.push(rows);
  if (RUNS > 1) console.log('  ── 第 ' + (r + 1) + ' 轮');
  for (const b of rows) {
    if (b.unknown) {
      console.log('    ❔ ' + b.id.padEnd(24) + b.target.padEnd(44) + 'UNKNOWN（需干净树，当前不满足）');
      continue;
    }
    console.log('    ' + (b.clean ? '✓' : '✗') + ' ' + b.id.padEnd(24) + b.target.padEnd(44)
      + 'exit=' + String(b.exit).padEnd(4) + (b.structural ? '（结构性非 0，按 expectOutput 判）' : ''));
  }
}

const baseline = baselines[0];
const falsePositives = baseline.filter((b) => !b.clean && !b.unknown);
// fpr 逐轮算，供可复算性比对
const fprs = baselines.map((rows) => {
  const fp = rows.filter((b) => !b.clean && !b.unknown).length;
  return rows.length ? fp / rows.length : null;
});
console.log('');
console.log('  干净状态下误报 ' + falsePositives.length + ' / ' + baseline.length
  + '  ⇒ 误报率 fpr = ' + (falsePositives.length / baseline.length).toFixed(3)
  + (gitDirty ? '   （树脏，git 相关用例已判 UNKNOWN）' : ''));
if (falsePositives.length) {
  for (const f of falsePositives) console.log('      ✗ ' + f.id + '  ' + f.target + '  exit=' + f.exit);
}

// ── 注入测量（跑 RUNS 轮，验可复算）──
const rounds = [];
for (let r = 0; r < RUNS; r++) {
  console.log('');
  console.log('  ② 第 ' + (r + 1) + ' 轮注入测量');
  console.log('  ' + '─'.repeat(76));
  const res = oneRound(gitDirty);
  rounds.push(res);
  for (const x of res) {
    if (x.unknown) {
      console.log('    ❔ ' + x.id.padEnd(24) + 'UNKNOWN '.padEnd(8) + '—'.padEnd(9) + x.name);
      console.log('        ' + x.why);
      continue;
    }
    const tag = !x.injected ? '注入失败' : x.caught ? '抓到' : '漏掉';
    console.log('    ' + (x.caught ? '✓' : '✗') + ' ' + x.id.padEnd(24) + tag.padEnd(8)
      + 'exit=' + String(x.exit).padEnd(4) + x.name);
    if (!x.caught && x.why) console.log('        ' + x.why);
    if (x.err) console.log('        注入失败: ' + x.err);
  }
  const measurable = res.filter((x) => !x.unknown);
  const caught = measurable.filter((x) => x.caught).length;
  console.log('    → recall = ' + caught + '/' + measurable.length + ' = '
    + (measurable.length ? (caught / measurable.length).toFixed(3) : 'n/a')
    + (res.length > measurable.length ? '   （' + (res.length - measurable.length) + ' 项判 UNKNOWN，不计入）' : ''));
}

// ── 汇总 ──
const recalls = rounds.map((r) => {
  const m = r.filter((x) => !x.unknown);
  return m.length ? m.filter((x) => x.caught).length / m.length : null;
});

/**
 * 可复算性 —— 计算已抽到 measure-summary.mjs（纯函数 + 8 条反例）
 *
 * 【为什么抽出去】这里出过两次真错：
 *   · `--runs 1` 时单元素数组 `every()` 恒真 ⇒ 只跑一轮也打印「✓ 两次一致」
 *   · `fpr` 从来没被比对过
 * 修复必须被反例钉住，否则将来谁改回去不会有人发现。
 * 现在本文件**调用** measure-summary.summarize()，不再有第二份实现。
 */
const unmeasuredIds = rounds[0].filter((x) => x.unknown).map((x) => x.id);
const anyInjectFail = rounds[0].some((x) => x.injected === false && !x.unknown);
const S = summarize({ recalls, fprs, runs: RUNS, unmeasured: unmeasuredIds, anyInjectFail });
const { recall, fpr, reproducible, reproLabel, state, why } = S;
const unmeasured = unmeasuredIds;

console.log('');
console.log('  ' + '='.repeat(76));
console.log('  汇总');
console.log('  ' + '─'.repeat(76));
console.log('    注入故障数        ' + FAULTS.faults.length);
console.log('    可测故障数        ' + (FAULTS.faults.length - unmeasured.length)
  + (unmeasured.length ? '（UNKNOWN: ' + unmeasured.join(',') + '）' : ''));
console.log('    召回率 recall     ' + recalls.map((v) => v === null ? 'n/a' : v.toFixed(3)).join(' / '));
console.log('    误报率 fpr        ' + fprs.map((v) => v === null ? 'n/a' : v.toFixed(3)).join(' / '));
console.log('    可复算性          ' + reproLabel);

const OUT = {
  what: 'L4 度量：验收器发现真问题的能力',
  metric: {
    recall,
    fpr,
    runs: RUNS,
    // 三态：null = 未验证（单轮），true/false = 已比对
    reproducible,
    recallSame: S.recallSame,
    fprSame: S.fprSame,
    unmeasured,
  },
  state, why,
  at: new Date().toISOString(),
  faultsTotal: FAULTS.faults.length,
  baseline,
  baselines,
  rounds,
  missed: rounds[0].filter((x) => !x.caught && !x.unknown).map((x) => x.id),
  falsePositives: falsePositives.map((x) => x.id),
};

const outPath = path.join(REPO, 'evidence/evolve/verifier-efficacy.json');fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(OUT, null, 2) + '\n', 'utf8');

// ══════════════════════════════════════════════════════════
// RESTORE_SELF_CHECK · 还原自检
//
// 注入类度量的还原一直是这个仓库最脏的地方：survey.mjs 的 `imporo` 反复出现（已四次）、
// VouchShared.scss 的 `.vouch-fault-calc` 残留被误提交进 HEAD，进而让 F04/F06/F09
// 在**干净树上**永远报红 —— fpr 虚高，且每轮都要人工 git checkout。
//
// 根因：还原依赖 finally，而「被 kill / 超时 / 异常路径」都可能跳过它；
// 更糟的是若上一次残留没清，下一次就把脏内容当成「原件」再还原一遍。
//
// 所以度量跑完必须自己确认注入目标是否已还原，没还原就报红并点名。
// 这是最后一道闸：宁可度量自己失败，也不许让脏内容进 git。
// ══════════════════════════════════════════════════════════
// 【修·第二版】原来只扫 FAULTS.faults 的 target，漏掉了 measure-real-recall.mjs 的注入目标
// （实测 survey.mjs 的 imporo 就是它注入的，本度量扫不到 ⇒ 自检形同虚设）。
// 现在：① 两个度量的注入目标都扫；② 排除「探测定义本身」的合法命中
// （verify-syntax-guard.mjs 里写着损坏词是它的探测规则，不是残留）。
const RESIDUE = [
  { name: 'imporo 损坏词', re: /^\s*imporo\s/m },
  { name: 'fault-probe 标记', re: /fault-probe:\s*bitfun/ },
  { name: 'fault-calc 注入类', re: /\.vouch-fault-calc\s*\{/ },
  { name: 'fault-probe 注入类', re: /\.vouch-fault-probe\s*\{/ },
];
// 探测定义文件本身：里面出现损坏词/标记是**规则**，不是残留
const DEFINITION_FILES = [
  'prototype/agent-ui/verify-syntax-guard.mjs',
  'tools/evolve/measure-verifier-efficacy.mjs',
  'tools/evolve/measure-real-recall.mjs',
  'tools/evolve/check-fault-anchors.mjs',
  'tools/quality/repair-t-o.mjs',
];

const WATCH = new Set();
for (const f of FAULTS.faults) if (f.target) WATCH.add(String(f.target).split(/\s+/)[0]);
// measure-real-recall.mjs 的注入目标（本轮加：之前漏了，导致 survey.mjs 的残留扫不到）
for (const p of [
  'tools/benchmark/survey.mjs',
  'apps/vouch-web/src/web-ui/src/app/scenes/vouch/VouchShared.scss',
  'apps/vouch-web/scripts/audit-typography-tokens.mjs',
  'apps/vouch-web/scripts/product-identity-audit.mjs',
  'prototype/hermes-agents/audit-matrix-honesty.mjs',
  'tools/benchmark/audit-coverage.mjs',
  'tools/quality/size-guard.mjs',
]) WATCH.add(p);

const dirty = [];
for (const rel of WATCH) {
  if (DEFINITION_FILES.includes(rel)) continue;
  let body;
  try { body = fs.readFileSync(path.join(REPO, rel), 'utf8'); } catch { continue; }
  for (const r of RESIDUE) if (r.re.test(body)) dirty.push(rel + ' 仍有「' + r.name + '」');
}

if (dirty.length) {
  console.log('');
  console.log('  ✗ 还原自检失败 —— 注入没清干净，这次数字不可信：');
  for (const d of dirty) console.log('      ' + d);
  console.log('  处置：git checkout -- <文件> 后重跑；不要带着脏文件提交。');
  console.log('');
  process.exit(1);
}

console.log('');
console.log('  还原自检: ✓ ' + WATCH.size + ' 个注入目标均无残留');
console.log('  四态: ' + state + ' —— ' + why);
console.log('  → ' + path.relative(REPO, outPath));
console.log('');

if (process.argv.includes('--json')) console.log(JSON.stringify(OUT, null, 2));

process.exit(state === 'PASS' ? 0 : state === 'WARN' ? 3 : state === 'FAIL' ? 1 : 2);
