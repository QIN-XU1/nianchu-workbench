#!/usr/bin/env node
/**
 * git_get_file_content / git_get_diff 验证（第 108 轮）—— 与 git 原始输出逐字对比。
 *
 * 覆盖：
 *   ① fileContent（工作树）== 直接 fs 读到的内容
 *   ② fileContent（指定 rev）== `git show <rev>:<path>`
 *   ③ diffText（worktree）== `git diff -- <path>` 的原始输出（逐字）
 *   ④ diffText（staged）== `git diff --cached` 原始输出
 *   ⑤ 反例：路径穿越（../）必须被拒绝
 *   ⑥ 反例：非仓库 → not_a_repository
 *   ⑦ 反例：git_push 仍未实现（不假装支持）
 *
 * 四态：0 全通过 · 1 有失败 · 2 无法执行
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fileContent, diffText, gitReadMethods } from './git-methods.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0, fail = 0;
const t = (n, c, i = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (i ? ' ← ' + i : '')); } };
const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });

{
  const v = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (v.status !== 0) { console.error('  ❔ git 不可用 → UNKNOWN'); process.exit(2); }
}

console.log('');
console.log('  git_get_file_content / git_get_diff 验证（与 git 原始输出对比）');
console.log('  ' + '─'.repeat(66));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitdiff-'));
try {
  git(['init', '-q'], tmp);
  git(['config', 'user.email', 'p@local'], tmp);
  git(['config', 'user.name', 'p'], tmp);
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'line1\nline2\n', 'utf8');
  fs.writeFileSync(path.join(tmp, 'b.txt'), 'bee\n', 'utf8');
  git(['add', '.'], tmp);
  git(['commit', '-q', '-m', 'init'], tmp);

  // ① 工作树内容 == fs 读
  {
    const r = fileContent(tmp, 'a.txt');
    t('① 工作树内容 == fs 读取', r.ok === true && r.content === fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8'), JSON.stringify(r).slice(0, 80));
  }

  // ② 指定 rev == git show
  {
    const oracle = git(['-C', tmp, 'show', 'HEAD:a.txt'], tmp).stdout;
    const r = fileContent(tmp, 'a.txt', 'HEAD');
    t('② rev=HEAD 内容 == git show HEAD:a.txt', r.ok === true && r.content === oracle, 'ours=' + JSON.stringify(String(r.content).slice(0, 20)) + ' oracle=' + JSON.stringify(oracle.slice(0, 20)));
  }

  // ③ worktree diff == git diff 原始输出（逐字）
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'line1\nline2 changed\n', 'utf8');
  {
    const oracle = git(['-C', tmp, 'diff', '--', 'a.txt'], tmp).stdout;
    const r = diffText(tmp, 'a.txt', 'worktree');
    t('③ worktree diff == git diff 原始输出（逐字）', r.ok === true && r.patch === oracle, `len ours=${String(r.patch).length} oracle=${oracle.length}`);
    t('③ diff 非空（确有改动）', r.ok === true && r.empty === false);
  }

  // ④ staged diff == git diff --cached
  {
    git(['add', 'a.txt'], tmp);
    const oracle = git(['-C', tmp, 'diff', '--cached', '--', 'a.txt'], tmp).stdout;
    const r = diffText(tmp, 'a.txt', 'staged');
    t('④ staged diff == git diff --cached 原始输出', r.ok === true && r.patch === oracle, `len ours=${String(r.patch).length} oracle=${oracle.length}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ⑤ 路径穿越必须被拒
{
  const a = fileContent(ROOT, '../../../etc/passwd');
  t('⑤ 反例：路径穿越 ../ 被拒', a.ok === false && a.error === 'path_outside_repository', JSON.stringify(a).slice(0, 90));
  const b = fileContent(ROOT, 'C:/Windows/win.ini');
  t('⑤ 反例：绝对路径被拒', b.ok === false && b.error === 'path_outside_repository', JSON.stringify(b).slice(0, 90));
  const c = diffText(ROOT, '../../x');
  t('⑤ 反例：diff 的路径穿越被拒', c.ok === false && c.error === 'path_outside_repository', JSON.stringify(c).slice(0, 90));
}

// ⑥ 非仓库
{
  const r = fileContent(path.parse(ROOT).root, 'x.txt');
  t('⑥ 非仓库 → not_a_repository', r.ok === false && r.error === 'not_a_repository', JSON.stringify(r).slice(0, 80));
}

// ⑦ 反例：写操作仍未实现
{
  t('⑦ 反例：git_push 未实现（不假装支持）', gitReadMethods.git_push === undefined);
  t('⑦ 反例：git_commit 未实现（不假装支持）', gitReadMethods.git_commit === undefined);
  t('⑦ 方法表含 git_get_file_content / git_get_diff', typeof gitReadMethods.git_get_file_content === 'function' && typeof gitReadMethods.git_get_diff === 'function');
}

console.log('  ' + '─'.repeat(66));
console.log(`  结果：通过 ${pass} · 失败 ${fail}`);
console.log('  四态: ' + (fail === 0 ? 'PASS' : 'FAIL'));
process.exit(fail === 0 ? 0 : 1);