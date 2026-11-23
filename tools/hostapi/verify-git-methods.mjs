#!/usr/bin/env node
/**
 * git 只读方法验证（第 104 轮）—— 用**真实 git 命令做 oracle 对拍**。
 *
 * 为什么用 oracle：自己写的「读 .git 目录」逻辑，最容易「看起来对」。唯一可靠的检验是
 * 拿 `git rev-parse` / `git branch` 的真实输出对比——不一致就是错。
 *
 * 覆盖：
 *   ① repositoryBasic 的 branch/head 与 `git rev-parse --abbrev-ref HEAD` / `git rev-parse HEAD` 一致
 *   ② 分支列表与 `git branch --format=%(refname:short)` 一致（数量 + 名称集合）
 *   ③ 非仓库路径 → isRepository false
 *   ④ worktree 形态（.git 是文件）→ 仍能定位
 *   ⑤ 反例：写操作（git_get_status / git_commit）**未实现**，不假装支持
 *
 * 四态：0 全通过 · 1 有失败 · 2 工具自检失败（如 git 不可用）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repositoryBasic, listBranches, locate, gitReadMethods } from './git-methods.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0, fail = 0;
const t = (n, c, i = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (i ? ' ← ' + i : '')); } };
const git = (args, cwd = ROOT) => spawnSync('git', args, { cwd, encoding: 'utf8' });

// ── 自检：git 可用 ──
{
  const v = git(['--version']);
  if (v.status !== 0) { console.error('  ❔ git 不可用 → UNKNOWN'); process.exit(2); }
}

console.log('');
console.log('  git 只读方法验证（以真实 git 为 oracle）');
console.log('  ' + '─'.repeat(64));

// ① branch / head 对拍
{
  const oracleBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const oracleHead = git(['rev-parse', 'HEAD']).stdout.trim();
  const b = repositoryBasic(ROOT);
  t('① isRepository true', b.isRepository === true, JSON.stringify({ r: b.isRepository }));
  t('① branch 与 git rev-parse --abbrev-ref 一致', b.branch === oracleBranch, `ours=${b.branch} oracle=${oracleBranch}`);
  t('① head 与 git rev-parse HEAD 一致', b.head === oracleHead, `ours=${String(b.head).slice(0, 10)} oracle=${oracleHead.slice(0, 10)}`);
}

// ② 分支列表对拍
{
  const oracle = git(['branch', '--format=%(refname:short)']).stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).sort();
  const { gitdir } = locate(ROOT);
  const ours = listBranches(gitdir).map((x) => x.name).sort();
  t('② 分支数量一致', ours.length === oracle.length, `ours=${ours.length} oracle=${oracle.length}`);
  t('② 分支名称集合一致', JSON.stringify(ours) === JSON.stringify(oracle), `ours=${ours.join(',')} oracle=${oracle.join(',')}`);
}

// ③ 非仓库
{
  const outside = path.parse(ROOT).root;
  const b = repositoryBasic(outside);
  t('③ 盘根 → isRepository false 且 branch 为 null', b.isRepository === false && b.branch === null, JSON.stringify(b));
}

// ④ worktree 形态
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitwt-'));
  try {
    // 造一个真仓库再改成 .git 文件形态（模拟 worktree/submodule）
    git(['init', '-q'], tmp);
    const gitdirReal = path.join(tmp, '.git');
    const moved = path.join(tmp, '.git-real');
    fs.renameSync(gitdirReal, moved);
    fs.writeFileSync(path.join(tmp, '.git'), 'gitdir: ' + moved + '\n', 'utf8');
    const r = locate(tmp);
    t('④ .git 为文件（gitdir: 指针）→ 能定位到 gitdir', !!r.gitdir && path.resolve(r.gitdir) === path.resolve(moved), JSON.stringify(r));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ⑤ 反例：写操作没实现，不假装支持
{
  // 第 107 轮：git_get_status 已实现，反例改用仍未实现的写操作
  t('⑤ 反例：git_push 未实现（不假装支持）', gitReadMethods.git_push === undefined);
  t('⑤ 反例：git_commit 未实现（不假装支持）', gitReadMethods.git_commit === undefined);
  t('⑤ 方法表含 UI 直调的 git_get_repository_basic', typeof gitReadMethods.git_get_repository_basic === 'function');
  t('⑤ 方法表含映射名 git/isRepository', typeof gitReadMethods['git/isRepository'] === 'function');
}

console.log('  ' + '─'.repeat(64));
console.log(`  结果：通过 ${pass} · 失败 ${fail}`);
console.log('  四态: ' + (fail === 0 ? 'PASS' : 'FAIL'));
process.exit(fail === 0 ? 0 : 1);