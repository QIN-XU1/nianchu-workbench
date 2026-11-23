/**
 * 工具步骤的 key（批次 Z.24）· 契约 + 接线验证
 *
 * 【要证明什么】
 *  ① key 由**内容**决定（工具名 + 成败 + 耗时 + 参数摘要），不是数组下标
 *  ② 插入一条新步骤时，已有步骤的 key 不变（下标 key 做不到）
 *  ③ 同工具同参数的两次调用不会撞 key（成败/耗时参与）
 *  ④ 组件接线：ToolSteps 用 stepKey 生成 key、不再 `key={i}`，且重复项补序号
 *
 * 为什么要紧：`<details>` 的展开态是 DOM 状态，不是受控属性。用下标当 key 时，
 * 步骤位移会让「用户点开的那条」和「实际展开的那条」错位 —— 展开框里变成另一条的内容。
 *
 * 用法：node tools/agent/verify-step-keys.mjs
 * 四态：0 PASS / 1 FAIL / 2 UNKNOWN（环境缺 tsx）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RE_EXEC_ENV = 'DSH_VERIFY_STEP_KEYS_TSX';
const WEB_UI_DIR = path.resolve(import.meta.dirname, '..', '..', 'apps', 'vouch-web', 'src', 'web-ui');
const PNPM_STORE = path.resolve(WEB_UI_DIR, '..', '..', 'node_modules', '.pnpm');

function findTsxCli() {
  let versions;
  try {
    versions = readdirSync(PNPM_STORE).filter((n) => /^tsx@\d/.test(n));
  } catch {
    return null;
  }
  versions.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  for (const dir of versions.reverse()) {
    const cli = path.join(PNPM_STORE, dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (existsSync(cli)) return cli;
  }
  return null;
}

if (process.env[RE_EXEC_ENV] !== '1') {
  const tsxCli = findTsxCli();
  if (!tsxCli) {
    console.error('');
    console.error('  四态: UNKNOWN —— 环境缺 tsx（本脚本要 import 界面实现，需 tsx 解析 `@/` 别名）');
    console.error('  修复: cd apps/vouch-web && pnpm install');
    console.error('');
    process.exit(2);
  }
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(process.execPath, [tsxCli, fileURLToPath(import.meta.url)], {
    cwd: WEB_UI_DIR,
    stdio: 'inherit',
    env: { ...process.env, [RE_EXEC_ENV]: '1' },
  });
  process.exit(typeof child.status === 'number' ? child.status : 2);
}

const { stepKey } = await import('@/app/layout/stepText');

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

console.log('');
console.log('  工具步骤 key · 契约 + 接线');
console.log('  ' + '─'.repeat(72));

// ══ 一、稳定性 ══
{
  const read = { tool: 'read', ok: true, ms: 10, input: { path: 'a.ts' } };
  const bash = { tool: 'bash', ok: true, ms: 20, input: { command: 'ls' } };
  t('★同一条步骤 key 稳定', stepKey(read) === stepKey({ ...read }));
  t('★插入新步骤不改变已有 key（下标 key 做不到）',
    JSON.stringify([stepKey({ tool: 'glob', input: { pattern: '*.ts' } }), stepKey(read), stepKey(bash)].slice(1))
      === JSON.stringify([stepKey(read), stepKey(bash)]));
  t('不同工具 → 不同 key', stepKey(read) !== stepKey(bash));
  t('同工具不同参数 → 不同 key',
    stepKey({ tool: 'read', input: { path: 'a.ts' } }) !== stepKey({ tool: 'read', input: { path: 'b.ts' } }));
  t('★成败进 key（同工具同参数、一次成功一次失败不会撞）',
    stepKey({ tool: 'bash', ok: true, ms: 10, input: { command: 'ls' } })
      !== stepKey({ tool: 'bash', ok: false, ms: 10, input: { command: 'ls' } }));
  t('★耗时进 key', stepKey({ tool: 'bash', ms: 10, input: { command: 'ls' } })
    !== stepKey({ tool: 'bash', ms: 20, input: { command: 'ls' } }));
  t('空步骤也能产出非空 key', stepKey({}) === 'tool|1||');
}

// ══ 二、组件接线 ══
{
  const layoutDir = path.join(WEB_UI_DIR, 'src', 'app', 'layout');
  const files = readdirSync(layoutDir);
  const tsxName = files.find((f) => f.endsWith('.tsx') && !f.includes('.test.') && readFileSync(path.join(layoutDir, f), 'utf8').includes('ncc-steps__head'));
  t('找到渲染工具步骤竖列的组件', !!tsxName, tsxName || '(未找到)');
  if (tsxName) {
    const tsx = readFileSync(path.join(layoutDir, tsxName), 'utf8');
    t('★用 stepKey 生成 key（不再按下标）', /stepKey\(s\)/.test(tsx) && !/key=\{i\}/.test(tsx));
    t('★重复步骤补序号（同内容两次调用不会撞 key）', /seen\.get\(base\)/.test(tsx) && /'#' \+ n/.test(tsx));
    t('渲染走 key 而不是下标', /rows\.map\(\(\{ s, i, key \}\)/.test(tsx) && /<details key=\{key\}/.test(tsx));
    t('步骤文本模块导出 stepKey', readFileSync(path.join(layoutDir, 'stepText.ts'), 'utf8').includes('export function stepKey'));
  }
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— key 由内容决定，步骤位移不再让展开态错位'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;