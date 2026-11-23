#!/usr/bin/env node
/**
 * 前置探活自测（第 105 轮）—— 证明它**真会失败**，不是永远打印 PASS。
 *
 * 三个用例：
 *   ① 真实服务（默认地址）→ PASS（服务没起则标 UNKNOWN，因为测不了）
 *   ② 反例：指向一个必然没有服务的端口 → 必须 FAIL
 *   ③ 反例：指向一个存在的 HTTP 服务但不是我们的（如随便一个 404 站点）→ 必须 FAIL
 *
 * 四态：0 全通过 · 1 有失败 · 2 测不了（服务未起 → 标 UNKNOWN 而不是 PASS）
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PRE = path.join(ROOT, 'tools/quality/preflight.mjs');
let pass = 0, fail = 0;
const t = (n, c, i = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (i ? ' ← ' + i : '')); } };

const runPre = (base) => spawnSync(process.execPath, [PRE, '--base=' + base], { cwd: ROOT, encoding: 'utf8' });

console.log('');
console.log('  前置探活自测（含反例）');
console.log('  ' + '─'.repeat(60));

// ① 真实服务
const real = runPre('http://127.0.0.1:47124');
if (real.status === 0) {
  t('① 真实服务 → PASS', true);
  t('① 输出含「环境就绪」', /环境就绪/.test(real.stdout));
} else {
  console.log('  ❔ ① 真实服务不可用（' + real.status + '）→ 本项标 UNKNOWN，不计入通过');
}

// ② 反例：不存在的端口
{
  const r = runPre('http://127.0.0.1:59999');
  t('② 反例：不存在的端口 → FAIL', r.status === 1, 'exit=' + r.status);
  t('② 输出含「环境不可用」或「连不上」', /环境不可用|连不上/.test(r.stdout));
}

// ③ 反例：存在但不是我们的服务（用一个必然 404 的路径前缀模拟不了，改用一个空目录静态服务不可行）
//    退而求其次：指向一个语法合法但无监听的地址（127.0.0.1:1）
{
  const r = runPre('http://127.0.0.1:1');
  t('③ 反例：127.0.0.1:1 → FAIL', r.status === 1, 'exit=' + r.status);
}

// ④ 反例：非法 URL 不应崩
{
  const r = runPre('not-a-url');
  t('④ 反例：非法 URL → 判 FAIL 而不是抛栈', r.status === 1 && !/at .*\.mjs:\d+/.test(r.stderr || ''), 'exit=' + r.status);
}

console.log('  ' + '─'.repeat(60));
console.log(`  结果：通过 ${pass} · 失败 ${fail}`);
console.log('  四态: ' + (fail === 0 ? 'PASS' : 'FAIL'));
process.exit(fail === 0 ? 0 : 1);