/**
 * 变更集持久化验证：**跨进程**能回滚。
 *
 * 【为什么必须跨进程】之前变更集只在内存里，服务一重启就没了 ——
 * "你刚才让 agent 改的那批文件，重启后回滚不了"。
 * 这个脚本分两个独立 node 进程跑：
 *   进程 A：改文件、拿到 setId、写出状态文件
 *   进程 B：（全新进程，内存是空的）按 setId 回滚，并校验文件恢复
 * 只有 B 能成功，才算真的持久化。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const modUrl = (p) => pathToFileURL(join(REPO, p)).href;

const work = mkdtempSync(join(tmpdir(), 'nianchu-persist-'));
const target = join(work, 'conf.ini');
const ORIGINAL = 'port=8080\ndebug=false\n';
writeFileSync(target, ORIGINAL, 'utf8');

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

console.log('');
console.log('  变更集跨进程持久化验证');
console.log('  工作目录: ' + work);
console.log('  ' + '─'.repeat(72));

try {
  // ── 进程 A：改文件，输出 setId ──
  const writer = join(work, '_writer.mjs');
  writeFileSync(writer, `
import { createToolkit } from ${JSON.stringify(modUrl('tools/agent/toolkit.mjs'))};
import { beginSet, endSet, makeChangesetHooks } from ${JSON.stringify(modUrl('tools/agent/changeset.mjs'))};
const cwd = ${JSON.stringify(work)};
const set = beginSet({ cwd, label: 'persist-test' });
const tk = createToolkit({ cwd, changeset: makeChangesetHooks(set) });
await tk.edit.call({ file_path: 'conf.ini', old_string: 'port=8080', new_string: 'port=9090' }, { cwd });
const diff = endSet(set);
console.log(JSON.stringify({ setId: set.id, persisted: diff.persisted, files: diff.files.length }));
`, 'utf8');

  const a = spawnSync(process.execPath, [writer], { encoding: 'utf8', cwd: REPO });
  let aOut = null;
  try { aOut = JSON.parse(String(a.stdout).trim().split('\n').pop()); } catch { aOut = null; }
  t('进程 A 跑通并返回 setId', Boolean(aOut && aOut.setId), String(a.stderr).slice(0, 160));
  t('变更集写盘成功（persisted=true）', aOut?.persisted === true, String(aOut?.persisted));
  t('进程 A 里文件确实被改了', readFileSync(target, 'utf8').includes('port=9090'));

  const setId = aOut?.setId;

  // ── 进程 B：全新进程（内存空），按 setId 回滚 ──
  if (setId) {
    const reader = join(work, '_reader.mjs');
    writeFileSync(reader, `
import { getSet, rollbackSet } from ${JSON.stringify(modUrl('tools/agent/changeset.mjs'))};
const set = getSet(${JSON.stringify(setId)});
if (!set) { console.log(JSON.stringify({ found: false })); process.exit(0); }
const rb = rollbackSet(set);
console.log(JSON.stringify({ found: true, state: rb.state, files: (rb.files || []).length }));
`, 'utf8');

    const b = spawnSync(process.execPath, [reader], { encoding: 'utf8', cwd: REPO });
    let bOut = null;
    try { bOut = JSON.parse(String(b.stdout).trim().split('\n').pop()); } catch { bOut = null; }
    t('★进程 B（全新，内存为空）仍能按 setId 找到变更集', bOut?.found === true, String(bOut));
    t('★进程 B 能成功回滚', bOut?.state === 'PASS', String(bOut?.state));
    t('★进程 B 回滚后文件**逐字节**恢复成原始内容',
      readFileSync(target, 'utf8') === ORIGINAL, JSON.stringify(readFileSync(target, 'utf8')));
  }

  // ── 反例：回滚状态也要持久化（重启后不能又回滚一次） ──
  if (setId) {
    const again = join(work, '_again.mjs');
    writeFileSync(again, `
import { getSet, rollbackSet } from ${JSON.stringify(modUrl('tools/agent/changeset.mjs'))};
const set = getSet(${JSON.stringify(setId)});
const rb = rollbackSet(set);
console.log(JSON.stringify({ state: rb.state }));
`, 'utf8');
    const c = spawnSync(process.execPath, [again], { encoding: 'utf8', cwd: REPO });
    let cOut = null;
    try { cOut = JSON.parse(String(c.stdout).trim().split('\n').pop()); } catch { cOut = null; }
    t('★反例：再开一个进程重复回滚 → WARN（已回滚状态也被持久化）',
      cOut?.state === 'WARN', String(cOut?.state));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 变更集落盘，跨进程可回滚且逐字节精确'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;