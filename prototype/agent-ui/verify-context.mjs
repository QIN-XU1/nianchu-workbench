#!/usr/bin/env node
/**
 * A5 上下文压缩验收
 *
 * 背景：A5 之前记「部分」，证据原话：
 *   「经 hermes 衍生：context_compressor.py 321KB，两层阈值 + 结构化摘要 + fallback chain。
 *     能力在产品里，**未在本项目真跑过**」—— 典型借力未自研。
 *
 * 现在有自研的 tools/context/compress.mjs。这份验收的重点不是「能截断」，
 * 而是**压缩后仍能做对事**：
 *
 *   评分层（离线自检 12 项）
 *     · 无需压缩时原样返回
 *     · 能压到预算内且真的变小
 *     · 错误信息不丢
 *     · 用户约束不丢
 *     · 最近 N 轮强制保留
 *     · 摘要机制可用
 *     · 预算太小 → FAIL（不假装成功）
 *     · 非法输入 → UNKNOWN
 *     · token 估算（CJK 按字 / ASCII 按 4 字符）
 *
 *   工程层
 *     · 源码里真的实现了分级打分、关键事实提取、预算预留、收敛回退
 *     · 压缩率可复算（同输入同输出）
 *
 * 特别断言（反假绿）：
 *   · 压不到预算内必须 FAIL，不许报 WARN/PASS
 *   · 丢了关键事实必须 FAIL，不许报成功
 *
 * ── 关于 --selftest（给验收器本身加反例）────────────────────────
 * 之前这份验收的判据是**写死在流程里**的（ok(...) 直接调），没法验证
 * 「判据写反了会不会有人发现」。现在把判定抽成可导出的纯函数，
 * 用假输入逐条断言「该红的必须红」。反例挑的都是这份文件真实会错的点：
 *   · 子自检 10/12（有反例塌了）却因为「有结论行」被当通过
 *   · 子自检 0/0（一条反例都没有）被当成「全过」
 *   · 压缩后超预算，但只比了「确实变小了」就放行
 *   · 错误信息（ENOENT）丢了却报成功 —— 头部明令禁止
 *   · 预算太小时压缩器返回 WARN，验收仍放行
 *   · 非法输入返回 PASS，验收仍放行
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const MJS = path.join(REPO, 'tools/context/compress.mjs');

/** 验收用的预算（改动这里会同步改所有断言里的 1500） */
const BUDGET = 1500;

// ── 探针表 ──────────────────────────────────────────────────────
/** 子自检输出里必须出现的探针（左：探针原文，右：给人看的标签） */
const PROBES = [
  ['无需压缩时原样返回', '短路：无需压缩时不动'],
  ['压缩到预算内', '能压进预算'],
  ['错误信息不丢', '关键事实：错误不丢'],
  ['用户约束不丢', '关键事实：约束不丢'],
  ['最近 N 轮强制保留', '近期上下文保留'],
  ['生成压缩摘要标记', '结构化摘要'],
  ['预算太小 → FAIL', '压不下时 FAIL 而不是假装成功'],
  ['非法输入 → UNKNOWN', '非法输入判不了'],
  ['token 估算：CJK 按字算', 'token 估算（中文）'],
  ['token 估算：ASCII 按 4 字符算', 'token 估算（英文）'],
];

/** 压缩器源码里必须出现的实现标志 */
const SOURCE_PROBES = [
  ['scoreItem', '分级打分（不是无脑截断）'],
  ['extractKeyFacts', '关键事实提取（压缩正确性的判据）'],
  ['SUMMARY_RESERVE', '摘要预算预留（第一版没留导致超预算）'],
  ['keyIdx', '关键事实所在条目强制保留'],
  ['shrinkable', '收敛回退（摘要成本是估算值，用真实结果兜底）'],
  ['keepRecent', '最近 N 轮策略'],
];

/** 压缩输出里必须原样还在的关键事实 */
const FACT_PROBES = [
  [/ENOENT/, '输出里真的有错误信息（ENOENT）'],
  [/必须用 pnpm/, '输出里真的有用户约束（必须用 pnpm）'],
  [/因此决定用 pnpm/, '输出里真的有结论（因此决定用 pnpm）'],
  [/最后一步：把结果汇总给我/, '输出里真的有最近一轮'],
];

