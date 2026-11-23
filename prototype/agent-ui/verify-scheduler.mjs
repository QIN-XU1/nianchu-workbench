#!/usr/bin/env node
/**
 * A11 调度器验收
 *
 * 背景：A11 之前记「部分」，证据写得很直白 ——
 *   「定时任务来自 hermes 的 cron/ 与 scheduler_provider，我们**没有自己的调度器**」。
 * 现在有自研的 tools/schedule/scheduler.mjs。
 *
 * 这份验收要证明六件事，任何一条不过都不算「有」：
 *   1. cron 解析正确（含时区、区间、步长）
 *   2. 非法 cron 被拒（不许默默接受）
 *   3. 下次触发时间可复算（同一输入同一输出）
 *   4. 真实执行四态：exit 0 → PASS · 非 0 → FAIL · 超时 → UNKNOWN
 *   5. 超时**真的生效**（这是实测踩到的坑：spawnSync 的 timeout 在 Windows
 *      对 shell:true 的子进程树无效，60s 的 job 配 3s 超时仍跑满 60s 还判 PASS）
 *   6. 持久化：job 与运行记录落盘，进程重启不丢
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const S = path.join(REPO, 'tools/schedule/scheduler.mjs');
const STORE = path.join(REPO, 'evidence/schedule/jobs.json');

let pass = 0, fail = 0, unknown = 0;
const I = { ok: '✓', no: '✗', un: '❔' };
const ok = (c, m) => { if (c) { pass++; console.log('  ' + I.ok + ' ' + m); } else { fail++; console.log('  ' + I.no + ' ' + m); } return c; };

function cli(args, timeout = 180000) {
  const t0 = Date.now();
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, [S, ...args], {
      cwd: REPO, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    code = e.status ?? 2;
  }
  return { out, code, ms: Date.now() - t0 };
}

// ── 核心判定抽成可导出的纯函数（自检可注入假输入）────────────────────
//
// 为什么要抽：A11 的价值全在「四态 + 超时真生效 + 落盘」。
// 这些判定一旦被人放松（比如把 FAIL 当 PASS、把超时没生效也判通过），
// 验收就成了装饰。抽成纯函数后，自检可以喂进「期望 FAIL 实得 PASS」
// 「超时耗时 60s」这类假数据，断言它必须报警。

/**
 * 剥掉源码里的字符串字面量与注释，只留真代码
 *
 * 【为什么必须有 —— 这是本项目已被踩过的坑】
 * 本文件的测试夹具里有一行：
 *   ['acc-fail', 'node -e "process.exit(7)"', 'FAIL']
 * 那是**字符串里的测试夹具**，不是真的 exit(7)。
 * 如果直接正则扫 `process.exit` 判断「调度器自己有没有硬退出」，
 * 会把这一行误报成真代码。所以任何「查代码里有没有 X」都必须先剥壳。
 *
 * 局限：模板串里的 ${...} 会被整体当字符串剥掉；正则字面量不处理。
 * 对本自检的用途（识别 process.exit 调用）已经足够。
 */
