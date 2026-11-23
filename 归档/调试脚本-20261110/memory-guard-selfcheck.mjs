/**
 * 记忆体量红线的元验证：证明检查会失败、归档不丢内容。
 *
 * 三个测试：
 *   1. 合规记忆（小文件 + 有交接段）→ 通过
 *   2. 主文件超 25KB → 报差
 *   3. 交接段超 4KB → 报差
 *   4. 缺交接段 → 报差
 *   5. 归档：搬走旧分节后，内容要能证明没丢
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, archive, verifyArchive, measure, LIMITS } from './memory-guard.mjs';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', bold: '\x1b[1m' };

const tmp = mkdtempSync(join(tmpdir(), 'memguard-'));
let pass = 0, total = 0;

function makeMemory(name, { mainPadBytes = 0, handoffBytes = 0, withHandoff = true, extraSections = 0 }) {
  const p = join(tmp, name);
  const parts = [];
  parts.push('# 场景记忆\n');
  parts.push('## 核心职责\n');
  parts.push('- 负责数据核对\n- 不碰代码与发布\n');

  if (withHandoff) {
    parts.push('## §〇 当前交接\n');
    parts.push('### 1) 上次交接\n');
    parts.push('- 做了数据核对，差异 0\n');
    if (handoffBytes > 0) {
      parts.push('### 填充\n');
      parts.push('x'.repeat(handoffBytes) + '\n');
    }
  }

  for (let i = 0; i < extraSections; i++) {
    parts.push(`## 历史记录 ${i}\n`);
    parts.push(`- 第 ${i} 轮：做了些事，结论是 A${i}\n`);
  }

  if (mainPadBytes > 0) {
    parts.push('## 填充区\n');
    parts.push('y'.repeat(mainPadBytes) + '\n');
  }

  const text = parts.join('\n');
  writeFileSync(p, text, 'utf8');
  return p;
}

function report(name, expectOk, result) {
  total++;
  const ok = result.ok === expectOk;
  if (ok) pass++;
  const mark = ok ? `${C.green}OK  ` : `${C.red}MISS`;
  console.log(`${mark}${C.reset} ${name.padEnd(34)} 期望=${expectOk ? '通过' : '报差'} 实际=${result.ok ? '通过' : '报差'}`);
  if (!result.ok) {
    for (const pb of result.problems) console.log(`${C.dim}      ${pb}${C.reset}`);
  }
}

// ---------- 1. 合规 ----------
report('合规记忆（小 + 有交接）', true, check(makeMemory('ok.md', { handoffBytes: 200 })));

// ---------- 2. 主文件超红线 ----------
report('主文件超 25KB', false, check(makeMemory('big-main.md', {
  handoffBytes: 500,
  mainPadBytes: LIMITS.mainBytes + 2000,
})));

// ---------- 3. 交接段超 4KB ----------
report('交接段超 4KB', false, check(makeMemory('big-handoff.md', {
  handoffBytes: LIMITS.handoffBytes + 1500,
})));

// ---------- 4. 缺交接段 ----------
report('缺「§0 当前交接」', false, check(makeMemory('no-handoff.md', { withHandoff: false })));

// ---------- 5. 归档不丢内容 ----------
{
  const p = makeMemory('to-archive.md', { handoffBytes: 300, extraSections: 8, mainPadBytes: 2000 });
  const before = readFileSync(p, 'utf8');
  const dry = archive(p, { dryRun: true });
  const real = archive(p, { dryRun: false });
  const verify = verifyArchive(p, real);

  total++;
  // 判据：搬走的分节数 == 原文件顶层分节数 - 保留数；且内容可证没丢
  const dryKept = dry.keptTitles.length;
  const expectMoved = dry.movedTitles.length;
  const ok = real.moved === expectMoved && verify.ok && existsSync(real.archiveFile);
  if (ok) pass++;
  const mark = ok ? `${C.green}OK  ` : `${C.red}MISS`;
  console.log(`${mark}${C.reset} ${'归档搬走旧分节且可证没丢'.padEnd(34)} 搬走=${real.moved} 校验=${verify.ok}`);
  console.log(`${C.dim}      搬前 ${(real.beforeBytes / 1024).toFixed(1)}KB → 搬后 ${(real.afterBytes / 1024).toFixed(1)}KB${C.reset}`);
  console.log(`${C.dim}      保留：${real.keptTitles.join(' / ')}${C.reset}`);
  if (!verify.ok) console.log(`${C.red}      丢：${JSON.stringify(verify.missing)}${C.reset}`);
}

// ---------- 6. 归档后应通过红线 ----------
{
  const p = join(tmp, 'to-archive.md');
  const r = check(p);
  total++;
  if (r.ok) pass++;
  const mark = r.ok ? `${C.green}OK  ` : `${C.red}MISS`;
  console.log(`${mark}${C.reset} ${'归档后回到红线内'.padEnd(34)} ${r.ok ? '通过' : '仍超'}`);
  if (!r.ok) for (const pb of r.problems) console.log(`${C.dim}      ${pb}${C.reset}`);
}

rmSync(tmp, { recursive: true, force: true });

console.log(`\n===== 记忆红线元验证：${pass}/${total} =====`);
const allOk = pass === total;
console.log(allOk
  ? `${C.green}记忆机制有效：红线会失败，归档不丢内容${C.reset}`
  : `${C.red}记忆机制有缺陷${C.reset}`);
process.exit(allOk ? 0 : 1);
