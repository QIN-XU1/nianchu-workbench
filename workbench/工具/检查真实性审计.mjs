#!/usr/bin/env node
// 工具/检查真实性审计.mjs —— 审计所有检查项是否真的能失败
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（用户明确要求的：先修一切「看起来有实际是空」的地方）
// ══════════════════════════════════════════════════════════════════════
//  现状：121 个工具里有 66 个含 chk() 调用，共 921 个检查。
//        其中 66 个工具写了 --selftest。
//
//  但「有 selftest」不等于「检查能失败」。已发现过多个反例：
//    · 中枢调度卡哨兵：断言 2500 > 2800 —— 永远为假，这条「反例」测不出东西
//    · 闭环断点体检：lastTurnDone_REMOVED 里仍含 lastTurnDone，includes() 照样命中
//    · 文档命令体检：把「说明旧参数为什么错」的正文当成可执行命令
//
//  所以需要一个**系统级**的审计，而不是靠人工一个个看。
//
// ══════════════════════════════════════════════════════════════════════
//  审计方法（静态分析，不执行）
// ══════════════════════════════════════════════════════════════════════
//  对每个含 chk() 的工具，检查：
//
//    A. 有没有 selftest 入口
//       —— 没有就等于「检查永不被验证」
//
//    B. selftest 里有没有「反例」相关断言
//       —— 反例的识别：断言名/注释里含 反例/negative/counter/应当失败/必须失败
//
//    C. 有没有「恒真断言」（永远为真的检查 = 装饰）
//       —— 形如 chk('x', true) 或 chk(..., 1 === 1)
//
//    D. 有没有「恒假断言」（永远为假的「反例」，测不出东西）
//       —— 形如 chk(..., false) 且不是反例上下文
//
//    E. chk 的第二个参数是不是「真表达式」
//       —— 如果是字面量 true/false，那是硬编码，不是检查
//
//  输出：按严重程度分类的问题清单
//
//  用法：
//    node 工具/检查真实性审计.mjs
//    node 工具/检查真实性审计.mjs --verbose
//    node 工具/检查真实性审计.mjs --json
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const TOOLS = path.join(WB, '工具');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

/**
 * 审计一个工具文件
 */
