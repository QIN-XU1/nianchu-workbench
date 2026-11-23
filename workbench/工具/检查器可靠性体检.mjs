#!/usr/bin/env node
// 工具/检查器可靠性体检.mjs —— 审计「检查器本身是否可信」
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（一次真实事故）
// ══════════════════════════════════════════════════════════════════════
//  2026-11-12 事故：
//
//    ① 文档命令体检 用错方法提取参数（只看 --help 的 stdout）
//    ② 于是把 AGENTS.local.md 里**正确**的
//         node 工具/回滚.mjs --snapshot --type ui
//       判成「参数不存在」
//    ③ 我信了它，把正确命令改成了错误的
//       node 工具/回滚.mjs --rollback <值> --diff <值>
//       而且还截断了字符串
//
//  实测证明原命令是对的：
//    node 工具/回滚.mjs --snapshot --type ui
//    → ✓ 界面 70 个文件 1336 KB  ui-2026-11-12T01-53-30
//
//  **一个错误的检查比没有检查更坏。**
//
//  所以需要一个工具，审计「检查器本身」是否用了不可靠的方法。
//
// ══════════════════════════════════════════════════════════════════════
//  审计的 5 种不可靠模式
// ══════════════════════════════════════════════════════════════════════
//  ① 只靠 --help stdout 提取信息
//     不是所有工具都实现 --help；没实现的会走默认分支，输出不含参数清单
//
//  ② 只检查文件存在，不检查内容
//     文件存在 ≠ 内容正确（_文件索引.md 存在但只有 4/9 场景有）
//
//  ③ chk 条件恒为 true（真代码里，不是注释/自测诱饵）
//     永远通过的检查 = 装饰
//
//  ④ 把环境状态当自测判据
//     环境波动会让检查时红时绿（硬规矩的负载检查就犯过）
//
//  ⑤ 自测里没有反例
//     没有反例的检查无法证明能失败
//
//  用法：
//    node 工具/检查器可靠性体检.mjs
//    node 工具/检查器可靠性体检.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const TOOLS = path.join(WB, '工具');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

// ⚠ 2026-11-12 修（破坏性验证抓出来的）：
//
//   原来靠文件名判断「这是不是检查器」：
//     [/哨兵\.mjs$/, /体检\.mjs$/, /验证\.mjs$/, /审计\.mjs$/, /回归\.mjs$/, /判定\.mjs$/]
//
//   问题：只要检查器换个名字就绕过审计。
//   实测：造一个 __decorative_probe__.mjs（里面 chk('永远通过', true)），
//        名字不匹配任何一条 → 直接被跳过 → 审计报「所有检查器可靠」。
//
//   正确判据：**文件里有 chk( 调用就是检查器**，与文件名无关。
//   （工具名只是约定，不能当判据）
const CHECK_CATS = null;   // 不再用文件名判断

/**
 * 剥离注释和字符串，只留「真代码」
 * 这样能区分「真代码里恒 true」和「注释/自测诱饵里的 true」
 */
export function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    // 行注释
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // 块注释
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // 字符串
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      out += '""';   // 用空字符串占位，保留 token 边界
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 剥离 selftest 函数体（自测里常有故意的诱饵） */
export function stripSelftest(src) {
  const i = src.search(/function\s+selftest\s*\(/);
  if (i < 0) return src;
  let depth = 0, started = false, end = src.length;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') { depth++; started = true; }
    else if (src[k] === '}') { depth--; if (started && depth === 0) { end = k + 1; break; } }
  }
  return src.slice(0, i) + src.slice(end);
}

/**
 * 审计一个检查器
 * @returns {{ file, issues: [{id, name, why, fix, samples}] }}
 */
