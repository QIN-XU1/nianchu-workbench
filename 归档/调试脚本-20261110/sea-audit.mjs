/**
 * 记忆与索引体检（独立 CLI，不侵入 sea.mjs）
 *
 * 用法：
 *   node sea-audit.mjs memory <root>     # 检查各场景 MEMORY.md 的红线
 *   node sea-audit.mjs index <root>      # 检查文档密集目录是否缺索引
 *
 * 为什么独立：
 *   sea.mjs 已经通过 13 个指标，不该为了加体检而冒险改它。
 *   审计是"低频、重"的操作，单独入口更合适。
 */

import { join, dirname, basename } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { check as memCheck, LIMITS } from './memory-guard.mjs';
import { check as docIdxCheck } from './doc-index-judge.mjs';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };
const HERE = import.meta.dirname;

const [, , mode, rootArg] = process.argv;

if (!mode || !rootArg) {
  console.log(`用法：`);
  console.log(`  node sea-audit.mjs memory <scenesRoot>`);
  console.log(`  node sea-audit.mjs index <docsRoot>`);
  process.exit(2);
}

const root = rootArg;

if (mode === 'memory') {
  // 扫描 root 下每个子目录的 MEMORY.md
  let dirs;
  try { dirs = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { console.log(`${C.red}目录不存在：${root}${C.reset}`); process.exit(2); }

  let checked = 0, problems = 0, missing = 0;
  console.log(`${C.bold}记忆红线体检${C.reset} · ${C.dim}主 ≤${LIMITS.mainBytes / 1024}KB / 交接 ≤${LIMITS.handoffBytes / 1024}KB${C.reset}\n`);

  for (const name of dirs) {
    const p = join(root, name, 'MEMORY.md');
    if (!existsSync(p)) { missing++; continue; }
    checked++;
    const r = memCheck(p);
    if (r.ok) {
      const m = r.measured;
      console.log(`${C.green}✓${C.reset} ${name.padEnd(24)} ${(m.bytesUtf8 / 1024).toFixed(1)}KB  交接 ${m.handoff ? (m.handoff.bytes / 1024).toFixed(1) + 'KB' : '(无)'}`);
    } else {
      problems++;
      console.log(`${C.red}✗${C.reset} ${name.padEnd(24)} 超红线`);
      for (const pb of r.problems) console.log(`${C.dim}     ${pb}${C.reset}`);
    }
  }

  console.log(`\n检查 ${checked} 个 · 超红线 ${problems} 个 · 无记忆文件 ${missing} 个`);
  process.exit(problems === 0 ? 0 : 1);
}

if (mode === 'index') {
  console.log(`${C.bold}文档索引体检${C.reset} · ${C.dim}密集目录必须建索引${C.reset}\n`);
  const r = docIdxCheck(root);
  console.log(`扫描 ${r.scanned} 个目录`);
  if (r.withIndex.length > 0) {
    console.log(`${C.dim}  已有索引：${r.withIndex.map(w => w.rel + '(' + w.docCount + ')').join(', ')}${C.reset}`);
  }
  if (r.shouldIndex.length > 0) {
    console.log(`${C.yellow}  建议建索引：${r.shouldIndex.map(w => w.rel + '(' + w.docCount + ')').join(', ')}${C.reset}`);
  }
  if (r.mustIndex.length === 0) {
    console.log(`\n${C.green}✓ 无遗漏索引${C.reset}`);
    process.exit(0);
  }
  console.log(`\n${C.red}✗ ${r.mustIndex.length} 个目录该有索引却没有：${C.reset}`);
  for (const m of r.mustIndex) console.log(`  ${C.red}·${C.reset} ${m.rel}（${m.docCount} 文档）`);
  process.exit(1);
}

console.log(`${C.red}不认识的模式${C.reset}：${mode}`);
process.exit(2);
