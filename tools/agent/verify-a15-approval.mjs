#!/usr/bin/env node
/**
 * A15 验收（第 111 轮）—— **如实记录「什么强制了、什么故意没做」**。
 *
 * 【背景】A15 是「审批闸与危险命令拦截（能否挡住等价分解）」。
 * 但本项目的既定边界是：**只自用、不做账号隔离、不做越界拦截类安全机制**。
 * 所以 A15 的自评只能是「部分」——而「部分」必须能说清是哪一部分。
 *
 * 本验收断言两件事，两者都必须为真才算诚实：
 *   一、**已强制的**（真跑验证）：超时会杀进程；env 走白名单（*_SECRET 被剥）
 *   二、**故意没做的**（行为验证）：危险命令不会被拦截；没有审批闸工具
 *
 * 为什么要把「没做」也写成断言：否则将来我可能凭印象说「有安全闸」，
 * 或者反过来以为「没做所以没法验」。把边界钉成可跑的测试，比写在文档里可靠。
 *
 * 四态：0 全通过（边界与描述一致）· 1 有失败 · 2 无法执行
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToolkit, buildSandboxEnv } from './toolkit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0, fail = 0;
const t = (n, c, i = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (i ? ' ← ' + i : '')); } };

console.log('');
console.log('  A15 验收：审批闸与危险命令拦截（记录「已强制 / 故意未做」）');
console.log('  ' + '─'.repeat(70));

const tk = createToolkit({ cwd: ROOT });
// createToolkit 返回的是 {bash, read, write, ...} 形式的对象（不是 {tools:[...]}）
const names = Object.keys(tk);
const execTool = tk.bash || tk.exec;
if (!execTool || typeof execTool.call !== 'function') { console.error('  ❔ 找不到 bash 工具（需有 call 方法）→ UNKNOWN'); process.exit(2); }

// ── 一、已强制的 ──
// ① 超时会杀进程（跑 3 秒，给 1000ms）
{
  const started = Date.now();
  const r = await execTool.call({ command: 'node -e "setTimeout(()=>{},3000)"', timeout_ms: 1000 }, { cwd: ROOT });
  const ms = Date.now() - started;
  const text = JSON.stringify(r);
  t('① 超时会中断（3s 命令给 1s 超时，耗时 < 2.5s）', ms < 2500, '实际 ' + ms + 'ms');
  // 精确字段：timed_out=true 且 ok=false（不是靠字面里出现 "timeout" 字样）
  t('① 超时结果标记 timed_out=true 且 ok=false（不假装成功）', r.timed_out === true && r.ok === false, text.slice(0, 90));
}

// ② env 白名单：*_SECRET 被剥
{
  const env = buildSandboxEnv({ PATH: 'x', MY_SECRET: 's', SOME_API_KEY: 'k', HOME: '/h', UNRELATED_VAR: 'u' });
  t('② env 白名单：MY_SECRET 被剥', !('MY_SECRET' in env));
  t('② env 白名单：SOME_API_KEY 被剥', !('SOME_API_KEY' in env));
  t('② env 白名单：PATH/HOME 保留', env.PATH === 'x' && env.HOME === '/h');
  t('② env 白名单：无关变量也不放行（白名单而非黑名单）', !('UNRELATED_VAR' in env));
}

// ── 二、故意没做的（如实钉住边界）──
// ③ 危险命令不会被拦截：用一条**无害**命令模拟（echo 里带危险字样），确认原样执行
{
  const r = await execTool.call({ command: 'node -e "console.log(\'rm -rf / --no-preserve-root\')"', timeout_ms: 15000 }, { cwd: ROOT });
  const text = JSON.stringify(r);
  t('③ 危险字样不被拦截（原样执行，说明没有 denylist）', text.includes('rm -rf / --no-preserve-root'), text.slice(0, 120));
}

// ④ 没有审批闸工具
{
  const approvalish = names.filter((n) => /approv|confirm|consent|授权|审批/i.test(n));
  t('④ 工具表里没有审批/确认类工具（A15 未实现审批闸）', approvalish.length === 0, approvalish.join(','));
}

// ⑤ 源码里没有危险命令 denylist（扫描器自检：能识别「如果有」）
{
  const src = fs.readFileSync(path.join(ROOT, 'tools/agent/toolkit.mjs'), 'utf8');
  const hasDeny = /DENY_PATTERNS|DANGEROUS_COMMANDS|blockedCommands/i.test(src);
  t('⑤ toolkit.mjs 里没有危险命令 denylist', hasDeny === false);
  // 自检：同一正则用在合成字符串上必须能识别出来
  const probe = 'const DENY_PATTERNS = [/rm -rf/];';
  t('⑤ 自检：扫描器能识别出「如果有 denylist」', /DENY_PATTERNS|DANGEROUS_COMMANDS|blockedCommands/i.test(probe) === true);
}

console.log('  ' + '─'.repeat(70));
console.log('  结论：A15 = **部分**。已强制：超时中断、env 白名单。');
console.log('        未做（有意）：危险命令 denylist、审批闸 —— 符合「不做越界拦截类安全机制」的既定边界。');
console.log(`  结果：通过 ${pass} · 失败 ${fail}`);
console.log('  四态: ' + (fail === 0 ? 'PASS' : 'FAIL'));
process.exit(fail === 0 ? 0 : 1);