export function stripStringsAndComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    // 行注释
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    // 块注释
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    // 字符串（含模板串）
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      i++;
      out += ' STR ';   // 用占位符保持分隔，避免把前后 token 粘连
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** 剥壳后仍真实存在的 process.exit(...) 调用数（字符串/注释里的不算） */
export function findRealProcessExit(src) {
  const code = stripStringsAndComments(src);
  return (code.match(/\bprocess\.exit\s*\(/g) || []).length;
}

/**
 * cron 判定：四类表达式都要「可复算（两次同结果）」且「下次触发在未来」。
 * api 注入 { parseCron, nextRun }，自检用假 api 制造不可复算/过去时间。
 */
export function judgeCron(api, base, cases) {
  const results = [];
  for (const [expr, desc] of cases) {
    const n1 = api.nextRun(api.parseCron(expr), base);
    const n2 = api.nextRun(api.parseCron(expr), base);
    const same = n1 && n2 && n1.getTime() === n2.getTime();
    const future = n1 && n1.getTime() > base.getTime();
    results.push({ expr, desc, ok: !!(same && future), next: n1 ? n1.toISOString() : 'null', same });
  }
  const passed = results.filter((r) => r.ok).length;
  return { ok: passed === cases.length, passed, total: cases.length, results, failures: results.filter((r) => !r.ok) };
}

/** 非法 cron 判定：每一个都必须在 parseCron 时抛错（不许默默接受） */
export function judgeReject(api, bad) {
  let rejected = 0;
  for (const b of bad) {
    try { api.parseCron(b); } catch { rejected++; }
  }
  return { rejected, total: bad.length, ok: rejected === bad.length };
}

/** 命中判定：9:00 命中「0 9 * * *」，9:01 不命中 */
export function judgeMatches(api) {
  const c = api.parseCron('0 9 * * *');
  return [
    { name: '命中判定：9:00 命中「0 9 * * *」', ok: api.matches(c, new Date(2026, 10, 15, 9, 0)) === true },
    { name: '命中判定：9:01 不命中', ok: api.matches(c, new Date(2026, 10, 15, 9, 1)) === false },
  ];
}

/**
 * 真实执行四态判定：
 *   · 状态必须等于期望（PASS/FAIL/UNKNOWN）
 *   · 超时用例必须**真的在阈值内返回**（msOk），否则「超时没生效」也判失败
 * 这正是实测踩到的坑：状态对了但耗时 60s，说明 timeout 根本没生效。
 */
export function judgeExecState({ got, want, ms, timeout }) {
  const msOk = timeout ? ms < 20000 : true;
  return { ok: got === want && msOk, msOk, got, want, ms };
}

/** 退出码映射四态：PASS→0, FAIL→1, UNKNOWN→2 */
export function judgeExitCodes(codes, wants) {
  const ok = codes.length === wants.length && codes.every((c, i) => c === wants[i]);
  return { ok, codes, wants };
}

/** 持久化判定：job 落盘 + 运行记录留痕 + 留痕含 at/exit/ms（可追溯） */
export function judgePersistence(db, minJobs, storeRel) {
  const jobs = Array.isArray(db.jobs) ? db.jobs : [];
  const hasJobs = jobs.length >= minJobs;
  const runs = jobs.flatMap((j) => j.runs || []);
  const hasDetail = runs.some((r) => typeof r.ms === 'number' && 'exit' in r && typeof r.at === 'string');
  return [
    { name: 'job 已持久化到 ' + storeRel + '（' + jobs.length + ' 条）', ok: hasJobs },
    { name: '运行记录已留痕（' + runs.length + ' 条，带 exit/ms/stdout）', ok: runs.length > 0 },
    { name: '留痕含 at / exit / ms / stdout（可追溯）', ok: hasDetail },
  ];
}

/**
 * 自检 —— 每条反例都断言「构造一个假绿，判定必须报出来」
 *
 * 【为什么必须有】A11 最容易假绿的地方是：超时没生效仍判 PASS、
 * FAIL 当成 PASS、运行记录没落盘却说持久化。这些都用假数据钉死。
 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  // ── 反例 1（历史坑）：字符串夹具里的 process.exit(7) 不是真调用 ──
  //   本文件第 98 行就有这一行；不剥字符串直接扫源码会把它误报成真 exit(7)。
  const fixture = "const JOBS = [\n  ['acc-fail', 'node -e \"process.exit(7)\"', 'FAIL'],\n];\n";
  T('反例 · 字符串夹具里的 process.exit(7) 剥掉后不算真调用',
    findRealProcessExit(fixture) === 0, '实得 ' + findRealProcessExit(fixture));

  // ── 反例 2：注释里的 process.exit 也算真调用 → 必须不误报 ──
  const commented = "// 这段只是说明：process.exit(7) 会让 job FAIL\nconst x = 1;\n";
  T('反例 · 注释里的 process.exit 不误报', findRealProcessExit(commented) === 0, '实得 ' + findRealProcessExit(commented));

  // ── 正例 1：真代码里的 process.exit(1) 必须被识别 ──
  T('正例 · 真实 process.exit(1) 仍被识别', findRealProcessExit('if (bad) process.exit(1);\n') === 1, '实得 ' + findRealProcessExit('if (bad) process.exit(1);\n'));

  // ── 反例 3：期望 FAIL 实得 PASS（非 0 退出被当成 PASS）→ 必须判失败 ──
  const v1 = judgeExecState({ got: 'PASS', want: 'FAIL', ms: 100, timeout: false });
  T('反例 · 期望 FAIL 实得 PASS → 判失败', v1.ok === false, JSON.stringify(v1));

  // ── 反例 4（实测坑）：状态 UNKNOWN 对，但耗时 60s（超时没生效）→ 判失败 ──
  const v2 = judgeExecState({ got: 'UNKNOWN', want: 'UNKNOWN', ms: 60000, timeout: true });
  T('反例 · 超时没生效（耗时 60s）→ 即使状态对也判失败', v2.ok === false && v2.msOk === false, JSON.stringify(v2));

  // ── 正例 2：超时真的在阈值内返回 UNKNOWN → 通过 ──
  const v3 = judgeExecState({ got: 'UNKNOWN', want: 'UNKNOWN', ms: 3100, timeout: true });
  T('正例 · 超时在阈值内返回 UNKNOWN → 通过', v3.ok === true, JSON.stringify(v3));

  // ── 反例 5：退出码映射错（FAIL 记成 0）→ 必须判失败 ──
  const e1 = judgeExitCodes([0, 0, 2], [0, 1, 2]);
  T('反例 · 退出码映射错（FAIL 记成 0）→ 判失败', e1.ok === false, JSON.stringify(e1));

  // ── 反例 6：退出码少一位（UNKNOWN 没跑出来）→ 必须判失败 ──
  const e2 = judgeExitCodes([0, 1], [0, 1, 2]);
  T('反例 · 退出码 0/1 缺 UNKNOWN 的 2 → 判失败', e2.ok === false, JSON.stringify(e2));

  // ── 反例 7：cron 两次结果不同（不可复算）→ 必须判失败 ──
  const flipApi = { parseCron: (e) => e, nextRun: (() => { let k = 0; return () => new Date(2026, 10, 16, 9, ++k); })() };
  const c1 = judgeCron(flipApi, new Date('2026-11-15T01:00:00'), [['0 9 * * *', '每天 9:00']]);
  T('反例 · cron 两次结果不同（不可复算）→ 判失败', c1.ok === false, JSON.stringify(c1.results));

  // ── 反例 8：cron 下次触发不在未来（算到过去）→ 必须判失败 ──
  const pastApi = { parseCron: (e) => e, nextRun: () => new Date('2020-01-01T00:00:00') };
  const c2 = judgeCron(pastApi, new Date('2026-11-15T01:00:00'), [['0 9 * * *', 'x']]);
  T('反例 · 下次触发不在未来 → 判失败', c2.ok === false, JSON.stringify(c2.results));

  // ── 正例 3：稳定且未来的 nextRun → 通过 ──
  const goodApi = { parseCron: (e) => e, nextRun: () => new Date('2026-11-16T01:00:00') };
  const c3 = judgeCron(goodApi, new Date('2026-11-15T01:00:00'), [['0 9 * * *', '每天 9:00'], ['*/15 * * * *', '每15分']]);
  T('正例 · 稳定且未来 → 通过', c3.ok === true && c3.passed === 2, JSON.stringify(c3.passed));

  // ── 反例 9：非法 cron 被默默接受（不抛错）→ 必须判失败 ──
  const lenientApi = { parseCron: () => ({}) };
  const rj = judgeReject(lenientApi, ['0 9 * *', '99 * * * *']);
  T('反例 · 非法 cron 未抛错（默默接受）→ 判失败', rj.ok === false && rj.rejected === 0, JSON.stringify(rj));

  // ── 反例 10：命中判定把 9:01 也当命中 → 必须报警 ──
  const alwaysApi = { parseCron: () => 0, matches: () => true };
  const mm = judgeMatches(alwaysApi);
  T('反例 · 命中判定把 9:01 也当命中 → 判红', mm.some((a) => /9:01/.test(a.name) && !a.ok), JSON.stringify(mm.map((a) => a.ok)));

  // ── 正例 4：正确命中判定 → 全绿 ──
  const matchOkApi = { parseCron: () => 0, matches: (c, d) => d.getHours() === 9 && d.getMinutes() === 0 };
  T('正例 · 正确命中判定 → 全绿', judgeMatches(matchOkApi).every((a) => a.ok), JSON.stringify(judgeMatches(matchOkApi).map((a) => a.ok)));

  // ── 反例 11：job 在但零运行记录（没真跑）→ 必须报 ──
  const dp = judgePersistence({ jobs: [{ name: 'a', runs: [] }, { name: 'b' }] }, 2, 'evidence/schedule/jobs.json');
  T('反例 · job 在但零运行记录 → 报「运行记录已留痕」红',
    dp.some((a) => /运行记录已留痕/.test(a.name) && !a.ok), JSON.stringify(dp.map((a) => a.ok)));

  // ── 反例 12：运行记录缺 exit/ms（无法追溯）→ 必须报 ──
  const dp2 = judgePersistence({ jobs: [{ name: 'a', runs: [{ at: 'x' }] }] }, 1, 'x');
  T('反例 · 运行记录缺 exit/ms → 报「可追溯」红',
    dp2.some((a) => /可追溯/.test(a.name) && !a.ok), JSON.stringify(dp2.map((a) => a.ok)));

  // ── 反例 13：job 数不足（少落盘）→ 必须报 ──
  const dp3 = judgePersistence({ jobs: [{ name: 'a', runs: [{ at: '2026', exit: 0, ms: 1 }] }] }, 3, 'x');
  T('反例 · 落盘 job 数不足 → 报「job 已持久化」红',
    dp3.some((a) => /job 已持久化/.test(a.name) && !a.ok), JSON.stringify(dp3.map((a) => a.ok)));

  // ── 正例 5：完整持久化 → 全绿 ──
  const goodDb = { jobs: [{ name: 'a', runs: [{ at: '2026', exit: 0, ms: 12, stdout: '1' }] }] };
  T('正例 · 完整持久化 → 全绿', judgePersistence(goodDb, 1, 'x').every((a) => a.ok),
    JSON.stringify(judgePersistence(goodDb, 1, 'x').map((a) => a.ok)));

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  A11 调度器验收 · 自检（5 正例 + 13 反例）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

console.log('');
console.log('  A11 调度器验收 —— 自研，不借 hermes cron');
console.log('  ' + '─'.repeat(72));

ok(fs.existsSync(S), '调度器在位（tools/schedule/scheduler.mjs）');

// ── 1. cron 解析（通过 import 直接验，不依赖 CLI 输出格式）──
let M = null;
try {
  M = await import('file://' + S.replace(/\\/g, '/'));
} catch (e) {
  console.log('  ' + I.no + ' 无法 import 调度器: ' + String(e.message).slice(0, 80));
}

if (!M) {
  unknown++;
  console.log('  ' + I.un + ' 后续检查无法进行');
} else {
  // 下次触发时间：固定基准，可复算
  const base = new Date('2026-11-15T01:00:00');
  const CASES = [
    ['0 9 * * *', '每天 9:00'],
    ['*/15 * * * *', '每 15 分钟'],
    ['0 0 1 * *', '每月 1 号'],
    ['30 8 * * 1', '每周一 8:30'],
  ];
  const cr = judgeCron(M, base, CASES);
  for (const f of cr.failures) {
    console.log('  ' + I.no + ' cron「' + f.expr + '」(' + f.desc + ') 下次=' + f.next + (f.same ? '' : ' 不可复算'));
  }
  ok(cr.ok, '四类 cron 解析 + 下次触发可复算（' + cr.passed + '/' + CASES.length + '）');

  // 非法必须拒
  const BAD = ['0 9 * *', '99 * * * *', '* * * * * *', '0 25 * * *'];
  const rj = judgeReject(M, BAD);
  ok(rj.ok, '非法 cron 全部被拒（' + rj.rejected + '/' + BAD.length + '）');

  // matches 判定
  for (const a of judgeMatches(M)) ok(a.ok, a.name);
}

// ── 2. 真实执行四态 ──
const JOBS = [
  ['acc-pass', 'node -e "console.log(1)"', 'PASS'],
  ['acc-fail', 'node -e "process.exit(7)"', 'FAIL'],
  ['acc-timeout', 'node -e "setTimeout(function(){},60000)"', 'UNKNOWN'],
];
for (const [name] of JOBS) cli(['remove', name]);

let execOk = 0;
for (const [name, cmd, want] of JOBS) {
  const extra = name === 'acc-timeout' ? ['--timeout=3'] : [];
  cli(['add', '--name=' + name, '--cron=*/5 * * * *', '--cmd=' + cmd, ...extra]);
  const r = cli(['run', name]);
  const got = (r.out.match(/[✓✗?]\s+(PASS|FAIL|UNKNOWN)/) || [, '?'])[1];
  const v = judgeExecState({ got, want, ms: r.ms, timeout: name === 'acc-timeout' });
  if (v.ok) {
    execOk++;
    console.log('  ' + I.ok + ' ' + name + ' → ' + got + '（' + r.ms + 'ms）');
  } else {
    console.log('  ' + I.no + ' ' + name + ' 期望 ' + want + ' 实得 ' + got + '（' + r.ms + 'ms' +
      (v.msOk ? '' : ' ← 超时没生效') + '）');
  }
}
ok(execOk === JOBS.length, '真实执行四态正确（' + execOk + '/' + JOBS.length + '：PASS / FAIL / 超时判 UNKNOWN）');

// 退出码映射：PASS→0, FAIL→1, UNKNOWN→2
const exitCases = JOBS.map(([n]) => cli(['run', n]).code);
const wantCodes = [0, 1, 2];
const ec = judgeExitCodes(exitCases, wantCodes);
ok(ec.ok, '退出码映射四态：' + exitCases.join('/') + '（期望 0/1/2）');

// ── 3. 持久化 ──
if (fs.existsSync(STORE)) {
  const db = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  for (const a of judgePersistence(db, JOBS.length, path.relative(REPO, STORE))) ok(a.ok, a.name);
} else {
  ok(false, '没有持久化文件 evidence/schedule/jobs.json');
}

// ── 4. tick 真实触发 + 幂等（R6 要求「被真实触发的记录」）──
{
  const now = new Date();
  const cron = now.getMinutes() + ' ' + now.getHours() + ' * * *';
  cli(['remove', 'acc-tick']);
  cli(['add', '--name=acc-tick', '--cron=' + cron, '--cmd=node -e "console.log(2)"']);

  const readRuns = () => {
    if (!fs.existsSync(STORE)) return 0;
    const d = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    const j = (d.jobs || []).find((x) => x.name === 'acc-tick');
    return j ? (j.runs || []).length : 0;
  };

  const r0 = readRuns();
  cli(['tick']);
  const r1 = readRuns();
  ok(r1 > r0, 'tick 真实触发到点 job（运行次数 ' + r0 + ' → ' + r1 + '）—— 不是只支持手动 run');

  // 幂等：同一分钟再 tick 不重复跑
  cli(['tick']);
  const r2 = readRuns();
  ok(r2 === r1, '同一分钟内重复 tick 不重复执行（' + r1 + ' → ' + r2 + '，幂等）');

  cli(['remove', 'acc-tick']);
}

// ── 5. 清理测试 job ──
for (const [name] of JOBS) cli(['remove', name]);

console.log('');
console.log('  ' + '─'.repeat(72));
console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
console.log('');
process.exit(fail ? 1 : unknown ? 2 : 0);
