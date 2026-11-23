#!/usr/bin/env node
/**
 * 突变承重验证 —— 证明「断言真的会红」
 *
 * ── 为什么需要它 ────────────────────────────────────────
 * 2026-11-16 我自己犯过一次：给 audit-coverage.mjs 加了 2 条「伴生断言」，
 * 自检条数 8→10 看起来是改进，但独立验证方 v-h0081 证明**检出能力增量恒为 0** ——
 * 新断言的实参与已有断言逐字符相同，谓词还被已有断言严格蕴涵。
 *
 * `tools/evolve/audit-false-red.mjs` 判 PASS 靠的是「文本里有『正例』和『反例』」，
 * 那是标签匹配，`T('x', true)` 也能过。**要证明断言承重，只有突变这一条路**：
 * 把被测函数改坏，看自检是否变红。
 *
 * ── 这个脚本做什么 ────────────────────────────────────────
 * 读 tools/evolve/mutation-specs.json，逐条：
 *   ① 备份原文件内容（内存）
 *   ② 应用 find→replace（必须唯一命中，且 replace 含 [fault]）
 *   ③ 跑该文件的 --selftest
 *   ④ **期望退出码非 0**（说明自检抓住了这次失效）
 *   ⑤ 无论成败，立刻用内存备份还原
 *   ⑥ 还原后再跑一次，期望退出码为 0（证明还原干净）
 *
 * ── 四态 ────────────────────────────────────────────────
 *   PASS     全部突变都让自检变红，且还原后全绿
 *   FAIL     有突变没让自检变红（该文件的断言不承重）
 *   WARN     还原后自检不是绿的（可能本来就有问题，或还原失败）
 *   UNKNOWN  规格文件读不出来
 *
 * 用法：node tools/evolve/verify-mutation.mjs [--selftest] [--only <name>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const SPECS = path.join(REPO, 'tools/evolve/mutation-specs.json');
const NODE = process.execPath;

/**
 * 纯函数：校验一条规格的形状
 * 抽出来便于自检，不需要真去改文件。
 */
export function validateSpec(spec) {
  const problems = [];
  if (!spec || typeof spec !== 'object') return ['规格不是对象'];
  if (!spec.file) problems.push('缺 file');
  if (!spec.name) problems.push('缺 name');
  if (!spec.find) problems.push('缺 find');
  const vs = Array.isArray(spec.variants) ? spec.variants : null;
  if (!vs && !spec.replace) problems.push('缺 replace（或 variants）');
  if (vs) {
    if (!vs.length) problems.push('variants 为空');
    vs.forEach((v, i) => {
      if (!v || !v.replace) problems.push('variants[' + i + '] 缺 replace');
      else if (!String(v.replace).includes('[fault]')) {
        problems.push('variants[' + i + '] 里没有 [fault] 标记');
      } else if (!String(v.replace).startsWith(String(spec.find || ''))) {
        problems.push('variants[' + i + '] 不以 find 开头');
      }
    });
    return problems;
  }
  if (spec.replace && !String(spec.replace).includes('[fault]')) {
    problems.push('replace 里没有 [fault] 标记（无法确认注入成功）');
  }
  if (spec.find && spec.replace && spec.find === spec.replace) {
    problems.push('find 与 replace 相同（等于没改）');
  }
  if (spec.replace && !String(spec.replace).startsWith(String(spec.find || ''))) {
    problems.push('replace 不以 find 开头（不是「在 find 后追加」的形态，可能替换掉整段）');
  }
  return problems;
}

/** 崩溃痕迹：命中说明 exit!=0 来自未捕获异常，不是断言判否 */
const CRASH_RE = /TypeError|ReferenceError|SyntaxError|RangeError|Cannot read|is not defined|is not a function|Unexpected token/;

/**
 * 从 selftest 输出里数出通过/失败断言数
 *
 * 【2026-11-16 修】原实现把结论行 `结论: ✗ N 项不成立` 的 ✗ 也数进去，
 * 导致每条都系统性 +1（独立验证方 v-h0123 实测 8 个文件全部恰好多 1）。
 * 现在先剔除结论行再数。
 */
export function countAssertions(out) {
  const s = String(out || '');
  const body = s.split('\n').filter((l) => !/^\s*结论\s*[:：]/.test(l)).join('\n');
  return { pass: (body.match(/✓/g) || []).length, fail: (body.match(/✗/g) || []).length };
}