// ══════════════════════════════════════════════════════════════
// 纯函数区 —— 只吃数据，不碰文件/进程，自检可注入假输入
// ══════════════════════════════════════════════════════════════

/**
 * 解析压缩器 --selftest 的结论行
 *
 * 【为什么必须判 total > 0】老判据是 `pass === total`。如果压缩器的
 * 自检用例表被清空（比如重构时 cases 漏 push），输出会是
 * 「结论: ✓ 0/0」—— 0 === 0 成立 ⇒ 空自检被当成「全过」。
 * 「一条反例都没跑」和「反例全过」是两件事，绝不能混。
 */
export function judgeSelftest(text) {
  const t = String(text ?? '');
  const m = /结论: ✓ (\d+)\/(\d+)/.exec(t);
  if (!m) return { hasConclusion: false, pass: 0, total: 0, allPass: false, line: '自检 没有结论行（判不了）' };
  const pass = Number(m[1]);
  const total = Number(m[2]);
  const allPass = total > 0 && pass === total;
  return { hasConclusion: true, pass, total, allPass, line: '自检 ' + pass + '/' + total + (allPass ? ' 全过' : ' —— 有反例不成立') };
}

/** 子自检输出里的能力探针 */
export function probeChecks(text, probes = PROBES) {
  const t = String(text ?? '');
  return probes.map(([probe, label]) => ({ label, ok: t.includes(probe) }));
}

/** 源码实现探针 */
export function sourceChecks(src, probes = SOURCE_PROBES) {
  const s = String(src ?? '');
  return probes.map(([probe, label]) => ({ label: '实现' + label, ok: s.includes(probe) }));
}

/** 可复算：同输入两次压缩，after/kept 必须一致 */
export function auditDeterminism(a, b) {
  const afterA = a?.stats?.after;
  const afterB = b?.stats?.after;
  const okv = afterA === afterB && a?.stats?.kept === b?.stats?.kept;
  return [{ label: '可复算：同输入两次压缩结果一致（' + afterA + ' = ' + afterB + ' tokens）', ok: okv }];
}

/** 效果：语境够大 / 压进预算 / 压缩率达标 / 关键事实分类数 */
export function auditEffect(r, { budget = BUDGET, maxRatio = 0.25, minBefore = 5000, minFacts = 3 } = {}) {
  const stats = r?.stats || {};
  const facts = Array.isArray(r?.keyFacts) ? r.keyFacts : [];
  return [
    { label: '测试上下文 ' + stats.before + ' tokens（够大才有意义）', ok: stats.before > minBefore },
    { label: '压缩后 ' + stats.after + ' tokens ≤ 预算 ' + budget, ok: stats.after <= budget },
    { label: '压缩率 ' + stats.ratio + '（≤' + maxRatio + '，即至少 4:1）', ok: stats.ratio <= maxRatio },
    { label: '关键事实 ' + facts.length + ' 类全部保留：' + facts.join('/'), ok: facts.length >= minFacts },
  ];
}

/** 输出文本里关键事实是否真的还在 */
export function auditOutputFacts(r, probes = FACT_PROBES) {
  const text = (r?.output || []).map((x) => String(x?.text)).join('\n');
  return probes.map(([re, label]) => ({ label, ok: re.test(text) }));
}

/** 反假绿：预算太小必须 FAIL、非法输入必须 UNKNOWN —— 不许假装成功 */
export function auditRefusal(rTight, rBad) {
  return [
    { label: '预算 30 时判 ' + rTight?.state + '（必须 FAIL，不许假装成功）', ok: rTight?.state === 'FAIL' },
    { label: '输入为 null 时判 ' + rBad?.state + '（判不了）', ok: rBad?.state === 'UNKNOWN' },
  ];
}

/** 摘要段：必须存在，且必须说明省略了什么（不是静默丢弃） */
export function auditSummary(r, { requireNote = /省略/ } = {}) {
  const sums = (r?.output || []).filter((x) => x?.synthesized);
  const text = sums.map((x) => String(x?.text)).join(' ');
  return [
    { label: '输出含合成摘要段（' + sums.length + ' 段）', ok: sums.length > 0 },
    { label: '摘要说明了省略了什么（不是静默丢弃）', ok: requireNote.test(text) },
  ];
}

