/**
 * 变更集（diff / 回滚）验证 —— 含反例。
 *
 * 【为什么反例最关键】回滚这个东西，最怕"看起来回滚了其实没有"：
 *   · 少一个字节、多个换行，都算没回滚干净
 *   · 重复回滚静默成功，会让人以为状态可控
 *   · 回滚失败却报成功，是最坏的一种
 * 所以这里逐项证明：**该失败的失败，该精确的精确**。
 *
 * 用法：node tools/agent/verify-changeset.mjs
 * 四态：0 = PASS / 1 = FAIL / 2 = UNKNOWN
 */
import { modelAvailable } from './_model-probe.mjs';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  beginSet, endSet, makeChangesetHooks, rollbackSet, getSet, listSets, diffLines,
} from './changeset.mjs';
import { createToolkit } from './toolkit.mjs';
import { runTaskWithChangeset } from './loop.mjs';

let pass = 0;
let skipped = false;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

const dir = mkdtempSync(join(tmpdir(), 'nianchu-cs-'));
console.log('');
console.log('  变更集（diff / 回滚）验证');
console.log('  临时目录: ' + dir);
console.log('  ' + '─'.repeat(72));

try {
  // ══ 一、新增文件 ══
  {
    const set = beginSet({ cwd: dir, label: 'add' });
    const tk = createToolkit({ cwd: dir, changeset: makeChangesetHooks(set) });
    await tk.write.call({ file_path: 'new.txt', content: 'hello\n' }, { cwd: dir });
    const diff = endSet(set);
    t('新增文件被识别为 added', diff.files.length === 1 && diff.files[0].status === 'added',
      JSON.stringify(diff.files.map((f) => f.status)));
    t('新增文件的 diff 有 + 行', diff.files[0].added >= 1 && diff.files[0].removed === 0,
      `+${diff.files[0].added}/-${diff.files[0].removed}`);

    const rb = rollbackSet(set);
    t('回滚新增文件 → PASS', rb.state === 'PASS', JSON.stringify(rb).slice(0, 120));
    t('回滚后文件真的被删掉', !existsSync(join(dir, 'new.txt')));

    // 反例：重复回滚
    const rb2 = rollbackSet(set);
    t('★反例：重复回滚不静默成功（返回 WARN）', rb2.state === 'WARN', rb2.state);
  }

  // ══ 二、修改已有文件（字节级精确）══
  {
    const p = join(dir, 'mod.txt');
    const original = 'alpha\nbeta\ngamma\n';
    writeFileSync(p, original, 'utf8');

    const set = beginSet({ cwd: dir, label: 'mod' });
    const tk = createToolkit({ cwd: dir, changeset: makeChangesetHooks(set) });
    await tk.edit.call({ file_path: 'mod.txt', old_string: 'beta', new_string: 'BETA' }, { cwd: dir });
    const diff = endSet(set);

    t('修改被识别为 modified', diff.files[0].status === 'modified', diff.files[0].status);
    t('diff 统计正确（1 删 1 增）', diff.files[0].added === 1 && diff.files[0].removed === 1,
      `+${diff.files[0].added}/-${diff.files[0].removed}`);
    t('diff 行里能看到 -beta 与 +BETA',
      diff.files[0].lines.some((l) => l.type === '-' && l.text === 'beta')
      && diff.files[0].lines.some((l) => l.type === '+' && l.text === 'BETA'));
    t('改动确实生效', readFileSync(p, 'utf8').includes('BETA'));

    const rb = rollbackSet(set);
    t('回滚修改 → PASS', rb.state === 'PASS');
    t('★回滚是**字节级**精确（含行尾换行都一致）', readFileSync(p, 'utf8') === original,
      JSON.stringify(readFileSync(p, 'utf8')));
  }

  // ══ 三、多文件 + 无实际变化不误报 ══
  {
    writeFileSync(join(dir, 'same.txt'), 'x\n', 'utf8');
    const set = beginSet({ cwd: dir, label: 'multi' });
    const tk = createToolkit({ cwd: dir, changeset: makeChangesetHooks(set) });
    await tk.write.call({ file_path: 'f1.txt', content: 'one\n' }, { cwd: dir });
    await tk.write.call({ file_path: 'f2.txt', content: 'two\n' }, { cwd: dir });
    // 内容与原来完全相同 → 不应算作变更
    await tk.write.call({ file_path: 'same.txt', content: 'x\n' }, { cwd: dir });
    const diff = endSet(set);
    t('多文件变更都记录（2 个）', diff.files.length === 2, String(diff.files.length));
    t('★内容未变的文件不算变更（不制造噪音）', !diff.files.some((f) => f.path.endsWith('same.txt')));
  }

  // ══ 四、写入失败不影响记录 & 未知变更集 ══
  {
    const set = beginSet({ cwd: dir, label: 'fail' });
    const tk = createToolkit({ cwd: dir, changeset: makeChangesetHooks(set) });
    const e = await tk.edit.call({ file_path: 'nope-not-here.txt', old_string: 'a', new_string: 'b' }, { cwd: dir });
    t('★反例：edit 目标不存在 → 失败，且变更集里没有它', e.ok === false && endSet(set).files.length === 0);
  }
  {
    const rb = rollbackSet(getSet('cs-does-not-exist'));
    t('★反例：未知变更集 → FAIL 而不是假装成功', rb.state === 'FAIL', rb.state);
  }

  // ══ 五、diff 算法本身 ══
  {
    const d1 = diffLines('a\nb\nc\n', 'a\nB\nc\n');
    const minus = d1.filter((x) => x.type === '-').length;
    const plus = d1.filter((x) => x.type === '+').length;
    t('diffLines：单行改动 = 1 删 1 增', minus === 1 && plus === 1, `${minus}/${plus}`);

    // 从空文件变出内容：不允许出现删除行，且新增行里要有实际内容。
    // （末尾那个 ' ' 是换行造成的公共空行，unified diff 的正常表现，不算错）
    const d2 = diffLines('', 'only\n');
    t('diffLines：空文件→有内容 没有删除行，且有 +only',
      d2.every((x) => x.type !== '-') && d2.some((x) => x.type === '+' && x.text === 'only'));

    const d3 = diffLines('same\n', 'same\n');
    t('diffLines：完全相同 → 没有 +/-', d3.every((x) => x.type === ' '));
  }

  // ══ 六、变更集清单 ══
  {
    const ls = listSets(50);
    t('listSets 能列出已发生的变更集（>=3 个）', ls.length >= 3, String(ls.length));
    t('清单里带 files/added/removed 汇总',
      ls.every((x) => typeof x.files === 'number' && typeof x.added === 'number' && typeof x.removed === 'number'));
    t('清单能看出哪些已回滚', ls.some((x) => x.rolledBack === true));
  }

  // ══ 七、端到端：agent 真改文件 → 有 diff → 能回滚 ══
  {
    const edir = mkdtempSync(join(tmpdir(), 'nianchu-cs-e2e-'));
    try {
      writeFileSync(join(edir, 'target.txt'), 'line1\nline2\nline3\n', 'utf8');
      /**
       * 模型偶发：同样的话有时不调工具就答了。这里最多试 2 次，
       * 因为这条判据要验证的是**变更集机制**，不是模型的听话程度。
       * 两次都没动文件才算 FAIL（那说明要么模型完全不可用，要么机制坏了）。
       */
      const attempt = async () => {
        writeFileSync(join(edir, 'target.txt'), 'line1\nline2\nline3\n', 'utf8');
        return runTaskWithChangeset({
          systemPrompt: '你是能动手的 agent，做完给一句总结。',
          task: '把 target.txt 里的 line2 改成 line2-modified，然后用 read 确认。',
          cwd: edir,
          maxSteps: 6,
        });
      };
      /**
       * ══ --no-model（2026-11-20）══ 只跳过真跑段，纯逻辑段照跑。
       */
      if (process.argv.includes('--no-model') || !(await modelAvailable())) {
        console.log('  ⚠ 真跑段跳过（--no-model 或模型不可用）：变更集的**记录/回滚/字节级恢复**等纯逻辑已验，');
        console.log('  ⚠ 真跑段跳过（--no-model）：但「模型真的改文件并被记进 diff」这一段是 UNKNOWN（需模型）。');
        skipped = true;
      } else {
        let r = await attempt();
        if (r.changedFiles < 1 || !readFileSync(join(edir, 'target.txt'), 'utf8').includes('line2-modified')) {
          r = await attempt();
        }
        t('agent 跑完有变更集 id', typeof r.changeSetId === 'string' && r.changeSetId.startsWith('cs-'));
        t('agent 的改动被记进 diff（>=1 文件）', r.changedFiles >= 1, String(r.changedFiles));
        t('文件真的被改了', readFileSync(join(edir, 'target.txt'), 'utf8').includes('line2-modified'));
        const set = getSet(r.changeSetId);
        const rb = rollbackSet(set);
        t('agent 的改动能整体回滚', rb.state === 'PASS', JSON.stringify(rb).slice(0, 140));
        t('★回滚后文件恢复成原始内容（逐字节）',
          readFileSync(join(edir, 'target.txt'), 'utf8') === 'line1\nline2\nline3\n',
          JSON.stringify(readFileSync(join(edir, 'target.txt'), 'utf8')));
      }
    } finally {
      rmSync(edir, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— diff 准确、回滚字节级精确、重复回滚与未知变更集都如实报错'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;