/**
 * 规格归一化：把「单 find/replace」与「多变体」统一成 variants 数组
 * 这样旧格式不用改，新格式能表达「同一函数的多种失效形态」。
 */
export function normalizeVariants(spec) {
  if (Array.isArray(spec.variants) && spec.variants.length) {
    return spec.variants.map((v) => ({ replace: v.replace, note: v.note || '' }));
  }
  return [{ replace: spec.replace, note: '（单变体）' }];
}

/**
 * 纯函数：一次突变的结果判定
 *
 * 【2026-11-16 修】原版只看 exit!=0 就算「断言承重」，被独立验证方 v-h0121 证明是错的：
 *   · buildGraph 突变后抛 TypeError（读 .deg），断言层只跑到第 2/8 条 —— 崩溃不算承重
 *   · computeBackoff 突变后 ✓0 ✗0，连自检都没跑起来 —— 更不算
 * 现在要求同时满足：**没有崩溃痕迹** + **至少有 1 条断言失败** + **没有超时**。
 */
export function judgeMutation({ mutatedExit, restoredExit, mutatedOut = '', timedOut = false }) {
  if (timedOut) {
    return { state: 'UNKNOWN', why: '自检超时 —— 跑不完不能算承重' };
  }
  if (mutatedExit === 0) {
    return {
      state: 'FAIL',
      why: '把被测函数改坏后自检仍然全绿 ⇒ 断言**不承重**（或全是恒真）',
    };
  }
  // 【2026-11-16 修】原来只在「崩溃且无 ✗」时判 FAIL —— 既崩溃又有 ✗ 会误判 PASS。
  // 现在崩溃一律 FAIL：崩溃说明自检没跑完，后面的断言根本没执行。
  const crash = CRASH_RE.test(mutatedOut);
  const c = countAssertions(mutatedOut);
  if (crash) {
    return {
      state: 'FAIL',
      why: 'exit!=0 含**崩溃**（' + (String(mutatedOut).match(CRASH_RE) || [''])[0]
        + '），自检没跑完 —— 崩溃不算承重'
        + (c.fail ? '（注：崩溃前已红 ' + c.fail + ' 条，但那之后未执行）' : ''),
    };
  }
  if (c.fail === 0) {
    return {
      state: 'FAIL',
      why: 'exit!=0 但没有任何 ✗ 断言、也没有崩溃痕迹 ⇒ 自检根本没跑到判定点',
    };
  }
  if (restoredExit !== 0) {
    return { state: 'WARN', why: '还原后自检不是绿的（exit=' + restoredExit + '）—— 可能本来就有问题' };
  }
  return {
    state: 'PASS',
    why: '断言变红 ' + c.fail + ' 条（+' + c.pass + ' 条仍绿），还原后全绿',
  };
}

