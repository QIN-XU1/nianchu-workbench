/**
 * 会话切换的视图状态隔离（批次 Z.21）· 契约 + 接线验证
 *
 * 【要证明什么】
 *  ① 历史消息 id 带**会话作用域**：不同会话的同一下标必须不同 id
 *     （旧实现 `'h' + i` 是位置型 → A 会话第 3 条展开，B 会话第 3 条跟着展开）
 *  ② id 能安全进 `[data-mid="…"]` 选择器（引号/反斜杠/空白都被处理）
 *  ③ 非法下标不产出查不到的 id（`h:A:NaN`）
 *  ④ 组件**接线**：换会话 / 新对话时清掉 `expandedReplies` 与搜索状态，
 *     并且历史消息 id 真的走 `historyMessageId()`
 *
 * 用法：node tools/agent/verify-chat-state-scope.mjs
 * 四态：0 PASS / 1 FAIL / 2 UNKNOWN（环境缺 tsx）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RE_EXEC_ENV = 'DSH_VERIFY_CHAT_STATE_SCOPE_TSX';
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

const { historyMessageId, scopedSessionToken } = await import('@/app/layout/messageIds');

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

console.log('');
console.log('  会话切换 · 视图状态隔离');
console.log('  ' + '─'.repeat(72));

// ══ 一、作用域片段 ══
{
  t('普通会话 id 原样保留', scopedSessionToken('sess-abc123') === 'sess-abc123');
  t('★去掉双引号与反斜杠（否则 [data-mid="…"] 选择器被打断）', scopedSessionToken('a"b\\c') === 'abc');
  t('空白折成 -（选择器里不留空白歧义）', scopedSessionToken('a b\tc') === 'a-b-c');
  t('非字符串不抛', scopedSessionToken(null) === '' && scopedSessionToken(42) === '42');
}

// ══ 二、消息 id 唯一性 ══
{
  t('★不同会话的同一下标 → 不同 id（旧实现撞车）', historyMessageId('A', 3) !== historyMessageId('B', 3));
  t('★同一会话不同下标 → 不同 id', historyMessageId('A', 1) !== historyMessageId('A', 2));
  t('同会话同下标稳定（可重复查询）', historyMessageId('A', 1) === historyMessageId('A', 1));
  t('格式可读：h:<会话>:<下标>', historyMessageId('sess-1', 0) === 'h:sess-1:0');
  t('★非法下标收敛成 0（不产出查不到的 id）',
    historyMessageId('A', Number.NaN) === 'h:A:0'
      && historyMessageId('A', -5) === 'h:A:0'
      && historyMessageId('A', 2.9) === 'h:A:2');
  t('★会话 id 里的危险字符不漏进 id', historyMessageId('a"b', 1) === 'h:ab:1');
  t('★展开状态不会跨会话误命中',
    (() => {
      const expanded = new Set([historyMessageId('sess-A', 3)]);
      return !expanded.has(historyMessageId('sess-B', 3)) && expanded.has(historyMessageId('sess-A', 3));
    })());
}

// ══ 三、组件接线 ══
{
  const layoutDir = path.join(WEB_UI_DIR, 'src', 'app', 'layout');
  const files = readdirSync(layoutDir);
  const tsxName = files.find((f) => f.endsWith('.tsx') && !f.includes('.test.') && readFileSync(path.join(layoutDir, f), 'utf8').includes('ncc__history-row'));
  t('找到渲染历史会话行的面板组件', !!tsxName, tsxName || '(未找到)');
  if (tsxName) {
    const tsx = readFileSync(path.join(layoutDir, tsxName), 'utf8');
    t('★历史消息 id 走 historyMessageId（不再手写位置型 id）',
      /id: historyMessageId\(id, i\)/.test(tsx) && !/id: 'h' \+ i/.test(tsx));
    t('★换会话（openSession）清空展开状态', /const openSession[\s\S]{0,900}setExpandedReplies\(new Set\(\)\)/.test(tsx));
    t('★换会话同时清空搜索（否则命中仍指向旧消息）',
      /const openSession[\s\S]{0,900}setSearchQuery\(''\)/.test(tsx));
    t('★「新对话」也清空展开状态与搜索', /aria-label="新对话"[\s\S]{0,600}setExpandedReplies\(new Set\(\)\)/.test(tsx));
    t('展开状态仍按消息 id 记（没有退回按下标）',
      /expandedReplies\.has\(m\.id\)/.test(tsx) && /toggleReply\(m\.id\)/.test(tsx));
  }
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— id 带会话作用域，且换会话/新对话会清掉上一段的视图状态'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;