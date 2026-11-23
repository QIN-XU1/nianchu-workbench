#!/usr/bin/env node
/**
 * 静默 catch 白名单的「片段匹配」性质验证（第 106 轮）。
 *
 * 为什么需要：第 104 轮只加了 1 行 import，7 条按**行号**登记的白名单条目全部过期，
 * 一次无害编辑就把检查搞成红灯。改成**片段匹配**后必须证明两件事：
 *   ① 上下插入无关行 → 仍然全部匹配（不漂移）
 *   ② 真的把某个空 catch 改掉 → 必须报「过期」（不能永远绿）
 *
 * 做法：临时改一个真实文件（备份/恢复），跑扫描，断言输出。全程 try/finally 恢复。
 *
 * 四态：0 全通过 · 1 有失败 · 2 无法执行
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCAN = path.join(ROOT, 'tools/quality/scan-silent-catch.mjs');
const TARGET = path.join(ROOT, 'tools/agent/team.mjs');
const BAK = TARGET + '.wlverify.bak';

let pass = 0, fail = 0;
const t = (n, c, i = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (i ? ' ← ' + i : '')); } };
const scan = () => spawnSync(process.execPath, [SCAN], { cwd: ROOT, encoding: 'utf8' });
const tally = (r) => {
  const m = /未解释 (\d+) · 过期 (\d+)/.exec(r.stdout || '');
  return m ? { unexplained: Number(m[1]), stale: Number(m[2]) } : null;
};

if (!fs.existsSync(TARGET)) { console.error('  ❔ 目标文件不存在，无法验证'); process.exit(2); }

console.log('');
console.log('  静默 catch 白名单「片段匹配」性质验证');
console.log('  ' + '─'.repeat(64));

try {
  // 基线
  const base = scan();
  const bt = tally(base);
  t('基线：0 未解释 / 0 过期', base.status === 0 && bt && bt.unexplained === 0 && bt.stale === 0, JSON.stringify(bt));

  // ① 插入无关行 → 不应漂移
  fs.copyFileSync(TARGET, BAK);
  const lines = fs.readFileSync(TARGET, 'utf8').split(/\r?\n/);
  const injected = [lines[0], '// 验证插入行 A', '// 验证插入行 B', '// 验证插入行 C', ...lines.slice(1)].join('\n');
  fs.writeFileSync(TARGET, injected, 'utf8');
  const afterInsert = scan();
  const it = tally(afterInsert);
  t('① 插入 3 行后仍 0 未解释 / 0 过期（不漂移）', afterInsert.status === 0 && it && it.unexplained === 0 && it.stale === 0, JSON.stringify(it));
  fs.copyFileSync(BAK, TARGET);

  // ② 真的改掉那个空 catch → 必须报过期
  const orig = fs.readFileSync(TARGET, 'utf8');
  const changed = orig.replace('catch { /* 落盘失败不影响返回，但下面会标出来 */ }', 'catch (e) { void e; }');
  if (changed === orig) {
    t('② 前置：能定位到目标空 catch', false, '未匹配到预期片段');
  } else {
    fs.writeFileSync(TARGET, changed, 'utf8');
    const afterRemove = scan();
    const rt = tally(afterRemove);
    t('② 空 catch 被改掉 → 必须报过期（不能永远绿）', afterRemove.status === 1 && rt && rt.stale >= 1, JSON.stringify(rt));
  }
} finally {
  if (fs.existsSync(BAK)) { fs.copyFileSync(BAK, TARGET); fs.rmSync(BAK, { force: true }); }
}

// 恢复后复查
{
  const r = scan();
  const rt = tally(r);
  t('③ 恢复后回到基线（0/0）', r.status === 0 && rt && rt.unexplained === 0 && rt.stale === 0, JSON.stringify(rt));
}

console.log('  ' + '─'.repeat(64));
console.log(`  结果：通过 ${pass} · 失败 ${fail}`);
console.log('  四态: ' + (fail === 0 ? 'PASS' : 'FAIL'));
process.exit(fail === 0 ? 0 : 1);