/** 自检 —— 2 正例 + 5 反例 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);
  const good = {
    file: 'x.mjs', name: 'n',
    find: 'export function f() {',
    replace: 'export function f() {\n  return 0; // [fault]',
  };

  // 正例
  T('正例 · 合规规格 ⇒ 无问题', validateSpec(good).length === 0, JSON.stringify(validateSpec(good)));
  T('正例 · 突变后红（有 ✗ 断言）且还原后绿 ⇒ PASS',
    judgeMutation({ mutatedExit: 1, restoredExit: 0,
      mutatedOut: '  ✗ 某条  ← 红了' }).state === 'PASS', '');

  // 反例
  T('反例 · replace 里没有 [fault] ⇒ 报出（无法确认注入成功）',
    validateSpec({ ...good, replace: 'export function f() {\n  return 0;' })
      .some((p) => /fault/.test(p)), '');
  T('反例 · find 与 replace 相同 ⇒ 报出（等于没改）',
    validateSpec({ ...good, replace: good.find }).some((p) => /相同/.test(p)), '');
  T('反例 · replace 不以 find 开头 ⇒ 报出（可能替换掉整段）',
    validateSpec({ ...good, replace: 'something else // [fault]' })
      .some((p) => /开头/.test(p)), '');
  T('反例 · 突变后自检仍绿 ⇒ FAIL（断言不承重）',
    judgeMutation({ mutatedExit: 0, restoredExit: 0 }).state === 'FAIL', '');

  // 【2026-11-16 加】独立验证方 v-h0121 打出的三个真缺陷 —— 必须被钉住
  // 【2026-11-16 加】验证方 v-h0123 打出的判据 bug：既崩溃又有 ✗ 曾能骗过 PASS
  T('反例 · 既崩溃又有 ✗ 断言 ⇒ 仍判 FAIL（崩溃说明后面没跑完）',
    judgeMutation({ mutatedExit: 1, restoredExit: 0,
      mutatedOut: '  ✗ 某条\nTypeError: boom' }).state === 'FAIL', '崩溃被 ✗ 掩盖了');
  // 【2026-11-16 加】结论行的 ✗ 不许计入断言数
  T('反例 · 结论行的 ✗ 不许计入断言数（否则每条系统性 +1）',
    countAssertions('  ✓ a\n  ✗ b\n  结论: ✗ 1 项不成立').fail === 1, '');
  T('反例 · 只在崩溃、没有 ✗ 断言 ⇒ 不算承重（buildGraph 就是这种）',
    judgeMutation({ mutatedExit: 1, restoredExit: 0,
      mutatedOut: 'TypeError: Cannot read properties of undefined (reading \'deg\')' }).state === 'FAIL',
    '崩溃被误当承重');
  T('反例 · exit!=0 但既无 ✗ 也无崩溃 ⇒ 不算承重（自检没跑到判定点）',
    judgeMutation({ mutatedExit: 1, restoredExit: 0, mutatedOut: 'some noise' }).state === 'FAIL', '');
  T('反例 · 超时 ⇒ UNKNOWN，不许当承重',
    judgeMutation({ mutatedExit: 1, restoredExit: 0, timedOut: true }).state === 'UNKNOWN', '');
  T('正例 · 有 ✗ 且无崩溃 ⇒ 才算 PASS',
    judgeMutation({ mutatedExit: 1, restoredExit: 0,
      mutatedOut: '  ✗ 反例 · 某某  ← 期望 1 实际 0\n  结论: ✗ 1 项不成立' }).state === 'PASS', '');
  T('反例 · 还原后不绿 ⇒ WARN（不许当 PASS）',
    judgeMutation({ mutatedExit: 1, restoredExit: 1,
      mutatedOut: '✗ 某条' }).state === 'WARN', '');
  T('正例 · countAssertions 能数出 ✓ 与 ✗',
    (() => { const c = countAssertions('  ✓ a\n  ✗ b\n  ✓ c'); return c.pass === 2 && c.fail === 1; })(), '');
  T('反例 · 空规格 ⇒ 报出（不许静默通过）',
    validateSpec(null).length > 0, '');

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

// 进程级保险：如果万一在还原前被打断，尽力把文件写回原内容
let PENDING = null;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (PENDING) {
      try { fs.writeFileSync(PENDING.abs, PENDING.orig, 'utf8'); } catch { /* 尽力而为 */ }
    }
    process.exit(130);
  });
}
process.on('uncaughtException', (e) => {
  if (PENDING) {
    try { fs.writeFileSync(PENDING.abs, PENDING.orig, 'utf8'); } catch { /* 尽力而为 */ }
  }
  console.log('  ❌ 未捕获异常（已尝试还原）: ' + e.message);
  process.exit(1);
});

function runSelftest(file) {
  // 需要拿到输出才能区分「断言变红」与「崩溃变红」，所以不能 stdio:'ignore'
  try {
    const out = execFileSync(NODE, [path.join(REPO, file), '--selftest'],
      { cwd: REPO, encoding: 'utf8', timeout: 600000 });
    return { exit: 0, out: out || '', timedOut: false };
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '');
    const timedOut = e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM';
    return { exit: typeof e.status === 'number' && e.status !== 0 ? e.status : 1, out, timedOut };
  }
}

const isMain = /[\\/]verify-mutation\.mjs$/.test(process.argv[1] || '');