/**
 * 退出码 —— 抽出来是为了能测「有失败时不许被 UNKNOWN 掩盖」
 * 本项目的约定：0 通过 / 1 失败 / 2 无法判断。
 */
export function exitCode({ fail = 0, unknown = 0 } = {}) {
  return fail ? 1 : unknown ? 2 : 0;
}

// ══════════════════════════════════════════════════════════════
// 自检 —— 用假输入断言「该红的必须红」
// ══════════════════════════════════════════════════════════════
export function selfTest() {
  const cases = [];
  const T = (n, okv, why) => cases.push([n, !!okv, why]);
  const pick = (checks, re) => checks.find((c) => re.test(c.label)) || { ok: false, label: '(缺这条检查)' };

  // ── 反例 1：子自检 10/12（有 2 条反例不成立）──
  // 为什么重要：本验收对压缩器的信任**全压在这一行结论上**。
  // 若判据写成「有结论行就算过」而不是 `pass === total`，
  // 压缩器自己的反例塌了 2 条，这里仍会显示「✓ 自检 10/12 全过」。
  const sjBad = judgeSelftest('  结论: ✓ 10/12');
  T('反例 · 子自检 10/12（有反例不成立）→ 本验收必须判红',
    sjBad.hasConclusion && !sjBad.allPass, 'allPass=' + sjBad.allPass);

  // ── 反例 2：子自检一条用例都没跑（0/0）──
  // 为什么重要：0 === 0 会让「空自检」看起来像「全过」。反例表被搬空是最隐蔽的假绿。
  const sjEmpty = judgeSelftest('结论: ✓ 0/0');
  T('反例 · 子自检 0/0（一条反例都没跑）→ 不许当全过',
    sjEmpty.hasConclusion && !sjEmpty.allPass, 'allPass=' + sjEmpty.allPass);

  // ── 反例 3：子自检没有结论行 ──
  // 为什么重要：压缩器崩溃/超时只留半截输出，把「没消息」当「没问题」是最典型的假绿。
  const sjNone = judgeSelftest('  ✓ 无需压缩时原样返回\n  ✓ 压缩到预算内\n');
  T('反例 · 子自检没有结论行 → 不许当通过',
    !sjNone.hasConclusion, 'hasConclusion=' + sjNone.hasConclusion);

  // ── 反例 4：压不进预算 ──
  // stats 自报 after=2000 > budget=1500。判据若写成「只要 after < before 就算压到了」，
  // 就会把「没压到位」当成功 —— 这正是头部「压不到预算内必须 FAIL」要挡的。
  const over = {
    stats: { before: 10000, after: 2000, kept: 10, ratio: 0.2 },
    keyFacts: ['约束', '错误', '结论'],
    output: [
      { text: 'Error: ENOENT 必须用 pnpm 因此决定用 pnpm 最后一步：把结果汇总给我' },
      { text: '压缩摘要：省略 12 条', synthesized: true },
    ],
  };
  T('反例 · 压缩后 2000 tokens 超预算 1500 → 必须判不达标',
    pick(auditEffect(over, { budget: 1500 }), /≤ 预算/).ok === false, pick(auditEffect(over, { budget: 1500 }), /≤ 预算/).label);

  // ── 反例 5：压缩率只到 0.6（远未到 4:1）──
  // 变了小但远没达标。若判据写成 ratio < 1（「确实变小了」），这条会被漏掉。
  const slow = { stats: { before: 10000, after: 6000, kept: 20, ratio: 0.6 }, keyFacts: ['约束', '错误', '结论'] };
  T('反例 · 压缩率 0.6（远未到 4:1）→ 必须判不达标',
    pick(auditEffect(slow, { budget: 10000 }), /压缩率/).ok === false, pick(auditEffect(slow, { budget: 10000 }), /压缩率/).label);

  // ── 反例 6：错误信息（ENOENT）丢了 ──
  // 头部特别断言「丢了关键事实必须 FAIL，不许报成功」。
  // 错误信息丢了模型会重犯同一个错，这是压缩正确性的核心判据。
  const lostErr = { output: [{ text: '一切正常，必须用 pnpm 因此决定用 pnpm 最后一步：把结果汇总给我' }] };
  T('反例 · 输出丢了 ENOENT 错误信息 → 必须判丢失',
    pick(auditOutputFacts(lostErr), /ENOENT/).ok === false, pick(auditOutputFacts(lostErr), /ENOENT/).label);

  // ── 反例 7：预算太小时压缩器返回 WARN（假装成功）──
  // 预算 30 的正确结局是 FAIL。若压缩器悄悄降级成 WARN，验收必须抓住。
  const cRef = auditRefusal({ state: 'WARN' }, { state: 'UNKNOWN' });
  T('反例 · 预算 30 时压缩器返回 WARN → 必须判它假装成功',
    pick(cRef, /预算 30/).ok === false, pick(cRef, /预算 30/).label);

  // ── 反例 8：非法输入却返回 PASS ──
  const cRef2 = auditRefusal({ state: 'FAIL' }, { state: 'PASS' });
  T('反例 · 输入 null 却返回 PASS → 必须判不可判定',
    pick(cRef2, /null/).ok === false, pick(cRef2, /null/).label);

  // ── 反例 9：两次压缩结果不一致（不可复算）──
  const cDet = auditDeterminism({ stats: { after: 1489, kept: 30 } }, { stats: { after: 1600, kept: 30 } });
  T('反例 · 同输入两次压缩结果不一致 → 必须判不可复算', cDet[0]?.ok === false, cDet[0]?.label);

  // ── 反例 10：摘要没说省略了什么 ──
  // 「有摘要段」不等于「摘要在解释」。静默丢弃同样是丢关键信息。
  const mute = { output: [{ role: 'summary', text: '压缩摘要', synthesized: true }] };
  T('反例 · 摘要不说明省略了什么 → 必须判「静默丢弃」',
    pick(auditSummary(mute), /省略/).ok === false, pick(auditSummary(mute), /省略/).label);

  // ── 反例 11：源码实现探针缺失 ──
  // 若「实现」检查退化成 OR（有任意一项就算过），收敛回退被删掉也看不出来。
  const cSrc = sourceChecks('scoreItem extractKeyFacts', [['shrinkable', '收敛回退']]);
  T('反例 · 源码里没有收敛回退（shrinkable）→ 必须判实现缺失',
    cSrc[0].ok === false, cSrc[0].label);

  // ── 反例 12：退出码约定 ──
  // 有失败项时必须是 1。若写成 `unknown ? 2 : fail ? 1 : 0`，
  // 一个「既有失败又有无法判断」的验收会以 2 退出，被上层当成「判不了」放行。
  T('反例 · 有失败项时退出码必须是 1（不许被「无法判断」的 2 盖掉）',
    exitCode({ fail: 1, unknown: 2 }) === 1, 'got=' + exitCode({ fail: 1, unknown: 2 }));
  T('反例 · 只有无法判断时退出码必须是 2（不许当 0 通过）',
    exitCode({ fail: 0, unknown: 2 }) === 2, 'got=' + exitCode({ fail: 0, unknown: 2 }));

  // ── 正例：正常压缩结果 → 所有检查必须全过 ──
  const good = {
    stats: { before: 10097, after: 1489, kept: 30, ratio: 0.15 },
    keyFacts: ['约束', '错误', '结论'],
    output: [
      { text: 'Error: ENOENT no such file' },
      { text: '必须用 pnpm，不要用 npm' },
      { text: '因此决定用 pnpm 并改写脚本' },
      { text: '最后一步：把结果汇总给我' },
      { text: '压缩摘要：省略 12 条', synthesized: true },
    ],
  };
  const goodOk =
    auditEffect(good, { budget: BUDGET }).every((c) => c.ok) &&
    auditOutputFacts(good).every((c) => c.ok) &&
    auditSummary(good).every((c) => c.ok) &&
    auditRefusal({ state: 'FAIL' }, { state: 'UNKNOWN' }).every((c) => c.ok) &&
    auditDeterminism(good, good)[0].ok &&
    judgeSelftest('结论: ✓ 12/12').allPass;
  T('正例 · 正常压缩结果 → 全部检查通过', goodOk, 'goodOk=' + goodOk);

  const bad = cases.filter(([, okv]) => !okv);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, okv, w]) => '  ' + (okv ? '✓' : '✗') + ' ' + n + (okv ? '' : '  ← ' + w)).join('\n'),
  };
}

