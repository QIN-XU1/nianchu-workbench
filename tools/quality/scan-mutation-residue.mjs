#!/usr/bin/env node
/**
 * 注入/变异残留扫描 —— 查各类注入标记有没有留在真实源码里。
 *
 * 【2026-11-18 第九次残留后扩成全类型】
 * 原来只查 `[crippled]` 标记。实测漏了两类：
 *   · 损坏词（import 的 t 被换成 o，F06 注入）—— survey.mjs 被提交进 HEAD 两次
 *   · `.vouch-fault-calc { ... }`（SCSS 注入类）—— VouchShared.scss 曾被提交
 * 教训：**残留不是一个标记，是一族**。只盯一种等于没盯。
 *
 * 【为什么需要】2026-11-18 第八次残留，而且这次**被提交进了 HEAD**：
 * `tools/schedule/scheduler.mjs:93` 留着
 *   `export function matches(cron, date = new Date()) { return true; }   // [crippled] 恒匹配`
 * 后果：`verify-scheduler` 从 12/0 变 11/1，R6 门禁红。
 *
 * 根因链（这次查到底了）：
 *   ① 变异工具在改文件时被**强杀**（我为了止住 fpr-sweep 递归，杀了所有 node 进程）
 *   ② `finally` 在 SIGKILL 下**根本不会执行** —— 这是 JS 层无法解决的
 *   ③ 之后我的 `git add -A` 把这份变异代码一起提交了
 *
 * 所以防线不能只放在「还原逻辑」里（前七次都放在那里，都失败）：
 *   · 变异工具启动前要**确认目标文件干净**（有残留就拒跑）
 *   · 提交前要有**独立扫描**（本工具），扫全仓有没有 [crippled] 标记
 *
 * 判据：
 *   定义文件里的 [crippled] 是**规则**（它们就是要写这些字符串），合法
 *   其它任何被 git 跟踪的源文件里出现 [crippled] ⇒ **残留**，必须报红
 *
 * 用法：node tools/quality/scan-mutation-residue.mjs [--json]
 * 四态：0 = 干净 / 1 = 有残留（点名文件与行号）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');

/** 这些文件里出现 [crippled] 是**定义**，不是残留 */
const DEFINITION_FILES = new Set([
  'tools/quality/mutation-check.mjs',
  'tools/evolve/audit-selftest-reality.mjs',
  'tools/quality/scan-mutation-residue.mjs',
  // 下面这些文件里出现「损坏词 / 注入类」是**探测规则**，不是残留
  'prototype/agent-ui/verify-syntax-guard.mjs',
  'tools/evolve/measure-verifier-efficacy.mjs',
  'tools/evolve/measure-real-recall.mjs',
  'tools/evolve/check-fault-anchors.mjs',
  'tools/quality/repair-t-o.mjs',
  'tools/evolve/faults.json',
]);

/** 残留模式族 —— 每一族都对应一次真实事故 */
const RESIDUE_PATTERNS = [
  { name: '变异标记', re: /\[crippled\]/, only: /\.(mjs|cjs|js|jsx|ts|tsx)$/i },
  // 损坏词用拼接构造 —— 不写字面量，否则 verify-syntax-guard 会把本文件当成损坏脚本
  { name: '损坏词（t→o）', re: new RegExp('^\\s*' + 'impo' + 'ro' + '\\s', 'm'), only: /\.(mjs|cjs|js|jsx|ts|tsx)$/i },
  { name: 'fault-probe 标记', re: /fault-probe:\s*bitfun/, only: /\.(mjs|cjs|js|jsx|ts|tsx|scss|css)$/i },
  { name: 'fault-calc 注入类', re: /\.vouch-fault-calc\s*\{/, only: /\.(mjs|cjs|js|jsx|ts|tsx|scss|css)$/i },
  { name: 'fault-probe 注入类', re: /\.vouch-fault-probe\s*\{/, only: /\.(mjs|cjs|js|jsx|ts|tsx|scss|css)$/i },
];

function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8', timeout: 20000, maxBuffer: 32 * 1024 * 1024 });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    return null;
  }
}

const files = trackedFiles();
if (files === null) {
  console.log('  ❔ 取不到 git 跟踪文件清单');
  console.log('  四态: UNKNOWN');
  process.exit(2);
}

const SRC = /\.(mjs|cjs|js|jsx|ts|tsx|scss|css)$/i;   // 不扫 json：台账里会写这些模式名作为描述
const hits = [];
for (const rel of files) {
  if (!SRC.test(rel)) continue;
  if (DEFINITION_FILES.has(rel)) continue;
  let body;
  try { body = fs.readFileSync(path.join(REPO, rel), 'utf8'); } catch { continue; }
  const lines = body.split('\n');
  for (const p of RESIDUE_PATTERNS) {
    if (p.only && !p.only.test(rel)) continue;
    for (let i = 0; i < lines.length; i++) {
      if (p.re.test(lines[i])) hits.push({ file: rel, line: i + 1, kind: p.name, text: lines[i].trim().slice(0, 110) });
    }
  }
}

console.log('');
console.log('  变异残留扫描 —— 查 [crippled] 标记有没有留在真实源码里');
console.log('  ' + '─'.repeat(74));
console.log('  扫 ' + files.filter((f) => SRC.test(f)).length + ' 个源文件（排除 ' + DEFINITION_FILES.size + ' 个定义文件）');
console.log('');

if (hits.length) {
  console.log('  ✗ 发现 ' + hits.length + ' 处残留：');
  for (const h of hits) {
    console.log('      ' + h.file + ':' + h.line + '  [' + h.kind + ']');
    console.log('        ' + h.text);
  }
  console.log('');
  console.log('  处置：`git checkout -- <文件>` 还原；如果是变异工具刚跑过，先确认没有进程还在跑。');
  console.log('');
  console.log('  四态: FAIL —— 变异代码留在真实源码里，那段时间的所有验收结果都不可信');
  console.log('');
  process.exit(1);
}

console.log('  ✓ 没有残留');
console.log('');
console.log('  四态: PASS —— 真实源码里没有变异标记');
console.log('');
process.exit(0);