if (isMain && process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  突变承重验证 · 自检');
  console.log('  ' + '─'.repeat(70));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

if (isMain) {
  let specs;
  try {
    specs = JSON.parse(fs.readFileSync(SPECS, 'utf8')).specs || [];
  } catch (e) {
    console.log('  ❔ 规格文件读不出来: ' + e.message);
    process.exit(2);
  }

  const argv = process.argv;
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
  const use = only ? specs.filter((s) => (s.name || '').includes(only)) : specs;

  console.log('');
  console.log('  突变承重验证 —— 证明断言真的会红，不是靠数标签');
  console.log('  ' + '='.repeat(76));
  console.log('  规格 ' + use.length + ' 条' + (only ? '（筛选：' + only + '）' : ''));
  console.log('');

  const results = [];
  for (const spec of use) {
    const shape = validateSpec(spec);
    if (shape.length) {
      console.log('  ⚠ ' + spec.name + ' —— 规格不合格: ' + shape.join('; '));
      results.push({ ...spec, state: 'UNKNOWN', why: shape.join('; ') });
      continue;
    }
    const abs = path.join(REPO, spec.file);
    let orig;
    try { orig = fs.readFileSync(abs, 'utf8'); }
    catch (e) {
      console.log('  ⚠ ' + spec.name + ' —— 文件读不出来: ' + spec.file);
      results.push({ ...spec, state: 'UNKNOWN', why: '文件读不出来' });
      continue;
    }
    const cnt = orig.split(spec.find).length - 1;
    if (cnt !== 1) {
      console.log('  ⚠ ' + spec.name + ' —— find 命中 ' + cnt + ' 次（需恰好 1 次）');
      results.push({ ...spec, state: 'UNKNOWN', why: 'find 命中 ' + cnt + ' 次' });
      continue;
    }

    // 逐变体注入：同一函数的不同失效形态都必须被抓住
    const variants = normalizeVariants(spec);
    const vResults = [];
    for (let vi = 0; vi < variants.length; vi++) {
      const vv = variants[vi];
      const mutated = orig.replace(spec.find, vv.replace);
      if (!mutated.includes('[fault]')) {
        vResults.push({ state: 'UNKNOWN', why: '注入后找不到 [fault] 标记', note: vv.note });
        continue;
      }
      let mr = { exit: 1, out: '', timedOut: false };
      try {
        fs.writeFileSync(abs, mutated, 'utf8');
        PENDING = { abs, orig };
        mr = runSelftest(spec.file);
      } finally {
        fs.writeFileSync(abs, orig, 'utf8');
        PENDING = null;
      }
      const rr = runSelftest(spec.file);
      const after = fs.readFileSync(abs, 'utf8');
      if (after !== orig) {
        vResults.push({ state: 'FAIL', why: '还原失败，文件被污染', note: vv.note });
        break;
      }
      const v = judgeMutation({ mutatedExit: mr.exit, restoredExit: rr.exit,
        mutatedOut: mr.out, timedOut: mr.timedOut });
      vResults.push({ ...v, note: vv.note, mutatedExit: mr.exit, restoredExit: rr.exit });
    }

    const worst = vResults.some((x) => x.state === 'FAIL') ? 'FAIL'
      : vResults.some((x) => x.state === 'WARN') ? 'WARN'
      : vResults.some((x) => x.state === 'UNKNOWN') ? 'UNKNOWN' : 'PASS';
    const summary = vResults.map((x) => (x.state === 'PASS' ? '✓' : '✗')
      + (x.note ? ' ' + x.note.slice(0, 22) : '')).join(' | ');
    results.push({ ...spec, state: worst,
      why: vResults.map((x) => x.why).join(' ；'),
      variants: vResults });
    console.log('  ' + (worst === 'PASS' ? '✓' : worst === 'FAIL' ? '❌' : '⚠')
      + ' ' + spec.name.padEnd(34) + ' ' + worst.padEnd(5) + ' ' + vResults.length
      + ' 变体 · ' + summary.slice(0, 52));
  }

  const by = { PASS: [], FAIL: [], WARN: [], UNKNOWN: [] };
  for (const r of results) by[r.state].push(r);

  console.log('');
  console.log('  ' + '─'.repeat(76));
  console.log('  PASS ' + by.PASS.length + ' · FAIL ' + by.FAIL.length
    + ' · WARN ' + by.WARN.length + ' · UNKNOWN ' + by.UNKNOWN.length);
  console.log('');

  const op = path.join(REPO, 'evidence/evolve/mutation-load-bearing.json');
  fs.mkdirSync(path.dirname(op), { recursive: true });
  fs.writeFileSync(op, JSON.stringify({
    at: new Date().toISOString(),
    total: results.length,
    pass: by.PASS.length, fail: by.FAIL.length, warn: by.WARN.length, unknown: by.UNKNOWN.length,
    rows: results,
  }, null, 2) + '\n', 'utf8');
  console.log('  → ' + path.relative(REPO, op));
  console.log('');

  process.exit(by.FAIL.length || by.UNKNOWN.length ? 1 : 0);
}
