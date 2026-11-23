/**
 * A1 代码编辑与 diff 应用验证 —— 重点是「改错要能发现」。
 *
 * 【为什么这条要紧】补丁应用最容易「看起来成功、实际改错」。所以全部判据都围绕
 * **失败必须可见且不留痕**：上下文不匹配 → 整文件放弃、一个字节都不改。
 * 反例占一半以上。
 *
 * 用法：node tools/agent/verify-a1-patch.mjs   四态：0 PASS / 1 FAIL / 2 UNKNOWN
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createToolkit, pickTools } from './toolkit.mjs';
import { parsePatch, applyPatch } from './patch.mjs';
import { beginSet, endSet, makeChangesetHooks, rollbackSet } from './changeset.mjs';

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};
const un = (s) => String(s).replace(/\r\n/g, '\\r\\n').replace(/\n/g, '\\n');

console.log('');
console.log('  A1 代码编辑与 diff 应用验证');
console.log('  ' + '─'.repeat(72));

// ══ 一、解析与工具面 ══
{
  const p = parsePatch(['--- a/x.txt', '+++ b/x.txt', '@@ -1,2 +1,3 @@', ' a', '+b', ' c', ''].join('\n'));
  t('能解析 unified diff 的文件与 hunk', p.length === 1 && p[0].path === 'x.txt' && p[0].hunks.length === 1,
    JSON.stringify(p));
  t('★解析器忽略 /dev/null（新增文件的旧侧）',
    parsePatch(['--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,1 @@', '+hello', ''].join('\n'))
      .every((f) => f.path !== '/dev/null'));
  const tk = createToolkit({ cwd: process.cwd() });
  t('toolkit 里有 apply_patch', Boolean(tk.apply_patch));
  t('apply_patch 能按名装载（在 agent 工具面里）', pickTools(tk, ['apply_patch']).length === 1);
}

const dir = mkdtempSync(join(tmpdir(), 'a1-'));
try {
  const tk = createToolkit({ cwd: dir });
  const ctx = { cwd: dir };

  // ══ 二、正常应用（含行号与计数）══
  {
    writeFileSync(join(dir, 'a.txt'), 'line1\nline2\nline3\n', 'utf8');
    const patch = ['--- a/a.txt', '+++ b/a.txt', '@@ -1,3 +1,4 @@',
      ' line1', '-line2', '+line2-changed', '+line2b', ' line3', ''].join('\n');
    const r = await tk.apply_patch.call({ patch }, ctx);
    t('正常补丁 → PASS', r.state === 'PASS', r.state + ' ' + String(r.reason));
    t('内容正确', readFileSync(join(dir, 'a.txt'), 'utf8') === 'line1\nline2-changed\nline2b\nline3\n',
      un(readFileSync(join(dir, 'a.txt'), 'utf8')));
    t('added/removed 计数正确', r.files[0].added === 2 && r.files[0].removed === 1,
      JSON.stringify(r.files[0]));
  }

  // ══ 三、★上下文不匹配：必须整文件放弃、一个字节都不改 ══
  {
    const before = readFileSync(join(dir, 'a.txt'), 'utf8');
    const bad = ['--- a/a.txt', '+++ b/a.txt', '@@ -1,2 +1,2 @@',
      ' 完全不对的上下文', '-line2', '+XXX', ''].join('\n');
    const r = await tk.apply_patch.call({ patch: bad }, ctx);
    t('★上下文不匹配 → FAIL', r.state === 'FAIL', r.state);
    t('★失败时文件逐字节未变', readFileSync(join(dir, 'a.txt'), 'utf8') === before);
    t('★失败原因点明"上下文不匹配"', /不匹配/.test(String(r.reason) + JSON.stringify(r.files)),
      String(r.reason));
  }

  // ══ 四、反例：文件不存在 / 空补丁 / 伪造格式 ══
  {
    const r1 = await tk.apply_patch.call({ patch: ['--- a/nope.txt', '+++ b/nope.txt', '@@ -1,1 +1,1 @@', '-a', '+b', ''].join('\n') }, ctx);
    t('★反例：目标文件不存在 → FAIL', r1.state === 'FAIL' && /不存在/.test(JSON.stringify(r1.files)),
      JSON.stringify(r1.files));

    const r2 = await tk.apply_patch.call({ patch: '   ' }, ctx);
    t('★反例：空补丁 → FAIL', r2.state === 'FAIL');

    const r3 = await tk.apply_patch.call({ patch: '这不是补丁，只是随便一段文字' }, ctx);
    t('★反例：非 diff 格式 → FAIL 且说明原因', r3.state === 'FAIL' && /没解析出/.test(String(r3.reason)),
      String(r3.reason));
  }

  // ══ 五、dry_run：报告但不写盘 ══
  {
    const before = readFileSync(join(dir, 'a.txt'), 'utf8');
    const patch = ['--- a/a.txt', '+++ b/a.txt', '@@ -1,1 +1,1 @@', '-line1', '+LINE-ONE', ''].join('\n');
    const r = await tk.apply_patch.call({ patch, dry_run: true }, ctx);
    t('dry_run 报告可应用', r.state === 'PASS' && r.dryRun === true, r.state);
    t('★dry_run 不写盘（文件未变）', readFileSync(join(dir, 'a.txt'), 'utf8') === before);
  }

  // ══ 六、多文件：部分成功要 WARN 并逐文件报 ══
  {
    writeFileSync(join(dir, 'm1.txt'), 'one\n', 'utf8');
    writeFileSync(join(dir, 'm2.txt'), 'two\n', 'utf8');
    const patch = [
      '--- a/m1.txt', '+++ b/m1.txt', '@@ -1,1 +1,1 @@', '-one', '+ONE', '',
      '--- a/m2.txt', '+++ b/m2.txt', '@@ -1,1 +1,1 @@', '-不存在的行', '+TWO', '',
    ].join('\n');
    const r = await tk.apply_patch.call({ patch }, ctx);
    t('★多文件部分成功 → WARN（不是 PASS，也不整体失败）', r.state === 'WARN', r.state);
    t('★成功的那个文件真的被改了', readFileSync(join(dir, 'm1.txt'), 'utf8').trim() === 'ONE');
    t('★失败的那个文件没被改', readFileSync(join(dir, 'm2.txt'), 'utf8').trim() === 'two');
    t('逐文件结果可区分', r.files.filter((x) => x.ok).length === 1 && r.files.filter((x) => !x.ok).length === 1);
  }

  // ══ 七、行尾风格保留（CRLF 不被改成 LF）══
  {
    writeFileSync(join(dir, 'crlf.txt'), 'a\r\nb\r\n', 'utf8');
    const patch = ['--- a/crlf.txt', '+++ b/crlf.txt', '@@ -1,2 +1,2 @@', ' a', '-b', '+B', ''].join('\n');
    await tk.apply_patch.call({ patch }, ctx);
    const after = readFileSync(join(dir, 'crlf.txt'), 'utf8');
    t('★CRLF 文件保持 CRLF（不擅自改成 LF）', after === 'a\r\nB\r\n', un(after));
  }

  // ══ 八、变更集可回滚（真跑钩子）══
  {
    writeFileSync(join(dir, 'rb.txt'), 'orig\n', 'utf8');
    const set = beginSet({ cwd: dir, task: 'apply_patch 回滚测试' });
    const hooks = makeChangesetHooks(set);
    const patch = ['--- a/rb.txt', '+++ b/rb.txt', '@@ -1,1 +1,1 @@', '-orig', '+CHANGED', ''].join('\n');
    await tk.apply_patch.call({ patch }, { cwd: dir, changeset: hooks });
    t('带变更集时文件被改', readFileSync(join(dir, 'rb.txt'), 'utf8').trim() === 'CHANGED');
    const diff = endSet(set);
    t('变更集记录了这次改动', (diff.files || []).some((f) => String(f.path).includes('rb.txt')),
      JSON.stringify((diff.files || []).map((f) => f.path)));
    const rb = rollbackSet(set);
    t('★回滚能把文件恢复原样', readFileSync(join(dir, 'rb.txt'), 'utf8').trim() === 'orig',
      readFileSync(join(dir, 'rb.txt'), 'utf8').trim() + ' / ' + JSON.stringify(rb).slice(0, 80));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 补丁能应用且改错必被发现（不匹配零改动）；dry_run 不写盘；可回滚；行尾保留'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;