// ══════════════════════════════════════════════════════════════
// CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (isMain && process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  A5 上下文压缩验收 · 自检（13 反例 + 1 正例）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

if (isMain) {
  let pass = 0, fail = 0, unknown = 0;
  const I = { ok: '✓', no: '✗', un: '❔' };
  const ok = (c, m) => { if (c) { pass++; console.log('  ' + I.ok + ' ' + m); } else { fail++; console.log('  ' + I.no + ' ' + m); } return c; };

  function run(args, timeout = 90000) {
    let out = '', code = 0;
    try {
      out = execFileSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { out = (e.stdout || '') + (e.stderr || ''); code = e.status ?? 2; }
    return { out, code };
  }

  console.log('');
  console.log('  A5 上下文压缩验收 —— 压缩后仍能做对事');
  console.log('  ' + '─'.repeat(72));

  ok(fs.existsSync(MJS), '压缩器在位（tools/context/compress.mjs）');

  // ── 1. 离线自检 ──
  const st = run([MJS, '--selftest']);
  const sj = judgeSelftest(st.out);
  ok(sj.hasConclusion, '自检有结论行');
  if (sj.hasConclusion) ok(sj.allPass, sj.line);

  // 关键能力必须在自检里覆盖
  for (const c of probeChecks(st.out)) ok(c.ok, c.label);

  // ── 2. 源码实现 ──
  const src = fs.readFileSync(MJS, 'utf8');
  for (const c of sourceChecks(src)) ok(c.ok, c.label);

  // ── 3. 可复算：同输入两次压缩结果一致 ──
  const mod = await import('file://' + MJS.replace(/\\/g, '/'));
  function mkItems() {
    const items = [{ role: 'system', text: '你是 agent。' + 'x'.repeat(400) }];
    for (let i = 0; i < 20; i++) {
      items.push({ role: 'user', text: '任务 ' + i + '：请帮我看看 ' + 'y'.repeat(200) });
      items.push({ role: 'assistant', text: '好的，我先读文件 ' + i + '。' + 'z'.repeat(200) });
      items.push({ role: 'tool', text: '文件内容 ' + i + '：' + 'w'.repeat(1500) });
    }
    items[10] = { role: 'tool', text: 'Error: ENOENT no such file: config.json —— 路径拼错了' + 'e'.repeat(100) };
    items[5] = { role: 'user', text: '必须用 pnpm，不要用 npm。' + 'u'.repeat(150) };
    items[20] = { role: 'assistant', text: '因此决定用 pnpm 并改写脚本。' + 'd'.repeat(150) };
    items.push({ role: 'user', text: '最后一步：把结果汇总给我。' });
    items.push({ role: 'assistant', text: '好的，汇总中。' });
    items.push({ role: 'tool', text: '汇总完成：3 个文件已改。' });
    return items;
  }

  const r1 = mod.compress(mkItems(), { budget: BUDGET, keepRecent: 3 });
  const r2 = mod.compress(mkItems(), { budget: BUDGET, keepRecent: 3 });
  for (const c of auditDeterminism(r1, r2)) ok(c.ok, c.label);

  // ── 4. 效果实测（这些数字要能复算）──
  for (const c of auditEffect(r1, { budget: BUDGET })) ok(c.ok, c.label);

  // 关键事实真的在输出里
  for (const c of auditOutputFacts(r1)) ok(c.ok, c.label);

  // ── 5. 反假绿：压不下必须 FAIL ──
  const rTight = mod.compress(mkItems(), { budget: 30, keepRecent: 5 });
  const rBad = mod.compress(null, { budget: 100 });
  for (const c of auditRefusal(rTight, rBad)) ok(c.ok, c.label);

  // ── 6. 摘要段必须存在（结构化的证据）──
  for (const c of auditSummary(r1)) ok(c.ok, c.label);

  console.log('');
  console.log('  ' + '─'.repeat(72));
  console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
  console.log('');
  process.exit(exitCode({ fail, unknown }));
}