export function auditChecker(file, rawSrc) {
  const issues = [];

  // 判据：有 chk( 调用就是检查器（不靠文件名）
  //
  // ⚠ 2026-11-12 修（重复行 + 自测断言写错）
  //   ① 这一行原来写了两遍（复制粘贴残留）
  //   ② 自测【六】用 'chk("x", true);' 当「非检查类工具」的样本 ——
  //      但那个样本里**有 chk(**，所以 skipped 永远是 false，断言必然红。
  //      正确的反例样本应该是「完全没有 chk( 的文件」。
  if (!/chk\s*\(/.test(rawSrc)) return { file, issues, skipped: true };

  const code = stripCommentsAndStrings(rawSrc);
  const codeNoSelf = stripSelftest(code);

  // ① 只靠 --help stdout
  if (/execFileSync\(/.test(codeNoSelf) && /['"]--help['"]/.test(rawSrc)) {
    // 检查是否同时从源码提取（有 readFileSync 该工具文件）
    const hasSrcRead = /readFileSync\(toolFile|readFileSync\([^)]*\.mjs/.test(rawSrc);
    if (!hasSrcRead) {
      issues.push({
        id: 'help-stdout',
        name: '只靠 --help stdout 提取信息',
        why: '不是所有工具都实现 --help；没实现的会走默认分支，输出不含参数清单',
        fix: '从源码字符串字面量提取，--help 只作补充',
      });
    }
  }

  // ③ chk 条件恒为 true（真代码里，排除注释/自测诱饵）
  //
  // ⚠ 2026-11-12 两处改进（都记下来，避免重犯）：
  //
  //   改进1：成功分支里的 chk(..., true) 是**正确写法**，不算装饰：
  //     try { cookie = await getCookie(); }
  //     catch (e) { chk('引擎可连接', false); return; }
  //     chk('引擎可连接', true);      ← 能走到这里本身就证明成功了
  //   判据：同名 chk 是否出现过 false 分支。出现过 → true 合理。
  //
  //   改进2：不能在「剥离字符串后」的代码上匹配 ——
  //     剥离会把 chk('名字', true) 变成 chk("", true)，
  //     正则要求名字 >= 2 字符就永远匹配不到 → 检查失效。
  //   正确做法：在**原文**上匹配，然后用「注释区间表」排除注释里的匹配。
  const commentRanges = [];
  {
    let i = 0;
    const n = rawSrc.length;
    while (i < n) {
      const ch = rawSrc[i];
      const nx = rawSrc[i + 1];
      if (ch === '/' && nx === '/') {
        const start = i;
        while (i < n && rawSrc[i] !== '\n') i++;
        commentRanges.push([start, i]);
        continue;
      }
      if (ch === '/' && nx === '*') {
        const start = i;
        i += 2;
        while (i < n - 1 && !(rawSrc[i] === '*' && rawSrc[i + 1] === '/')) i++;
        i += 2;
        commentRanges.push([start, i]);
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        const q = ch;
        i++;
        while (i < n) {
          if (rawSrc[i] === '\\') { i += 2; continue; }
          if (rawSrc[i] === q) { i++; break; }
          i++;
        }
        continue;
      }
      i++;
    }
  }
  const inComment = (pos) => commentRanges.some(([a, b]) => pos >= a && pos < b);

  // 自测区间（自测里常有故意的诱饵）
  let selfStart = -1;
  let selfEnd = -1;
  {
    const si = rawSrc.search(/function\s+selftest\s*\(/);
    if (si >= 0) {
      selfStart = si;
      let depth = 0, started = false;
      for (let k = si; k < rawSrc.length; k++) {
        if (rawSrc[k] === '{') { depth++; started = true; }
        else if (rawSrc[k] === '}') { depth--; if (started && depth === 0) { selfEnd = k + 1; break; } }
      }
    }
  }
  const inSelf = (pos) => selfStart >= 0 && selfEnd > selfStart && pos >= selfStart && pos < selfEnd;

  const trueMatches = [...rawSrc.matchAll(/chk\s*\(\s*['"]([^'"]{2,60})['"]\s*,\s*true\s*[,)]/g)]
    .filter((m) => {
      // 排除注释里的 / 自测里的
      if (inComment(m.index)) return false;
      if (inSelf(m.index)) return false;
      // 排除有同名 false 分支的（那是成功分支的正确写法）
      const nm = m[1];
      const hasFalse = rawSrc.includes("chk('" + nm + "', false") ||
                       rawSrc.includes('chk("' + nm + '", false');
      return !hasFalse;
    });

  if (trueMatches.length) {
    issues.push({
      id: 'always-true',
      name: 'chk 条件恒为 true 且无同名失败分支（' + trueMatches.length + ' 处）',
      why: '永远通过的检查 = 装饰',
      fix: '改用真实判据，或补一个同名 false 分支',
      samples: trueMatches.slice(0, 3).map((m) => m[1]),
    });
  }

  // ④ 环境状态当判据
  const envChks = [...codeNoSelf.matchAll(/chk\s*\(\s*['"]([^'"]{0,60})['"]\s*,\s*[^)]*(?:负载|内存|可用|freeMem|loadavg)/g)];
  if (envChks.length) {
    issues.push({
      id: 'env-dependent',
      name: '把环境状态当自测判据（' + envChks.length + ' 处）',
      why: '环境波动会让检查时红时绿，代码没问题却报错',
      fix: '用假数据验证判据边界，真实状态只作报告',
      samples: envChks.slice(0, 3).map((m) => m[1]),
    });
  }

  // ⑤ 自测无反例
  const hasSelf = /--selftest/.test(rawSrc) || /function selftest/.test(rawSrc);
  const hasCounter = /反例|应当失败|必须失败|不该|不许|拒绝|会红|证伪|否定|负例/.test(rawSrc);
  if (hasSelf && !hasCounter) {
    issues.push({
      id: 'no-counter',
      name: '自测里没有反例',
      why: '没有反例的检查无法证明能失败',
      fix: '补「改回旧写法必须失败」的反例',
    });
  }

  return { file, issues, skipped: false };
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  检查器可靠性体检 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】注释和字符串剥离');
  {
    const src = [
      "// chk('注释里的', true)",
      "/* chk('块注释里的', true) */",
      "chk('真代码里的', a === b);",
    ].join('\n');
    const stripped = stripCommentsAndStrings(src);
    chk('剥离行注释', !stripped.includes('注释里的'));
    chk('剥离块注释', !stripped.includes('块注释里的'));
    // ⚠ 剥离函数会把字符串内容替换成 ""，所以不能检查字符串内容\n    //   应该检查「代码结构是否保留」（chk( 调用还在）\n    chk('保留真代码结构', /chk\\s*\\(/.test(stripped));
  }

  console.log();
  console.log('【二】selftest 剥离');
  {
    const src = [
      'function other() { chk("a", x); }',
      'function selftest() { chk("诱饵", true); }',
      'function tail() { chk("b", y); }',
    ].join('\n');
    const s = stripSelftest(src);
    chk('剥离 selftest 内的 chk', !s.includes('诱饵'));
    chk('保留其他函数的 chk', s.includes('"a"') && s.includes('"b"'));
  }

  console.log();
  console.log('【三】反例：真代码里的恒 true 必须被抓出来');
  {
    const src = [
      '#!/usr/bin/env node',
      '// 这是检查工具',
      'function main() {',
      "  chk('当前负载', true, '只是打印');",
      '}',
      'function selftest() {',
      "  chk('反例：该失败', !x);",
      '}',
    ].join('\n');
    const r = auditChecker('测试体检.mjs', src);
    const hit = r.issues.find((i) => i.id === 'always-true');
    chk('反例：抓到真代码里的恒 true', !!hit, hit ? hit.name : '没抓到');
  }

  console.log();
  console.log('【四】不应误报：注释/自测诱饵里的 true');
  {
    const src = [
      '#!/usr/bin/env node',
      '// chk("假的检查", true)   ← 注释里的',
      'function main() {',
      "  chk('真检查', a === b);",
      '}',
      'function selftest() {',
      "  chk('假的检查', true);   // 自测诱饵",
      '}',
    ].join('\n');
    const r = auditChecker('干净体检.mjs', src);
    const hit = r.issues.find((i) => i.id === 'always-true');
    chk('不误报注释/自测诱饵', !hit, hit ? '竟然报了: ' + hit.name : '正确跳过');
  }

  console.log();
  console.log('【五】反例：无反例的自测必须被抓');
  {
    const src = [
      '#!/usr/bin/env node',
      'function main() { chk("a", x === 1); }',
      'function selftest() { chk("正例", y === 2); }',
    ].join('\n');
    const r = auditChecker('无自测体检.mjs', src);
    const hit = r.issues.find((i) => i.id === 'no-counter');
    chk('反例：抓到「自测无反例」', !!hit, hit ? hit.name : '没抓到');
  }

  console.log();
  console.log('【六】非检查类工具应跳过');
  {
    // ⚠ 2026-11-12 修（这条断言原来必然红）
    //
    //   原来：auditChecker('某个普通工具.mjs', 'chk("x", true);')
    //        然后 chk('非检查类工具被跳过', r.skipped === true)
    //
    //   但样本里**有 chk(** —— 按判据（有 chk( 就是检查器）它不会被 skip，
    //   所以 skipped 永远是 false，这条断言必然失败。
    //
    //   正确做法：样本必须真的「没有 chk(」。
    const r = auditChecker('某个普通工具.mjs', 'function main() { console.log("hello"); }');
    chk('非检查类工具被跳过', r.skipped === true, 'skipped=' + r.skipped);

    // 反例：有 chk( 的不能被跳过（否则真检查器会被放走）
    const r2 = auditChecker('某个体检.mjs', 'chk("x", true);');
    chk('反例：有 chk( 不能被跳过', r2.skipped === false, 'skipped=' + r2.skipped);
  }

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('='.repeat(72));
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { selftest(); return; }

  const files = fs.readdirSync(TOOLS).filter((f) => f.endsWith('.mjs'));
  const results = [];

  // 排除自指：审计类的工具会把自己的测试诱饵当成问题
  // ⚠ 加上 破坏性验证.mjs：它自己也要造探针、跑检查，会被自指误报
  const SELF_SKIP = ['检查器可靠性体检.mjs', '检查真实性审计.mjs', '破坏性验证.mjs'];
  for (const f of files) {
    if (SELF_SKIP.includes(f)) continue;
    let c = '';
    try { c = fs.readFileSync(path.join(TOOLS, f), 'utf8'); } catch { continue; }
    const r = auditChecker(f, c);
    if (!r.skipped && r.issues.length) results.push(r);
  }

  console.log('='.repeat(80));
  console.log('  检查器可靠性体检 —— 检查器本身是否可信');
  console.log('='.repeat(80));
  console.log();
  console.log('  扫描: ' + files.length + ' 个工具');
  console.log('  有问题的检查器: ' + results.length + ' 个');
  console.log();

  if (!results.length) {
    console.log('  ✓ 没发现问题');
  } else {
    const byIssue = {};
    for (const r of results) {
      for (const i of r.issues) {
        if (!byIssue[i.id]) byIssue[i.id] = { ...i, files: [] };
        byIssue[i.id].files.push(r.file);
      }
    }
    for (const [id, info] of Object.entries(byIssue)) {
      console.log('  【' + info.name + '】' + info.files.length + ' 个');
      console.log('    为什么是问题: ' + info.why);
      console.log('    怎么修: ' + info.fix);
      info.files.forEach((f) => console.log('      · ' + f));
      console.log();
    }
  }

  console.log('-'.repeat(80));
  console.log('  结果: ' + (results.length === 0 ? '✓ 所有检查器可靠' : '⚠ ' + results.length + ' 个检查器需复核'));
  if (results.length) process.exitCode = 1;
  console.log('='.repeat(80));
}

main();
