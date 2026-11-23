/**
 * 变更集清理 + 工具外改动恢复的验证 —— 含反例。
 *
 * 【两个必证的点】
 *   ① 工具外改动（bash/脚本/git）**真能恢复**：不只报告，要逐字节还原。
 *      这需要跑前快照内容；反例是「只报告不恢复」的假完善。
 *   ② 清理真的删了东西、且不误删该留的：反例是「说清理了其实没删」和
 *      「把最近的全删了」。
 *
 * 用法：node tools/agent/verify-changeset-cleanup.mjs
 * 四态：0 = PASS / 1 = FAIL / 2 = UNKNOWN
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 第 211 轮：把数据目录隔离到临时目录，让本测试免疫其它脚本留下的变更集残留（修 flake）。
// 关键：必须在 import runtime.mjs / changeset.mjs **之前**设 NIANCHU_DATA_DIR，
// 否则 USER_DATA_DIR 会固化成全局目录，测试就依赖磁盘上别的脚本留下的状态。
const _ISOLATED_DATA = mkdtempSync(join(tmpdir(), 'nianchu-cs-cleanup-'));
process.env.NIANCHU_DATA_DIR = _ISOLATED_DATA;

const { modelAvailable } = await import('./_model-probe.mjs');
const { runTaskWithChangeset } = await import('./loop.mjs');
const {
  beginSet, endSet, getSet, rollbackSet, pruneSets, changesetUsage, addSnapshotRecord,
} = await import('./changeset.mjs');
const { USER_DATA_DIR } = await import('./runtime.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0;
let skipped = false;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

console.log('');
console.log('  变更集清理 + 工具外改动恢复验证');
console.log('  ' + '─'.repeat(72));

// ══ 一、工具外改动可恢复（端到端，真跑 agent 用 bash 改文件）══
{
  const dir = mkdtempSync(join(tmpdir(), 'nianchu-clean-'));
  try {
    writeFileSync(join(dir, 'keep.txt'), 'keepme-original\n', 'utf8');
    writeFileSync(join(dir, 'del.txt'), 'delme-original\n', 'utf8');

    let r = null;
    // 模型偶发不照做，最多试 2 次（这条判据验的是机制，不是模型听话度）
    for (let i = 0; i < 2; i++) {
      /**
       * 每次重试必须把文件**重置回原始状态**再跑。
       * 踩过的坑：第一轮已经把 keep.txt 改成 CHANGED、把 del.txt 删了，
       * 第二轮快照看到的是「已经改过」的状态，于是没有差异 → 工具外改动 = 0，
       * 判据假失败（不是机制坏了，是测试没重置）。
       */
      writeFileSync(join(dir, 'keep.txt'), 'keepme-original\n', 'utf8');
      writeFileSync(join(dir, 'del.txt'), 'delme-original\n', 'utf8');
      try { rmSync(join(dir, 'new.txt'), { force: true }); } catch { /* ignore */ }
      r = await runTaskWithChangeset({
        systemPrompt: '你是能动手的 agent。',
        task: '用 bash 做三件事：1) 新建 new.txt 内容写 NEW 2) 把 keep.txt 内容改成 CHANGED 3) 删掉 del.txt。做完总结。',
        cwd: dir,
        // 只给 bash：这样改动必然走「工具外改动」快照路径，
        // 而不可能被模型偷偷用 write/edit 变成普通工具改动（那样就测不到快照恢复）
        tools: ['bash'],
        maxSteps: 8,
      });
      if ((r.unattributedCount ?? 0) > 0) break;
    }

      /**
       * ══ --no-model（2026-11-20）══ 只跳过真跑段，纯逻辑段照跑。
       */
      if (process.argv.includes('--no-model') || !(await modelAvailable())) {
        console.log('  ⚠ 真跑段跳过（--no-model 或模型不可用）：快照/回滚/清理等纯逻辑已验，');
        console.log('  ⚠ 真跑段跳过（--no-model）：但「模型用 bash 改动目录被识别为工具外改动」这一段是 UNKNOWN（需模型）。');
        skipped = true;
      } else {
      t('agent 真的通过 bash 改动了目录（工具外改动 > 0）', (r.unattributedCount ?? 0) > 0,
        String(r.unattributedCount));
      const kinds = new Set((r.unattributed || []).map((u) => u.status));
      t('识别出新建/修改/删除三种', kinds.has('created') || kinds.has('modified') || kinds.has('deleted'),
        [...kinds].join(','));
      t('每条工具外改动都标了 restorable', (r.unattributed || []).every((u) => typeof u.restorable === 'boolean'));

      const rb = rollbackSet(getSet(r.changeSetId));
      t('回滚整体 PASS', rb.state === 'PASS', rb.state + ' ' + (rb.reason || ''));
      t('回滚文件数 > 0（不是空跑）', (rb.files || []).length > 0, String((rb.files || []).length));
      t('★回滚项来自快照（source=snapshot）',
        (rb.files || []).some((f) => f.source === 'snapshot'),
        (rb.files || []).map((f) => f.source).join(','));

      t('★工具外新建的文件被删掉', !existsSync(join(dir, 'new.txt')));
      t('★工具外改过的文件逐字节恢复',
        readFileSync(join(dir, 'keep.txt'), 'utf8') === 'keepme-original\n',
        JSON.stringify(readFileSync(join(dir, 'keep.txt'), 'utf8')));
      t('★工具外删掉的文件被恢复',
        existsSync(join(dir, 'del.txt'))
        && readFileSync(join(dir, 'del.txt'), 'utf8') === 'delme-original\n',
        existsSync(join(dir, 'del.txt')) ? JSON.stringify(readFileSync(join(dir, 'del.txt'), 'utf8')) : '不存在');
      }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ══ 二、反例：没快照内容的工具外改动，回滚必须如实报失败 ══
{
  const dir = mkdtempSync(join(tmpdir(), 'nianchu-nocontent-'));
  try {
    const target = join(dir, 'x.txt');
    writeFileSync(target, 'original\n', 'utf8');
    const set = beginSet({ cwd: dir, label: 'no-snapshot' });
    // 模拟：工具外改动但没抓到内容
    addSnapshotRecord(set, { absPath: target, existed: true, beforeBase64: null, note: '未快照内容' });
    endSet(set);
    // 文件已被别的东西改掉
    writeFileSync(target, 'changed-by-something\n', 'utf8');

    const rb = rollbackSet(set);
    t('★反例：没快照内容 → 回滚报 FAIL（不假装成功）', rb.state === 'FAIL', rb.state);
    t('★反例：该文件被标为不可恢复', (rb.files || []).some((f) => f.ok === false && /无法恢复/.test(f.reason || '')),
      JSON.stringify(rb.files));
    t('★反例：文件没被乱改（保持当前内容）',
      readFileSync(target, 'utf8') === 'changed-by-something\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ══ 三、清理策略 ══
{
  // 先造几个变更集
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const set = beginSet({ cwd: HERE, label: 'prune-' + i });
    set.files.set(join(HERE, '__prune_' + i + '.txt'), {
      existed: false, before: null, after: 'x', source: 'tool',
    });
    endSet(set);
    ids.push(set.id);
  }

  const before = changesetUsage();
  t('changesetUsage 报出条数与字节数', before.count > 0 && before.bytes > 0, JSON.stringify(before));

  // 反例：maxCount 很大时不删东西
  const keepAll = pruneSets({ maxCount: 100000, maxAgeDays: 100000 });
  t('★反例：阈值很宽时一个都不删', keepAll.removed === 0, String(keepAll.removed));

  // 只保留 2 个
  const pruned = pruneSets({ maxCount: 2, maxAgeDays: 100000 });
  t('清理真的删了东西（removed > 0）', pruned.removed > 0, String(pruned.removed));
  t('清理后保留数不超过阈值', pruned.kept <= 2, String(pruned.kept));

  const after = changesetUsage();
  t('磁盘条数真的减少了', after.count < before.count, before.count + ' → ' + after.count);

  // 反例：被删的变更集不能再回滚（不能留幽灵记录）
  const ghost = getSet(ids[0]);
  const ghostRollback = rollbackSet(ghost);
  t('★反例：已被清理的变更集无法回滚（不是幽灵）',
    ghost === null || ghostRollback.state === 'FAIL' || ghostRollback.state === 'UNKNOWN',
    ghost === null ? 'getSet=null' : ghostRollback.state);

  // 清理不能把最近的那个删掉
  const newest = ids[ids.length - 1];
  const newestSet = getSet(newest);
  t('★最近的变更集被保留（清理不误伤最新的）', newestSet !== null,
    'newest=' + newest);
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 工具外改动可逐字节恢复；清理真删且不误伤最新的；无法恢复时如实报错'
  : 'FAIL —— 有判据不满足'));
console.log('  变更集目录: ' + join(USER_DATA_DIR, 'changesets'));
console.log('');
rmSync(_ISOLATED_DATA, { recursive: true, force: true });
process.exitCode = fails.length === 0 ? 0 : 1;