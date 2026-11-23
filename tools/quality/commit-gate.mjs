#!/usr/bin/env node
/**
 * 提交前门禁（第 112 轮）—— 把「我连续两次带红提交」这个教训钉成脚本。
 *
 * 【为什么】第 111 轮我在 `verify-docs` 仍为 FAIL 的状态下**提交了两次**（2e89b453、759060af）。
 * 原因不是不知道要跑，而是「跑门禁」和「提交」是两个分开的动作，中间会漏。
 * 这类错误的唯一可靠解法是：**让提交本身先过门禁**。
 *
 * 【做什么】只跑**快、稳、不依赖网络/模型**的 4 项：
 *   ① scan-mutation-residue  真实源码里有没有变异残留
 *   ② size-guard             单文件体量红线
 *   ③ verify-docs            文档与仓库是否一致
 *   ④ scan-silent-catch      空 catch 是否都有解释
 * 任何一项 FAIL → exit 1，并明确打印「不要提交」。
 *
 * 【装 hook】`node tools/quality/commit-gate.mjs --install-hook`
 *   写 `.git/hooks/pre-commit`（调用本脚本）。装了之后带红提交会被 git 直接拦下。
 *
 * 用法：
 *   node tools/quality/commit-gate.mjs                # 检查一次
 *   node tools/quality/commit-gate.mjs --install-hook # 装 pre-commit hook
 * 四态：0 可以提交 · 1 不许提交 · 2 工具自检失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// 注入的检查可能是绝对路径 —— path.join(ROOT, abs) 会拼坏，所以统一用这个解析
const resolveCheck = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

const CHECKS = [
  { name: '变异残留', file: 'tools/quality/scan-mutation-residue.mjs' },
  { name: '体量红线', file: 'tools/quality/size-guard.mjs' },
  { name: '文档一致', file: 'tools/quality/verify-docs.mjs' },
  // 【第 113 轮补】verify-docs 只查 README；架构.md / 目录与模块.md / 总纲.md 里的数字
  // 由 audit-doc-numbers 查 —— 这是我第 113 轮发现的**门禁盲区**（3 处数字悄悄过期）。
  { name: '文档数字', file: 'tools/quality/audit-doc-numbers.mjs' },
  { name: '空 catch', file: 'tools/quality/scan-silent-catch.mjs' },
];

// ── 可注入额外检查（供自测覆盖 WARN/FAIL 分支；也方便临时加检查）──
// 为什么需要：第 113 轮五层审查发现 `status===3` 这条新分支**没有任何测试**，
// 改回去测试也照样绿 —— 于是加这个口子，让自测能真的喂进一个 exit 3 的检查。
if (process.env.COMMIT_GATE_EXTRA) {
  for (const p of process.env.COMMIT_GATE_EXTRA.split(',').map((x) => x.trim()).filter(Boolean)) {
    CHECKS.push({ name: '注入:' + path.basename(p), file: p });
  }
}

// ── 自检：登记的文件必须存在 ──
{
  const missing = CHECKS.filter((c) => !fs.existsSync(resolveCheck(c.file)));
  if (missing.length) {
    console.error('  ✗ 自检失败：登记了不存在的检查 → ' + missing.map((m) => m.file).join(', '));
    process.exit(2);
  }
}

// ── 装 hook ──
if (process.argv.includes('--install-hook')) {
  const hooksDir = path.join(ROOT, '.git/hooks');
  if (!fs.existsSync(hooksDir)) { console.error('  ✗ 不是 git 仓库（找不到 .git/hooks）'); process.exit(2); }
  const hookPath = path.join(hooksDir, 'pre-commit');
  const body = [
    '#!/bin/sh',
    '# 提交前门禁（由 tools/quality/commit-gate.mjs --install-hook 生成）',
    '# 想绕过：git commit --no-verify（但请先想清楚为什么门禁是红的）',
    'node tools/quality/commit-gate.mjs || {',
    '  echo ""',
    '  echo "  ⛔ 门禁未通过，提交被拦下。修好再提交，或用 --no-verify 显式绕过。"',
    '  exit 1',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(hookPath, body, 'utf8');
  try { fs.chmodSync(hookPath, 0o755); } catch { /* Windows 上无意义 */ }
  console.log('  ✓ 已装 .git/hooks/pre-commit');
  console.log('  验证：改坏一处文档后 `git commit` 应被拦下（见 tools/quality/verify-commit-gate.mjs）');
  process.exit(0);
}

// ── 跑检查 ──
console.log('');
console.log('  提交前门禁（' + CHECKS.length + ' 项快检查）');
console.log('  ' + '─'.repeat(64));
let bad = 0;
for (const c of CHECKS) {
  const r = spawnSync(process.execPath, [resolveCheck(c.file)], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  // 【第 113 轮修】四态：0=PASS · 3=WARN（可提交但要知道）· 1=FAIL · 2=自检失败。
  // 一开始我把 3 也当失败，导致 audit-doc-numbers 的「已映射全一致、35 处未覆盖」被误判成阻断。
  const ok = r.status === 0 || r.status === 3;
  const warn = r.status === 3;
  if (!ok) bad++;
  const mark = ok ? (warn ? '⚠' : '✓') : '✗';
  const note = warn ? '  ← WARN（未覆盖项，非阻断）' : '';
  console.log('  ' + mark + ' ' + c.name.padEnd(10) + c.file + '  (exit=' + r.status + ')' + note);
  if (!ok) {
    const lines = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/).filter((l) => /✗|FAIL|不一致|未解释|过期/.test(l)).slice(0, 3);
    for (const l of lines) console.log('        ' + l.trim().slice(0, 110));
  }
}
console.log('  ' + '─'.repeat(64));
if (bad === 0) {
  console.log('  ✓ 门禁全绿 —— 可以提交');
  console.log('  四态: PASS');
  process.exit(0);
}
console.log('  ⛔ ' + bad + ' 项未通过 —— **不要提交**（第 111 轮我两次带红提交，就是漏了这一步）');
console.log('  四态: FAIL');
process.exit(1);