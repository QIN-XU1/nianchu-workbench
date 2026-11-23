#!/usr/bin/env node
/**
 * 记忆库损坏保护验证 —— 库文件损坏时必须「拒绝继续」，绝不能用空库覆盖它。
 *
 * 【背景】第 95 轮扫静默吞异常时发现 `tools/memory/bulk.mjs` 把
 * 「文件存在但解析失败（损坏）」当成「新库」，继续跑会用空库覆盖损坏文件 → **静默丢数据**。
 * 修复后本文件做**端到端**验证（真跑 bulk，带备份/恢复）：
 *   ① 损坏库 → exit 2 且提示「疑似损坏」「拒绝继续」
 *   ② 损坏库文件**内容未被改动**（没被空库覆盖）
 *   ③ 顺带：输入文件带 BOM 时也能读（Windows 常见）
 *   ④ 正常库 + 正常输入 → 能正常执行（证明不是「一律拒绝」）
 *
 * 安全：全程 try/finally 备份并恢复真库；任何异常都恢复。
 * 四态：0 全通过 · 1 有失败 · 2 无法执行
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STORE = path.join(ROOT, 'evidence/memory/store.json');
const BAK = STORE + '.verifybak';
const INP = path.join(ROOT, 'evidence/memory/_verify_input.json');

let pass = 0, fail = 0;
const t = (n, c, i = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (i ? ' ← ' + i : '')); } };

if (!fs.existsSync(STORE)) { console.error('  ❔ 没有记忆库文件，无法验证 → UNKNOWN'); process.exit(2); }

const origSize = fs.statSync(STORE).size;
console.log('');
console.log('  记忆库损坏保护（端到端，带备份恢复）');
console.log('  ' + '─'.repeat(64));

try {
  fs.copyFileSync(STORE, BAK);

  // ① 损坏库 → 必须拒绝
  fs.writeFileSync(INP, JSON.stringify([{ key: 'verify-k', value: 'v', source: 'verify' }]), 'utf8');
  fs.writeFileSync(STORE, '{ corrupt not json', 'utf8');
  const r1 = spawnSync(process.execPath, [path.join(ROOT, 'tools/memory/bulk.mjs'), '--file=' + INP], { cwd: ROOT, encoding: 'utf8' });
  const out1 = (r1.stdout || '') + (r1.stderr || '');
  t('① 损坏库 → 拒绝继续（exit 2）', r1.status === 2, 'exit=' + r1.status);
  t('① 提示含「疑似损坏」与「拒绝继续」', /疑似损坏/.test(out1) && /拒绝继续/.test(out1), out1.slice(0, 80).replace(/\s+/g, ' '));

  // ② 损坏文件未被覆盖
  const after = fs.readFileSync(STORE, 'utf8');
  t('② 损坏库内容未被空库覆盖', after.includes('corrupt not json'), '内容已变：' + after.slice(0, 40));

  // ③ BOM 输入可读（正常库 + BOM 输入）
  fs.copyFileSync(BAK, STORE);
  fs.writeFileSync(INP, '\uFEFF' + JSON.stringify([{ key: 'verify-bom', value: 'v', source: 'verify' }]), 'utf8');
  const r2 = spawnSync(process.execPath, [path.join(ROOT, 'tools/memory/bulk.mjs'), '--file=' + INP], { cwd: ROOT, encoding: 'utf8' });
  const out2 = (r2.stdout || '') + (r2.stderr || '');
  t('③ 带 BOM 的输入文件能读（不再因 BOM 直接失败）', !/不是合法 JSON|Unexpected token/.test(out2), out2.slice(0, 80).replace(/\s+/g, ' '));

  // ④ 正常路径没被破坏（读真库应成功进入处理阶段）
  t('④ 正常库可被读取（不是一律拒绝）', !/疑似损坏/.test(out2), out2.slice(0, 60).replace(/\s+/g, ' '));
} finally {
  if (fs.existsSync(BAK)) { fs.copyFileSync(BAK, STORE); fs.rmSync(BAK, { force: true }); }
  fs.rmSync(INP, { force: true });
  const sz = fs.statSync(STORE).size;
  console.log('  ' + '─'.repeat(64));
  console.log('  已恢复真库：' + sz + ' B（原 ' + origSize + ' B）');
  if (sz !== origSize) { console.log('  ✗ 恢复后大小不一致！'); fail++; }
}

console.log(`  结果：通过 ${pass} · 失败 ${fail}`);
console.log('  四态: ' + (fail === 0 ? 'PASS' : 'FAIL'));
process.exit(fail === 0 ? 0 : 1);