#!/usr/bin/env node
// syntax-guard:allow-bad-words  (contains intentional fault fixture)
/**
 * 故障锚点体检 —— 每条故障的注入锚点**还在不在**
 *
 * ── 为什么需要它（真实踩过两次）──────────────────────────────
 * `tools/evolve/faults.json` 里的注入，靠的是**写死的源码文本锚点**
 * （如 `find: "import "`、`find: "const red = ..."`）。
 *
 * 只要被测代码一重构，锚点就失效。失效的后果是：
 *   · 注入抛错 → 该条被算成「注入失败」→ 从分母排除 → 度量变 UNKNOWN
 *   · 这是**诚实**的（UNKNOWN 不许当绿），但发现得太晚：
 *     L4 度量要跑完所有 13 条才知道有 2 条锚点没了
 *
 * 已经踩过两次：
 *   ① RT-03 / RT-04 在 measure-real-recall 里因重构失效
 *   ② 更早时 F04/F06/F07/F08 的判据都写错过
 *
 * 这个脚本做**快速前置体检**：不跑任何验收器，只检查每条故障的注入是否可行。
 *
 * ── 四态 ─────────────────────────────────────────────
 *   PASS     全部锚点/文件/JSON 键都在
 *   FAIL     有锚点失效（列出具体是哪条、缺什么）
 *   UNKNOWN  faults.json 读不到
 *
 * 用法：node tools/evolve/check-fault-anchors.mjs [--json] [--selftest]
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const FAULTS_PATH = path.join(REPO, 'tools/evolve/faults.json');

/**
 * 检查一条故障的注入是否可行
 *
 * @param fault   faults.json 里的一条
 * @param existsFn 路径存在性（自检时注入假实现）
 * @param readFn   读文件内容（自检时注入假实现）
 * @param readJsonFn 读 JSON（自检时注入假实现）
 */
export function checkFault(fault, existsFn, readFn, readJsonFn) {
  const spec = fault.inject || {};
  const abs = spec.path ? path.join(REPO, spec.path) : null;

  if (!spec.kind) return { ok: false, why: '没有 inject.kind' };

  // 这些类型会**新建**文件，不要求已存在
  const CREATES = new Set(['createFile', 'createExactSizeFile']);

  if (spec.kind === 'createFile' || spec.kind === 'createExactSizeFile') {
    if (!spec.path) return { ok: false, why: '没有 inject.path' };
    // 父目录必须存在（否则创建会失败）
    const parent = path.dirname(abs);
    return existsFn(parent)
      ? { ok: true }
      : { ok: false, why: '父目录不存在：' + path.dirname(spec.path) };
  }

  if (!spec.path) return { ok: false, why: '没有 inject.path' };
  if (!existsFn(abs)) return { ok: false, why: '目标文件不存在：' + spec.path };

  if (spec.kind === 'appendLine') {
    if (!spec.line) return { ok: false, why: '没有 inject.line' };
    return { ok: true };
  }

  if (spec.kind === 'replaceInFile') {
    if (!spec.find) return { ok: false, why: '没有 inject.find' };
    const text = readFn(abs);
    return text.includes(spec.find)
      ? { ok: true }
      : { ok: false, why: '锚点不在文件里：' + String(spec.find).slice(0, 60) };
  }

  if (spec.kind === 'editJson') {
    if (!spec.mutate) return { ok: false, why: '没有 inject.mutate' };
    let j;
    try { j = readJsonFn(abs); } catch (e) { return { ok: false, why: 'JSON 解析失败：' + String(e.message).slice(0, 50) }; }

    const op = spec.mutate;
    if (!j.dimensions && !j.byId && !j.projects) {
      return { ok: false, why: 'JSON 里既没有 dimensions 也没有 byId/projects，mutate 无从下手' };
    }
    // 逐个 mutate 检查它的前提是否成立
    const allDims = () => (j.dimensions || []).flatMap((g) => g.items || []);
    // 支持两种写法：裸名 `emptyFirstArrayField` 与带参数 `emptyFirstArrayField:strengths`
    if (op === 'emptyFirstStrengths' || op === 'emptyFirstArrayField' || op.startsWith('emptyFirstArrayField:')) {
      const field = op === 'emptyFirstStrengths'
        ? 'strengths'
        : (op.includes(':') ? op.split(':')[1] : (spec.field || 'strengths'));
      const has = Object.values(j.byId || {}).some((v) => Array.isArray(v[field]) && v[field].length > 0);
      return has ? { ok: true } : { ok: false, why: '找不到任何项目含非空 ' + field };
    }
    if (op === 'setFirstUsEvidenceToBorrowed' || op === 'emptyFirstUsEvidence') {
      const has = allDims().some((d) => d.us && d.us[0] === '有');
      return has ? { ok: true } : { ok: false, why: '找不到状态为「有」的维度' };
    }
    if (op === 'dropDimensions') {
      return Array.isArray(j.dimensions) && j.dimensions.length > 1
        ? { ok: true } : { ok: false, why: 'dimensions 不够（需要 >1 组才能「删到只剩 1 组」）' };
    }
    if (op === 'dropOneProject') {
      return Object.keys(j.byId || {}).length >= 2
        ? { ok: true } : { ok: false, why: '项目少于 2 个，删一个不成立' };
    }
    if (op === 'duplicateOneDim') {
      const has = (j.dimensions || []).some((g) => Array.isArray(g.items) && g.items.length > 1);
      return has ? { ok: true } : { ok: false, why: '找不到含 ≥2 个维度的组' };
    }
    return { ok: false, why: '未知 mutate：' + op };
  }

  return { ok: false, why: '未知 inject.kind：' + spec.kind };
}

