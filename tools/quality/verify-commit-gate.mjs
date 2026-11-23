#!/usr/bin/env node
/**
 * 提交前门禁自测（第 112 轮）—— 必须证明它**真会拦**，不是永远打印「可以提交」。
 *
 * 用例：
 *   ① 当前状态（干净）→ exit 0
 *   ② 制造一处文档不一致（README 计数改错）→ 必须 exit 1
 *   ③ 恢复 → 回到 exit 0
 *   ④ 装 hook 后，**真的尝试 git commit**，必须被拦下（且仓库 HEAD 不变）
 *
 * ④ 是这套机制的核心：只测脚本本身不够，要测「git 真的不让提交」。
 * 安全措施：若 commit 意外成功，立刻 `git reset --soft HEAD~1` 撤销，并把该用例判红。
 *
 * 四态：0 全通过 · 1 有失败 · 2 无法执行（非 git 仓库等）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GATE = path.join(ROOT, 'tools/quality/commit-gate.mjs');
const README = path.join(ROOT, 'README.md');
let pass = 0, fail = 0;
const t = (n, c, i = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (i ? ' ← ' + i : '')); } };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
const gate = () => run(process.execPath, [GATE]);

// 前置：必须是 git 仓库 + README 存在
{
  const r = run('git', ['rev-parse', '--is-inside-work-tree']);
  if (r.status !== 0) { console.error('  ❔ 不是 git 仓库 → 无法验证'); process.exit(2); }
  if (!fs.existsSync(README)) { console.error('  ❔ README.md 不存在 → 无法验证'); process.exit(2); }
}

console.log('');
console.log('  提交前门禁自测（含「真被 git 拦下」）');
console.log('  ' + '─'.repeat(64));

const original = fs.readFileSync(README, 'utf8');

try {
  // ① 干净状态
  {
    const r = gate();
    t('① 干净状态 → exit 0 且输出「可以提交」', r.status === 0 && /可以提交/.test(r.stdout || ''), 'exit=' + r.status);
  }

  // ② 制造文档不一致
  {
    // 【第 112 轮修】verify-docs 检查的正则是 `N 项 / M 条判据`（README L27），
    // 不是我一开始改的「30 项验证」（L45）—— 破坏点必须对准真正被检查的形态。
    const broken = original.replace(/\*\*(\d+)\s*项\s*\/\s*(\d+)\s*条判据[^*]*\*\*/, '**99 项 / $2 条判据**');
    if (broken === original) { t('② 前置：能制造不一致', false, 'README 里没找到「N 项 / M 条判据」'); }
    else {
      fs.writeFileSync(README, broken, 'utf8');
      const r = gate();
      t('② 文档不一致 → exit 1 且输出「不要提交」', r.status === 1 && /不要提交/.test(r.stdout || ''), 'exit=' + r.status);
      t('② 输出里点明了是哪一项失败', /文档一致/.test(r.stdout || ''));
    }
    fs.writeFileSync(README, original, 'utf8');
  }

  // ③ 恢复
  {
    const r = gate();
    t('③ 恢复后 → exit 0', r.status === 0, 'exit=' + r.status);
  }

  // ⑤ 【第 113 轮补】WARN 分支必须被测到 —— 五层审查发现 status===3 没有任何测试
  {
    const warnCheck = path.join(ROOT, 'tools/quality/_tmp-warn-check.mjs');
    const failCheck = path.join(ROOT, 'tools/quality/_tmp-fail-check.mjs');
    fs.writeFileSync(warnCheck, 'process.exit(3);\n', 'utf8');
    fs.writeFileSync(failCheck, 'process.exit(1);\n', 'utf8');
    try {
      const rWarn = spawnSync(process.execPath, [GATE], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, COMMIT_GATE_EXTRA: warnCheck } });
      t('⑤ 注入 exit 3 的检查 → 门禁仍 PASS 且打 ⚠', rWarn.status === 0 && /⚠/.test(rWarn.stdout || ''), 'exit=' + rWarn.status);
      const rFail = spawnSync(process.execPath, [GATE], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, COMMIT_GATE_EXTRA: failCheck } });
      t('⑤ 注入 exit 1 的检查 → 门禁 FAIL', rFail.status === 1, 'exit=' + rFail.status);
    } finally {
      fs.rmSync(warnCheck, { force: true });
      fs.rmSync(failCheck, { force: true });
    }
  }

  // ④ 装 hook 并真试提交
  {
    const inst = run(process.execPath, [GATE, '--install-hook']);
    t('④ 装 hook 成功', inst.status === 0 && /已装/.test(inst.stdout || ''), inst.stdout || inst.stderr);
    const hookPath = path.join(ROOT, '.git/hooks/pre-commit');
    t('④ hook 文件存在且调用 commit-gate', fs.existsSync(hookPath) && /commit-gate/.test(fs.readFileSync(hookPath, 'utf8')));

    const headBefore = run('git', ['rev-parse', 'HEAD']).stdout.trim();
    // 制造不一致 → 尝试提交 → 必须被拦
    const broken = original.replace(/\*\*(\d+)\s*项\s*\/\s*(\d+)\s*条判据[^*]*\*\*/, '**99 项 / $2 条判据**');
    fs.writeFileSync(README, broken, 'utf8');
    run('git', ['add', 'README.md']);
    const commit = run('git', ['commit', '-m', 'gate-selftest-should-be-blocked']);
    const headAfter = run('git', ['rev-parse', 'HEAD']).stdout.trim();

    // 【第 112 轮修】第一次跑时 ④ 是**假通过**：README 没被改 → git 因「无改动」失败 → 我误判成被拦。
    // 现在要求：非零退出 + HEAD 未变 + **输出里出现门禁的拦截语**（证明是 hook 拦的，不是没东西可提交）。
    const out = (commit.stdout || '') + (commit.stderr || '');
    const hookBlocked = /门禁未通过|commit-gate|不要提交/.test(out);
    const blocked = commit.status !== 0 && headAfter === headBefore && hookBlocked;
    t('④ 带红提交被 hook 拦下（HEAD 未变 + 有门禁拦截语）', blocked,
      'commitExit=' + commit.status + ' headChanged=' + (headAfter !== headBefore) + ' hookMsg=' + hookBlocked);

    if (!blocked && headAfter !== headBefore) {
      // 意外提交成功 → 立刻撤销，绝不留下坏提交
      run('git', ['reset', '--soft', 'HEAD~1']);
      console.log('        ⚠ 已用 git reset --soft HEAD~1 撤销意外提交');
    }
    // 清理：恢复 README、取消暂存
    fs.writeFileSync(README, original, 'utf8');
    run('git', ['reset', 'HEAD', '--', 'README.md']);
    // 只核对「根 README.md」本身：工作树里可能有与本次用例无关的脏文件，
    // 例如未跟踪的 prototype/agent-ui/README.md，用全量 status 做 /README\.md/ 会把它误判成残留。
    const st = run('git', ['status', '--porcelain', '--', 'README.md']).stdout.trim();
    t('④ 清理后工作树回到测试前状态（README 无残留改动）', st === '', st.slice(0, 120));
  }
} finally {
  fs.writeFileSync(README, original, 'utf8');
  run('git', ['reset', 'HEAD', '--', 'README.md']);
}

console.log('  ' + '─'.repeat(64));
console.log(`  结果：通过 ${pass} · 失败 ${fail}`);
console.log('  四态: ' + (fail === 0 ? 'PASS' : 'FAIL'));
process.exit(fail === 0 ? 0 : 1);