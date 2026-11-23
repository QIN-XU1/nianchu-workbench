#!/usr/bin/env node
/**
 * git_get_commits / git_resolve_revision 验证（第 114 轮）—— 与真实 git 输出对拍。
 *
 * 覆盖：
 *   ① 首条 sha == `git rev-parse HEAD`
 *   ② 条数 == min(limit, `git rev-list --count HEAD`)
 *   ③ 每条 subject == `git log --format=%s` 对应行
 *   ④ limit 钳制：0 → 1；9999 → 500
 *   ⑤ resolveRevision('HEAD') == `git rev-parse HEAD`
 *   ⑥ resolveRevision(分支名) 能解析
 *   ⑦ 反例：不存在的 rev → rev_unresolved（不返回假 sha）
 *   ⑧ 反例：非仓库 → not_a_repository
 *   ⑨ 反例：git_push / git_commit 仍未实现（不假装支持）
 *
 * 四态：0 全通过 · 1 有失败 · 2 无法执行
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { commitLog, resolveRevision, gitReadMethods } from './git-methods.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0, fail = 0;
const t = (n, c, i = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (i ? ' ← ' + i : '')); } };
const git = (args, cwd = ROOT) => spawnSync('git', args, { cwd, encoding: 'utf8' });

{
  const v = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (v.status !== 0) { console.error('  ❔ git 不可用 → UNKNOWN'); process.exit(2); }
}

console.log('');
console.log('  git_get_commits / git_resolve_revision 验证（与真实 git 对拍）');
console.log('  ' + '─'.repeat(68));

// ①②③ 用本仓库真实历史
{
  const oracleHead = git(['rev-parse', 'HEAD']).stdout.trim();
  const oracleCount = Number(git(['rev-list', '--count', 'HEAD']).stdout.trim());
  const r = commitLog(ROOT, 5);

  t('① 首条 sha == git rev-parse HEAD', r.ok && r.commits[0] && r.commits[0].sha === oracleHead,
    `ours=${String(r.commits?.[0]?.sha).slice(0, 10)} oracle=${oracleHead.slice(0, 10)}`);

  const want = Math.min(5, oracleCount);
  t('② 条数 == min(limit, rev-list --count)', r.ok && r.count === want, `ours=${r.count} want=${want} total=${oracleCount}`);

  const oracleSubjects = git(['log', '-n', '5', '--pretty=format:%s']).stdout.split(/\r?\n/).filter(Boolean);
  const oursSubjects = r.commits.map((c) => c.subject);
  t('③ 每条 subject 与 git log --format=%s 一致', JSON.stringify(oursSubjects) === JSON.stringify(oracleSubjects),
    `ours=${oursSubjects.length} oracle=${oracleSubjects.length}`);
}

// ④ limit 钳制
{
  const a = commitLog(ROOT, 0);
  t('④ limit=0 → 钳到 1', a.ok && a.limit === 1 && a.count <= 1, `limit=${a.limit} count=${a.count}`);
  const b = commitLog(ROOT, 9999);
  t('④ limit=9999 → 钳到 500', b.ok && b.limit === 500, `limit=${b.limit}`);
  const c = commitLog(ROOT, -5);
  t('④ limit=-5 → 钳到 1（不偷偷用默认值）', c.ok && c.limit === 1, `limit=${c.limit}`);
  const d = commitLog(ROOT, undefined);
  t('④ limit 未传 → 默认 50', d.ok && d.limit === 50, `limit=${d.limit}`);
}

// ⑤⑥⑦ rev 解析
{
  const oracleHead = git(['rev-parse', 'HEAD']).stdout.trim();
  const r = resolveRevision(ROOT, 'HEAD');
  t('⑤ resolveRevision(HEAD) == git rev-parse HEAD', r.ok && r.sha === oracleHead, `ours=${String(r.sha).slice(0, 10)}`);

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const rb = resolveRevision(ROOT, branch);
  t('⑥ resolveRevision(分支名) 能解析且等于 HEAD', rb.ok && rb.sha === oracleHead, `branch=${branch} ours=${String(rb.sha).slice(0, 10)}`);

  const bad = resolveRevision(ROOT, 'definitely-no-such-ref-xyz');
  t('⑦ 反例：不存在的 rev → rev_unresolved 且无 sha', bad.ok === false && bad.error === 'rev_unresolved' && !bad.sha,
    JSON.stringify(bad).slice(0, 90));

  const empty = resolveRevision(ROOT, '');
  t('⑦ 反例：空 rev → rev_required', empty.ok === false && empty.error === 'rev_required');
}

// ⑧ 非仓库
{
  const r = commitLog(path.parse(ROOT).root, 5);
  t('⑧ 反例：非仓库 → not_a_repository', r.ok === false && r.error === 'not_a_repository', JSON.stringify(r).slice(0, 80));
}

// ⑨ 写操作仍未实现
{
  t('⑨ 反例：git_push 未实现（不假装支持）', gitReadMethods.git_push === undefined);
  t('⑨ 反例：git_commit 未实现（不假装支持）', gitReadMethods.git_commit === undefined);
  t('⑨ 方法表含 git_get_commits / git_resolve_revision',
    typeof gitReadMethods.git_get_commits === 'function' && typeof gitReadMethods.git_resolve_revision === 'function');
}

console.log('  ' + '─'.repeat(68));
console.log(`  结果：通过 ${pass} · 失败 ${fail}`);
console.log('  四态: ' + (fail === 0 ? 'PASS' : 'FAIL'));
process.exit(fail === 0 ? 0 : 1);