/** 跑全部故障的锚点体检 */
export function checkAll(faults, existsFn, readFn, readJsonFn) {
  const rows = [];
  for (const f of faults) {
    const r = checkFault(f, existsFn, readFn, readJsonFn);
    rows.push({ id: f.id, name: f.name, ok: r.ok, why: r.why || '' });
  }
  const bad = rows.filter((r) => !r.ok);
  return { rows, ok: bad.length === 0, bad };
}

/** 自检 —— 反例是「锚点不在时必须报」 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  // 假环境
  const existsOk = () => true;
  const existsNo = () => false;
  const readWith = (anchor) => () => 'some text with ' + anchor + ' inside';
  const readWithout = () => 'nothing relevant here';
  const jsonOk = () => ({
    dimensions: [{ items: [{ us: ['有', 'x'] }, { us: ['有', 'y'] }] }],
    byId: { a: { strengths: ['s'] }, b: { strengths: ['s'] } },
    projects: [{ id: 'a' }],
  });

  // ── 反例 1（核心）：锚点不在文件里 → 必须报 ──
  const f1 = { id: 'X1', inject: { kind: 'replaceInFile', path: 'a.mjs', find: 'import ', replace: 'imporo ' } };
  const r1 = checkFault(f1, existsOk, readWithout, jsonOk);
  T('反例 · replaceInFile 锚点不在 → 必须报', r1.ok === false && /锚点不在/.test(r1.why), JSON.stringify(r1));

  // ── 正例 1：锚点在 → 通过 ──
  const r2 = checkFault(f1, existsOk, readWith('import '), jsonOk);
  T('正例 · 锚点在 → 通过', r2.ok === true, JSON.stringify(r2));

  // ── 反例 2：目标文件不存在 → 报 ──
  const f2 = { id: 'X2', inject: { kind: 'appendLine', path: 'ghost.mjs', line: 'x' } };
  const r3 = checkFault(f2, existsNo, readWith('x'), jsonOk);
  T('反例 · 目标文件不存在 → 必须报', r3.ok === false && /不存在/.test(r3.why), JSON.stringify(r3));

  // ── 正例 2：createFile 允许文件不存在（但要父目录在）──
  const f3 = { id: 'X3', inject: { kind: 'createFile', path: 'dir/new.mjs', content: 'x' } };
  const r4 = checkFault(f3, existsOk, readWith(''), jsonOk);
  T('正例 · createFile 不要求文件已存在', r4.ok === true, JSON.stringify(r4));
  const r5 = checkFault(f3, existsNo, readWith(''), jsonOk);
  T('反例 · createFile 但父目录不存在 → 报', r5.ok === false && /父目录/.test(r5.why), JSON.stringify(r5));

  // ── 反例 3：editJson 的 mutate 前提不成立 ──
  const f4 = { id: 'X4', inject: { kind: 'editJson', path: 'd.json', mutate: 'dropOneProject' } };
  const jsonOne = () => ({ dimensions: [{ items: [] }], byId: { only: {} } });
  const r6 = checkFault(f4, existsOk, readWith(''), jsonOne);
  T('反例 · dropOneProject 但只有 1 个项目 → 报', r6.ok === false && /少于 2/.test(r6.why), JSON.stringify(r6));

  // ── 正例 3：editJson 前提成立 ──
  const r7 = checkFault(f4, existsOk, readWith(''), jsonOk);
  T('正例 · dropOneProject 前提成立 → 通过', r7.ok === true, JSON.stringify(r7));

  // ── 反例 4：JSON 解析失败 → 报 ──
  const jsonBad = () => { throw new Error('bad json'); };
  const r8 = checkFault(f4, existsOk, readWith(''), jsonBad);
  T('反例 · JSON 解析失败 → 报', r8.ok === false && /解析失败/.test(r8.why), JSON.stringify(r8));

  // ── 反例 5：没有 inject.kind → 报 ──
  const r9 = checkFault({ id: 'X5', inject: {} }, existsOk, readWith(''), jsonOk);
  T('反例 · 没有 inject.kind → 报', r9.ok === false && /kind/.test(r9.why), JSON.stringify(r9));

  // ── 反例 6：未知 mutate → 报（不许静默放过）──
  const f6 = { id: 'X6', inject: { kind: 'editJson', path: 'd.json', mutate: 'i-dont-exist' } };
  const r10 = checkFault(f6, existsOk, readWith(''), jsonOk);
  T('反例 · 未知 mutate → 报（不许静默放过）', r10.ok === false && /未知 mutate/.test(r10.why), JSON.stringify(r10));

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
    console.log('  故障锚点体检 · 自检（3 正例 + 7 反例）');
    console.log('  ' + '─'.repeat(72));
    console.log(r.lines);
    console.log('');
    console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
    console.log('');
    process.exit(r.ok ? 0 : 1);
  }

  if (!fs.existsSync(FAULTS_PATH)) {
    console.log('  ❔ 读不到 tools/evolve/faults.json');
    process.exit(2);
  }
  const FAULTS = JSON.parse(fs.readFileSync(FAULTS_PATH, 'utf8'));
  const res = checkAll(
    FAULTS.faults,
    (p) => fs.existsSync(p),
    (p) => fs.readFileSync(p, 'utf8'),
    (p) => JSON.parse(fs.readFileSync(p, 'utf8')),
  );

  console.log('');
  console.log('  故障锚点体检 —— 每条故障的注入是否可行');
  console.log('  ' + '='.repeat(76));
  for (const r of res.rows) {
    console.log('  ' + (r.ok ? '✓' : '✗') + ' ' + r.id.padEnd(24) + r.name.slice(0, 34).padEnd(36) + (r.ok ? '' : r.why));
  }
  console.log('  ' + '─'.repeat(76));
  const state = res.ok ? 'PASS' : 'FAIL';
  console.log('  ' + res.rows.length + ' 条 · 可行 ' + (res.rows.length - res.bad.length) + ' · 失效 ' + res.bad.length);
  console.log('');
  console.log('  四态: ' + state + ' —— ' + (res.ok ? '全部锚点/文件/JSON 键都在' : res.bad.length + ' 条注入锚点失效，度量会因此变 UNKNOWN'));
  console.log('');

  const OUT = { what: '故障锚点体检', at: new Date().toISOString(), state, rows: res.rows };
  const outPath = path.join(REPO, 'evidence/evolve/fault-anchors.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(OUT, null, 2) + '\n', 'utf8');
  if (process.argv.includes('--json')) console.log(JSON.stringify(OUT, null, 2));
  process.exit(res.ok ? 0 : 1);
}
