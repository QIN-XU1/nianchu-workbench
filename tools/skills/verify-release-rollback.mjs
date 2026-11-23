#!/usr/bin/env node
/**
 * release-pipeline 第 4 步「回滚预案」真跑 —— 技能说「没跑过的回滚方案等于没有」，本脚本就真跑一次。
 *
 * 做法：在**临时目录**建一个迷你 git 仓库（不碰主工作区），模拟一次发布与回滚：
 *   v1 提交并打 tag → 改成 v2 提交并打 tag（= 发布）→ 回滚到 v1 → 验证内容真的回到 v1
 *   → 再回滚回 v2 → 验证恢复
 *
 * 反例（证明回滚检查不是假的）：
 *   A. 回滚到不存在的 tag → git 必须失败（否则「回滚」是个空操作）
 *   B. 回滚后内容没变 → 校验必须能检出（说明校验真在比内容）
 *   C. 回滚后产物与目标 tag 的内容不一致 → 必须被检出
 *
 * 四态：0 全通过 · 1 有失败 · 2 工具自检失败（如 git 不可用）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const TMP = path.join(os.tmpdir(), 'nianchu-rollback-probe-' + process.pid);
let pass = 0, fail = 0;
const t = (n, c, i = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (i ? ' ← ' + i : '')); } };

const git = (args) => spawnSync('git', args, { cwd: TMP, encoding: 'utf8' });

// ── 自检：git 可用 ──
{
  const v = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (v.status !== 0) { console.error('  ✗ git 不可用，无法演练回滚'); process.exit(2); }
}

try {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  git(['init', '-q']);
  git(['config', 'user.email', 'probe@local']);
  git(['config', 'user.name', 'probe']);

  const file = path.join(TMP, 'release.txt');
  const read = () => fs.readFileSync(file, 'utf8').trim();

  console.log('  release-pipeline 第 4 步 · 回滚预案真跑');
  console.log('  ' + '─'.repeat(62));

  // v1：基线
  fs.writeFileSync(file, 'version=v1\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'v1']);
  git(['tag', 'v1']);
  t('建仓并发布 v1', read() === 'version=v1');

  // v2：新版本（= 这次发布）
  fs.writeFileSync(file, 'version=v2\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'v2']);
  git(['tag', 'v2']);
  t('发布 v2 后内容为 v2', read() === 'version=v2');

  // 回滚到 v1
  {
    const r = git(['reset', '--hard', 'v1']);
    t('回滚到 v1 命令成功', r.status === 0, (r.stderr || '').slice(0, 80));
    t('★回滚后内容真的回到 v1', read() === 'version=v1', '实得 ' + read());
  }

  // 回滚回 v2（恢复）
  {
    const r = git(['reset', '--hard', 'v2']);
    t('恢复回 v2 命令成功', r.status === 0, (r.stderr || '').slice(0, 80));
    t('★恢复后内容真的回到 v2', read() === 'version=v2', '实得 ' + read());
  }

  // 反例A：回滚到不存在的 tag 必须失败
  {
    const before = read();
    const r = git(['reset', '--hard', 'v_no_such_tag']);
    t('反例A：回滚到不存在的 tag → git 必须失败', r.status !== 0, 'exit=' + r.status + '（应非 0）');
    t('反例A：失败后内容未被破坏', read() === before, '实得 ' + read());
  }

  // 反例B：内容比对必须真在比（手动改文件后，与 tag 内容不一致应被检出）
  {
    fs.writeFileSync(file, 'version=TAMPERED\n', 'utf8');
    const r = git(['diff', '--name-only', 'v2']);
    t('反例B：改坏文件后 git 能检出与 v2 不一致', r.status === 0 && r.stdout.trim().length > 0, 'diff=' + JSON.stringify((r.stdout || '').trim()));
  }

  // 反例C：校验函数必须对不一致报错（用内容比较，不是只看命令 exit 0）
  {
    const expect = spawnSync('git', ['show', 'v2:release.txt'], { cwd: TMP, encoding: 'utf8' }).stdout.trim();
    const actual = read();
    t('反例C：回滚后内容与目标 tag 不一致 → 必须被检出', actual !== expect, `actual=${actual} expect=${expect}`);
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('  ' + '─'.repeat(62));
console.log(`  结果：通过 ${pass} · 失败 ${fail}`);
console.log('  四态: ' + (fail === 0 ? 'PASS' : 'FAIL'));
console.log('  说明：这是「回滚命令可跑通」的演练；真实预发环境的回滚仍未跑（UNKNOWN）');
process.exit(fail === 0 ? 0 : 1);