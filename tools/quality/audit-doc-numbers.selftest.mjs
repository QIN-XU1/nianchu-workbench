#!/usr/bin/env node
/**
 * 文档数字巡检的自测 —— 证明「巡检真的会失败」，不是摆设。
 *
 * 反向验证（这是第 67 轮的重点）：如果巡检工具对错的数字也报 PASS，那它就是假绿。
 * 所以这里故意造一份写错数字的文档，断言巡检 exit=1；再造一份写对的，断言通过。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = path.join(ROOT, 'tools/quality/audit-doc-numbers.mjs');
let pass = 0, fail = 0;
const t = (name, cond, info = '') => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' ← ' + info : '')); } };

function run(file) {
  const r = spawnSync(process.execPath, [TOOL, '--file', file], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// 1) 写错数字的文档 → 必须 FAIL(1)
const bad = path.join(ROOT, 'tools/_selftest_bad.md');
fs.writeFileSync(bad, '# x\n这里有 999 个 RPC 方法。\n', 'utf8');
{
  const r = run('tools/_selftest_bad.md');
  t('写错数字(999≠77) → exit=1 FAIL', r.code === 1, 'code=' + r.code);
  t('报告指出不一致', /不一致|✗/.test(r.out));
}
fs.rmSync(bad, { force: true });

// 2) 写对数字（77）→ 不 FAIL（0 或 3）
const good = path.join(ROOT, 'tools/_selftest_good.md');
fs.writeFileSync(good, '# x\n这里有 77 个 RPC 方法。\n', 'utf8');
{
  const r = run('tools/_selftest_good.md');
  t('写对数字(77=77) → 不 FAIL', r.code === 0 || r.code === 3, 'code=' + r.code);
}
fs.rmSync(good, { force: true });

// 3) 真实文档：不得有任何「已映射数字不一致」（exit 不能是 1）
{
  const r = spawnSync(process.execPath, [TOOL], { cwd: ROOT, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  t('真实文档无已映射数字不一致（exit≠1）', r.status !== 1, 'code=' + r.status + ' ' + out.split('\n').filter((l) => l.includes('✗')).join(' | '));
}

console.log(`\n  结果：通过 ${pass} · 失败 ${fail}`);
console.log('  四态: ' + (fail === 0 ? 'PASS' : 'FAIL'));
process.exit(fail === 0 ? 0 : 1);