#!/usr/bin/env node
/**
 * 文档自检 —— 保证「文档里写的」和「仓库里真的」一致。
 *
 * 为什么需要：2026-11-20 写总纲时我写「20 项模块验证 / 500+ 判据」，
 * 实测是 28 项 / 509 条。**文档一旦和真实数字脱钩，它就是新的谎言。**
 *
 * 用法：
 *   node tools/quality/verify-docs.mjs           # 检查
 *   node tools/quality/verify-docs.mjs --fix     # 只报告不修改（默认）
 *
 * 退出码：0 全部一致 · 1 有不一致 · 2 自检失败（工具本身坏了）
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DOCS = ['README.md', '总纲.md', '架构.md', '构建与运行.md', '验证体系.md', '对标方法.md', '目录与模块.md'];

const problems = [];

/* ── 1. 文档里引用的「路径」必须真实存在 ──
 *
 * 2026-11-20 修：原正则只匹配行内代码（`...`），漏掉了代码块（```powershell ... ```）
 * 里的路径 —— 而 README 的主要命令全在代码块里，等于没检查。改成扫全文。 */
const PATH_RE = /(?:tools|apps|prototype|ui-plugins|research|evidence)[\\/][\w\\/\-.{}*]+/g;

/** 明显不是仓库路径的片段（示例/占位/外部仓库）——跳过，但要在注释里写明理由 */
const SKIP = [
  /^tools\\?[\\/]?agent[\\/]\$s\.mjs$/,        // 文档里的 $s 循环变量占位
  /^tools\\?[\\/]?agent[\\/]verify-\*\.mjs$/,  // 通配
  /^tools[\\/]qualityx/,                        // 反例注入用
];

/**
 * 外部仓库路径白名单 —— 这些是**对方项目**的文件，本仓库当然没有。
 * 出现在「对标方法.md」讲抽取器自检样例的那段里。
 * 加新条目必须写清「为什么它不是本仓库的路径」。
 */
const EXTERNAL = new Set([
  'apps/renderer/src/styles/tokens.css',   // luanyujia 的样式令牌文件，仅作抽取器样例
]);

for (const doc of DOCS) {
  const p = join(ROOT, doc);
  if (!existsSync(p)) { problems.push(`${doc}: 文件不存在`); continue; }
  const text = readFileSync(p, 'utf8');
  const seen = new Set();
  for (const m of text.matchAll(PATH_RE)) {
    const rel = m[0].replace(/\\/g, '/').replace(/[.,;:)]+$/, '');
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!rel.includes('/')) continue;
    if (SKIP.some((re) => re.test(rel))) continue;
    if (EXTERNAL.has(rel)) continue;
    const tail = rel.split('/').pop();
    if (tail.includes('*') || tail.includes('{') || tail.includes('$')) continue;
    if (!existsSync(join(ROOT, rel))) problems.push(`${doc}: 引用路径不存在 → ${rel}`);
  }
}

/* ── 2. 文档里的「28 项 / 509 条」必须和真实一致 ── */
const verifyDir = join(ROOT, 'tools/agent');
const verifyFiles = readdirSync(verifyDir).filter((f) => /^verify-.*\.mjs$/.test(f));
const realCount = verifyFiles.length;

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const m = readme.match(/(\d+)\s*项\s*\/\s*(\d+)\s*条判据/);
if (m) {
  if (Number(m[1]) !== realCount) {
    problems.push(`README.md: 写「${m[1]} 项验证」，实际 ${realCount} 项`);
  }
} else {
  problems.push('README.md: 找不到「N 项 / M 条判据」的陈述');
}

/* ── 3. 台账条数必须和文档一致 ── */
const ledger = JSON.parse(readFileSync(join(ROOT, 'research/改进台账.json'), 'utf8'));
const realEntries = ledger.entries.length;
const ledgerM = readme.match(/\|\s*改进台账\s*\|\s*\*\*(\d+)\s*条\*\*/);
if (ledgerM && Number(ledgerM[1]) !== realEntries) {
  problems.push(`README.md: 写「台账 ${ledgerM[1]} 条」，实际 ${realEntries} 条`);
}

/* ── 4. 自检：抽取逻辑本身不能坏 ── */
const probes = [
  ['tools/agent/loop.mjs', true],
  ['tools/agent/__not_exist__.mjs', false],
];
for (const [rel, shouldExist] of probes) {
  const got = existsSync(join(ROOT, rel));
  if (got !== shouldExist) {
    console.error(`  ✗ 自检失败：existsSync('${rel}') = ${got}，期望 ${shouldExist}`);
    console.error('    判定工具本身坏了，先修工具再信结果。');
    process.exit(2);
  }
}

/* ── 输出 ── */
const FIX = process.argv.includes('--fix');

/**
 * --fix：把「能自动算出来」的数字同步进文档。
 *
 * 为什么需要：台账每轮都会 +1，README 里那句「台账 N 条」必然过期。
 * 靠人记一定会漏 —— 所以让工具改，人只负责跑。
 * 只改**可计算**的数字（条数/项数），不改任何描述性文字。
 */
if (FIX) {
  const rp = join(ROOT, 'README.md');
  let rt = readFileSync(rp, 'utf8');
  const before = rt;

  // 只同步「台账条数」——它由 JSON 长度直接算出，无需跑验证。
  // 「N 项 / M 条判据」里的 M 需要实跑 28 项才知道，**不在自检里跑**（那会让自检变成重活），
  // 所以只校验项数 N，条数 M 由人/脚本在跑完验证后写入。这是刻意的不对称，已在注释说明。
  rt = rt.replace(/(\|\s*改进台账\s*\|\s*\*\*)\d+(\s*条\*\*)/, `$1${realEntries}$2`);

  if (rt !== before) {
    writeFileSync(rp, rt, 'utf8');
    console.log(`  ✓ 已同步 README 台账条数 → ${realEntries}`);
    // 修完要把对应的 problem 从列表里摘掉，否则紧接着还会打印 FAIL（自相矛盾）
    for (let i = problems.length - 1; i >= 0; i--) {
      if (/台账\s*\d+\s*条/.test(problems[i])) problems.splice(i, 1);
    }
  } else {
    console.log('  = README 台账条数已是 ' + realEntries);
  }
}

console.log('');
console.log(`  文档自检：${DOCS.length} 篇 · 验证文件 ${realCount} 个 · 台账 ${realEntries} 条`);
if (problems.length === 0) {
  console.log('  四态: PASS —— 文档与仓库一致');
  console.log('');
  process.exit(0);
}
console.log(`  ✗ 发现 ${problems.length} 处不一致：`);
for (const p of problems) console.log(`    · ${p}`);
console.log('  四态: FAIL');
console.log('');
process.exit(1);
