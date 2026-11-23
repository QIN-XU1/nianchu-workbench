#!/usr/bin/env node
/**
 * git_get_status / git_get_changed_files 验证（第 107 轮）—— 用真实 git 输出做 oracle。
 *
 * 在**临时仓库**里造各种状态（干净 / 未跟踪 / 已修改 / 重命名），
 * 把我们的解析结果与 `git status --porcelain=v1` 的原始输出逐项对比。
 *
 * 覆盖：
 *   ① 干净仓库 → clean true、0 个改动
 *   ② 未跟踪文件 → 1 个，status '??'
 *   ③ 已修改文件 → status 含 'M'
 *   ④ 重命名 → status 含 'R'，origPath 是旧路径
 *   ⑤ oracle：我们的 path 集合 == 原始输出的 path 集合
 *   ⑥ 非仓库 → isRepository false、clean null
 *   ⑦ 反例：git_get_commit / git_push 仍未实现（不假装支持）
 *
 * 四态：0 全通过 · 1 有失败 · 2 无法执行
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repositoryStatus, parsePorcelain, gitReadMethods } from './git-methods.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0, fail = 0;
const t = (n, c, i = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (i ? ' ← ' + i : '')); } };
const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });

// 自检：git 可用
{
  const v = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (v.status !== 0) { console.error('  ❔ git 不可用 → UNKNOWN'); process.exit(2); }
}
// 自检：解析器本身
{
  const p = parsePorcelain('?? a.txt\n M b.js\nR  c.md -> d.md\n');
  if (p.length !== 3 || p[0].status !== '??' || p[2].origPath !== 'c.md' || p[2].path !== 'd.md') {
    console.error('  ✗ 自检失败：parsePorcelain 结果不对 ' + JSON.stringify(p));
    process.exit(2);
  }
}

console.log('');
console.log('  git_get_status 验证（以真实 git 为 oracle）');
console.log('  ' + '─'.repeat(64));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitstatus-'));
try {
  git(['init', '-q'], tmp);
  git(['config', 'user.email', 'p@local'], tmp);
  git(['config', 'user.name', 'p'], tmp);
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'hello\n', 'utf8');
  git(['add', '.'], tmp);
  git(['commit', '-q', '-m', 'init'], tmp);

  // ① 干净
  {
    const r = repositoryStatus(tmp);
    t('① 干净仓库 → clean true 且 0 改动', r.isRepository === true && r.clean === true && r.changedCount === 0, JSON.stringify({ c: r.clean, n: r.changedCount }));
  }

  // ② 未跟踪
  fs.writeFileSync(path.join(tmp, 'new.txt'), 'x\n', 'utf8');
  {
    const r = repositoryStatus(tmp);
    const f = r.files.find((x) => x.path === 'new.txt');
    t('② 未跟踪文件 → status ??', !!f && f.status === '??', JSON.stringify(f || r.files));
  }

  // ③ 已修改
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'hello world\n', 'utf8');
  {
    const r = repositoryStatus(tmp);
    const f = r.files.find((x) => x.path === 'a.txt');
    t('③ 已修改文件 → status 含 M', !!f && f.status.includes('M'), JSON.stringify(f || r.files));
  }

  // ④ 重命名（先提交修改，再 mv + git add）
  {
    git(['add', '-A'], tmp);
    git(['commit', '-q', '-m', 'modify'], tmp);
    git(['mv', 'a.txt', 'b.txt'], tmp);
    const r = repositoryStatus(tmp);
    const f = r.files.find((x) => x.path === 'b.txt');
    t('④ 重命名 → path=b.txt 且 status 含 R', !!f && f.status.includes('R'), JSON.stringify(f || r.files));
    t('④ 重命名 → origPath=a.txt', !!f && f.origPath === 'a.txt', JSON.stringify(f || null));
  }

  // ⑤ oracle：path 集合一致
  {
    const raw = git(['-C', tmp, 'status', '--porcelain=v1'], tmp).stdout;
    const oracle = new Set(parsePorcelain(raw).map((x) => x.path));
    const ours = new Set(repositoryStatus(tmp).files.map((x) => x.path));
    const same = oracle.size === ours.size && [...oracle].every((x) => ours.has(x));
    t('⑤ oracle：我们的 path 集合 == git 原始输出', same, `ours=${[...ours].join(',')} oracle=${[...oracle].join(',')}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ⑥ 非仓库
{
  const r = repositoryStatus(path.parse(ROOT).root);
  t('⑥ 非仓库 → isRepository false 且 clean null', r.isRepository === false && r.clean === null, JSON.stringify({ r: r.isRepository, c: r.clean }));
}

// ⑦ 反例：写操作仍未实现
{
  t('⑦ 反例：git_commit 未实现（不假装支持）', gitReadMethods.git_commit === undefined);
  t('⑦ 反例：git_push 未实现（不假装支持）', gitReadMethods.git_push === undefined);
  t('⑦ 方法表含 git_get_status / git_get_changed_files', typeof gitReadMethods.git_get_status === 'function' && typeof gitReadMethods.git_get_changed_files === 'function');
}

console.log('  ' + '─'.repeat(64));
console.log(`  结果：通过 ${pass} · 失败 ${fail}`);
console.log('  四态: ' + (fail === 0 ? 'PASS' : 'FAIL'));
process.exit(fail === 0 ? 0 : 1);