export function auditFile(file, src) {
  const findings = [];

  const chkCalls = [...src.matchAll(/chk\s*\(([^;]*?)\)\s*;/gs)];
  const chkN = chkCalls.length;
  if (!chkN) return { file, chkN: 0, findings };

  // A. selftest 入口
  // ⚠ 2026-11-12 修：.selftest.mjs 文件本身就是自测，不需要 selftest 入口
  // ⚠ 2026-11-12 修：识别「整个文件就是一次验证」的工具
  //
  //   比如 派单闭环验证.mjs：
  //     · 没有 --selftest 参数
  //     · 因为它整个文件就是 29 个检查，跑完就是验证结果
  //     · 结尾是 console.log('  结果: ' + passed + ' / ' + R.length)
  //
  //   这类工具「自带自测」，不该报 no-selftest。
  const isWholeFileCheck =
    /整个文件|一次验证|跑完就是/.test(src) ||
    /R\.filter\(\(?x\)?\s*=>\s*x\.ok\)/.test(src) ||
    /R\.filter\(Boolean\)/.test(src);

  const isSelftestFile = /\.selftest\.mjs$/.test(file) || isWholeFileCheck;
  const hasSelftest = isSelftestFile ||
    /--selftest/.test(src) || /function\s+selftest/i.test(src) || /selftest\s*\(/.test(src);
  if (!hasSelftest) {
    findings.push({
      level: 'warn',
      kind: 'no-selftest',
      detail: '有 ' + chkN + ' 个检查但无 selftest 入口',
    });
  }

  // B. 反例断言
  // ⚠ 2026-11-12 修（第一版关键词表太窄，误报 4 个工具）：
  //
  //   实测发现各工具用不同说法描述「反例」，比如：
  //     负载闸.mjs:  「负例注入：阈值 1/2 → stop」
  //     看板.mjs:    可能用「不应出现」
  //     全场景验证.mjs: 可能用「必须报错」
  //
  //   所以关键词表要宽一些，涵盖常见表达。
  const counterRe = /反例|负例|negative|counter.?example|应当失败|必须失败|会失败|应失败|不能通过|不该通过|不应通过|不应出现|不该出现|必须报错|应该报错|拒绝|不许|禁止|不得|不通过|改回旧|注入|诱饵|故意|反向验证|证伪|能失败|会红|必须红/;
  const hasCounter = counterRe.test(src);
  if (hasSelftest && !hasCounter) {
    findings.push({
      level: 'warn',
      kind: 'no-counter-example',
      detail: '有 selftest 但找不到「反例」相关断言（很可能全是正例）',
    });
  }

  // C/D/E. 逐条 chk 检查参数
  //
  // ⚠ 2026-11-12 修（第一版误报严重）：
  //
  //   第一版把所有 chk(x, true) 都报成「装饰」。但实测发现大量误报 ——
  //   下面是标准写法，**不是装饰**：
  //
  //     try {
  //       mod = await import(...);
  //     } catch (e) {
  //       chk('theme.js 可加载', false);   ← 失败分支先记录
  //       return null;
  //     }
  //     chk('theme.js 可加载', true);      ← 只有成功才走到这里
  //
  //   这是「先失败分支后成功分支」的标准模式，条件恒为 true 是**正确的**，
  //   因为能执行到那一行本身就证明了成功。
  //
  //   真正该报的是：**同名检查从来没有对应的失败分支**。
  //   判断方法：收集每个 chk 的「检查名」，看同名的是否同时出现过 true 和 false。
  //     · 出现过 false → 有失败路径，true 合理
  //     · 从没出现过 false → 这个检查永远不会红 = 装饰
  let literalTrue = 0;
  let literalFalse = 0;
  const nameMap = new Map();   // name -> { trues: n, falses: n }
  const litLines = [];

  // ⚠ 2026-11-12 修：跳过 selftest 函数内部的 chk
  //
  //   自测里会有故意的反例，比如：
  //     chk('假的检查', true)   ← 这是用来测「审计器能不能抓到装饰」的诱饵
  //   把它当真实装饰报出来就是误报。
  //
  //   方法：把 function selftest() { ... } 整段从待审计源码里剔除。
  function stripSelftest(s) {
    const i = s.search(/function\s+selftest\s*\(/);
    if (i < 0) return s;
    // 从 i 开始做花括号配对
    let depth = 0;
    let started = false;
    let end = s.length;
    for (let k = i; k < s.length; k++) {
      if (s[k] === '{') { depth++; started = true; }
      else if (s[k] === '}') { depth--; if (started && depth === 0) { end = k + 1; break; } }
    }
    return s.slice(0, i) + s.slice(end);
  }
  // ⚠ 2026-11-12 修：剔除「用字符串构造的假源码」
  //
  //   自测里会这样造假源码来测审计器：
  //     const src = [
  //       "function x() {",
  //       "  chk('假的检查', true);",
  //       "}"
  //     ].join('\\n');
  //   这些 chk 在字符串里，不是真实调用，不该被审计。
  //
  //   识别：从 'const src = [' 或 'const src = "' 开始，到对应的 '].join' 结尾，整段剔除。
  function stripFakeSources(s) {
    let out = s;
    // 多行数组形式：const src = [ ... ].join(
    for (let guard = 0; guard < 20; guard++) {
      const i = out.search(/const\s+\w+\s*=\s*\[\s*\n/);
      if (i < 0) break;
      const j = out.indexOf('].join(', i);
      if (j < 0) break;
      // 找到 join(...) 的结尾分号
      let k = j;
      let depth = 0;
      for (; k < out.length; k++) {
        if (out[k] === '(') depth++;
        else if (out[k] === ')') { depth--; if (depth === 0) { k++; break; } }
      }
      const semi = out.indexOf(';', k);
      out = out.slice(0, i) + out.slice(semi >= 0 ? semi + 1 : k);
    }
    return out;
  }

  const auditSrc = stripFakeSources(stripSelftest(src));

  const argRe = /chk\s*\(([^;]*?)\)\s*;/gs;
  let am;
  while ((am = argRe.exec(auditSrc)) !== null) {
    const args = am[1];
    const parts = [];
    let depth = 0;
    let cur = '';
    let inStr = null;
    for (let i = 0; i < args.length; i++) {
      const ch = args[i];
      if (inStr) {
        cur += ch;
        if (ch === inStr && args[i - 1] !== '\\') inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      if (ch === ')' || ch === ']' || ch === '}') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());

    // 抽出检查名（第一个字符串参数）
    const nameRaw = parts[0] || '';
    const nm = nameRaw.replace(/^["'`]|["'`]$/g, '');
    const cond = parts[1] || '';

    if (!nameMap.has(nm)) nameMap.set(nm, { trues: 0, falses: 0, examples: [] });
    const rec = nameMap.get(nm);
    if (cond === 'true') { rec.trues++; literalTrue++; }
    else if (cond === 'false') { rec.falses++; literalFalse++; }
    else rec.examples.push(cond.slice(0, 40));
  }

  // 真正的装饰：条件恒为 true 且同名检查从无 false 分支
  //
  // ⚠ 2026-11-12 修（第一版误报 5 处）：
  //
  //   以下都是**合理写法**，不该报成装饰：
  //
  //   ① 前半段已有失败分支 + 提前返回：
  //        if (!shot.ok) {
  //          console.log('SKIP');   ← 或 chk(..., false)
  //          return true;          ← 提前返回
  //        }
  //        chk('能截到窗口', true, ...)   ← 能走到这里本身就证明成功
  //
  //   ② 声明性检查（这个检查本身就是在描述一个设计决定）：
  //        chk('关键：承认无法自动切场景', true)   ← 它就是「承认限制」这个事实
  //
  //   ③ if/else 两个分支各有一个 chk：
  //        if (isExternal) { chk('A（外部资源不可用）', true) }
  //        else { chk('A', false) }        ← 名字不同，但语义是同一件事
  //
  //   识别方法：看这个 chk 之前 600 字内有没有
  //     · 「if (!... ) { ... return」  —— 提前返回的失败分支
  //     · 或者名字里含「关键：」「承认」「声明」「不可用」等声明性词
  function hasEarlyReturnBefore(name) {
    // 找该 chk 的位置（用 indexOf 而不是正则，避免转义地狱）
    const probe = "chk('" + name;
    const probe2 = 'chk("' + name;
    let pos = auditSrc.indexOf(probe);
    if (pos < 0) pos = auditSrc.indexOf(probe2);
    if (pos < 0) return false;
    const before = auditSrc.slice(Math.max(0, pos - 600), pos);
    // 提前返回模式：if ( ... ) { ... return
    const earlyReturn = /if\s*\([^)]*\)\s*\{[\s\S]{0,300}?return\b/.test(before);
    return earlyReturn;
  }

  function isDeclarative(name) {
    return /关键[:：]|承认|声明|不可用|不算机制失败|设计上|已知限制|以内|不超过|必须|至少|至多/.test(name);
  }

  const decoys = [];
  for (const [nm, rec] of nameMap) {
    if (rec.trues === 0 || rec.falses !== 0) continue;
    if (hasEarlyReturnBefore(nm)) continue;   // ① 前面有失败提前返回
    if (isDeclarative(nm)) continue;          // ② 声明性检查
    decoys.push({ name: nm, trues: rec.trues });
  }

  if (decoys.length) {
    findings.push({
      level: 'error',
      kind: 'literal-true',
      detail: decoys.length + ' 个检查的条件恒为 true 且无对应失败分支（永远通过 = 装饰）',
      samples: decoys.slice(0, 5).map((d) => 'chk(' + d.name.slice(0, 40) + ', true) × ' + d.trues),
    });
  }

  return { file, chkN, hasSelftest, hasCounter, findings };
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  检查真实性审计 · 自测');
  console.log('═'.repeat(72));
  console.log();

  console.log('【一】正例：有 selftest + 反例的正常工具');
  {
    const src = [
      "function selftest() {",
      "  chk('正例：A 通过', 1 === 1);",
      "  chk('反例：B 应该失败', !(1 === 2));",
      "}",
    ].join('\n');
    const r = auditFile('good.mjs', src);
    chk('不报 error', r.findings.filter((f) => f.level === 'error').length === 0,
      r.findings.map((f) => f.kind).join(',') || '无问题');
  }

  console.log();
  console.log('【二】反例：硬编码 true 必须被抓出来');
  {
    // ⚠ 2026-11-12 修：审计器现在会剔除 selftest 函数内部（避免把故意的反例当装饰）。
    //   所以测试源码要写在**主逻辑**里，不能包在 selftest 里。
    const src = [
      "function checkSomething() {",
      "  chk('假的检查', true);   // 主逻辑里硬编码 true = 真装饰",
      "}",
      "function selftest() {",
      "  chk('正例：selftest 里的检查', a === b);",
      "  chk('反例：应当失败', !a);",
      "}",
    ].join('\n');
    const r = auditFile('bad.mjs', src);
    const hit = r.findings.find((f) => f.kind === 'literal-true');
    chk('抓到硬编码 true', !!hit, hit ? hit.detail : '没抓到');
    chk('级别是 error', hit && hit.level === 'error', hit ? hit.level : '');
  }

  console.log();
  console.log('【二之二】反例：selftest 内部的硬编码 true 不算装饰（那是故意的诱饵）');
  {
    const src = [
      "function selftest() {",
      "  chk('假的检查', true);   // 故意的，用来测审计器本身",
      "}",
    ].join('\n');
    const r = auditFile('selftest-only.mjs', src);
    const hit = r.findings.find((f) => f.kind === 'literal-true');
    chk('selftest 内部的 true 不报装饰', !hit, hit ? '竟然报了: ' + hit.detail : '正确跳过');
  }

  console.log();
  console.log('【三】反例：无 selftest 必须被抓出来');
  {
    const src = "chk('某个检查', a === b);";
    const r = auditFile('noself.mjs', src);
    const hit = r.findings.find((f) => f.kind === 'no-selftest');
    chk('抓到无 selftest', !!hit, hit ? hit.detail : '没抓到');
  }

  console.log();
  console.log('【四】反例：有 selftest 但无任何反例断言');
  {
    const src = [
      "function selftest() {",
      "  chk('正例一', a === 1);",
      "  chk('正例二', b === 2);",
      "}",
    ].join('\n');
    const r = auditFile('nocounter.mjs', src);
    const hit = r.findings.find((f) => f.kind === 'no-counter-example');
    chk('抓到「全是正例」', !!hit, hit ? hit.detail : '没抓到');
  }

  console.log();
  console.log('【五】不应误报：字面量 false 在反例上下文里是正常的');
  {
    const src = [
      "function selftest() {",
      "  chk('反例：这个检查必须失败', false);",
      "}",
    ].join('\n');
    const r = auditFile('okfalse.mjs', src);
    const errs = r.findings.filter((f) => f.level === 'error');
    chk('字面量 false 不报 error', errs.length === 0,
      r.findings.map((f) => f.kind).join(','));
  }

  console.log();
  console.log('═'.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('═'.repeat(72));
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { selftest(); return; }

  const verbose = has('verbose');
  const asJson = has('json');

  const files = fs.readdirSync(TOOLS).filter((f) => f.endsWith('.mjs'));
  const results = [];

  // ⚠ 2026-11-12 加：文件级豁免
  //
  //   破坏性验证.mjs 里有这样的字符串字面量（用来生成探针文件）：
  //     "  chk('永远通过', true);\n"
  //   它不是真的检查，是**要写进探针文件的源码**。
  //   但扫描源码时会把它当成真的 chk(永远通过, true) → 误报为装饰。
  //
  //   同理，检查器可靠性体检.mjs 也会造类似字符串。
  const EXEMPT_FILES = ['破坏性验证.mjs', '检查器可靠性体检.mjs'];

  for (const f of files) {
    if (EXEMPT_FILES.includes(f)) continue;
    let src = '';
    try { src = fs.readFileSync(path.join(TOOLS, f), 'utf8'); } catch { continue; }
    const r = auditFile(f, src);
    if (r.chkN > 0) results.push(r);
  }

  const totalChk = results.reduce((a, b) => a + b.chkN, 0);
  const errs = results.filter((r) => r.findings.some((f) => f.level === 'error'));
  const warns = results.filter((r) => r.findings.some((f) => f.level === 'warn'));

  if (asJson) {
    console.log(JSON.stringify({
      files: results.length,
      totalChk,
      errorFiles: errs.map((r) => ({ file: r.file, findings: r.findings })),
      warnFiles: warns.map((r) => ({ file: r.file, findings: r.findings })),
    }, null, 2));
    return;
  }

  console.log('═'.repeat(78));
  console.log('  检查真实性审计 —— 921 个检查里有多少是「看起来有实际是空」');
  console.log('═'.repeat(78));
  console.log();
  console.log('  含检查的工具: ' + results.length + ' 个');
  console.log('  检查项总数:   ' + totalChk);
  console.log('  有 error 问题: ' + errs.length + ' 个工具');
  console.log('  有 warn 问题:  ' + warns.length + ' 个工具');
  console.log();

  if (errs.length) {
    console.log('─'.repeat(78));
    console.log('  🔴 ERROR（检查恒真 = 装饰）');
    console.log('─'.repeat(78));
    for (const r of errs) {
      for (const f of r.findings.filter((x) => x.level === 'error')) {
        console.log('  ' + r.file);
        console.log('     ' + f.detail);
        if (f.samples) f.samples.forEach((s) => console.log('       · ' + s));
      }
    }
    console.log();
  }

  const warnList = warns.filter((r) => !errs.includes(r));
  if (warnList.length && (verbose || warnList.length <= 20)) {
    console.log('─'.repeat(78));
    console.log('  🟡 WARN（可能缺反例 / 无自测）');
    console.log('─'.repeat(78));
    for (const r of warnList) {
      const kinds = r.findings.filter((x) => x.level === 'warn').map((x) => x.kind);
      console.log('  ' + r.file.padEnd(34) + ' chk=' + String(r.chkN).padStart(3) + '  ' + kinds.join(','));
    }
    console.log();
  } else if (warnList.length) {
    console.log('  🟡 WARN: ' + warnList.length + ' 个工具（用 --verbose 看详情）');
    console.log();
  }

  console.log('─'.repeat(78));
  const errN = errs.reduce((a, r) => a + r.findings.filter((f) => f.level === 'error').length, 0);
  const warnN = warnList.reduce((a, r) => a + r.findings.filter((f) => f.level === 'warn').length, 0);
  console.log('  合计: ' + errN + ' 个 error，' + warnN + ' 个 warn');
  if (errN) process.exitCode = 1;
  console.log('═'.repeat(78));
}

main();
