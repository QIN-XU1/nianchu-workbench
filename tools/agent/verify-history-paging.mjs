/**
 * 历史会话分页（批次 Z.22）· 契约 + 接线验证
 *
 * 【要证明什么】
 *  ① 首屏只渲染一页（本机会话近千条，一次全渲染会卡），但**能翻到底**
 *     —— 之前是硬截断 60 条 + 一句「仅显示最近 60 条」，更早的会话只能靠搜索撞运气
 *  ② 边界：上限不超过总数、非法输入不产出 NaN、加到头就停、到底后按钮消失
 *  ③ 组件接线：切片走 `visibleHistoryCount`、按钮走 `nextHistoryLimit`、
 *     文案走 `historyCountLabel`，且换查询/重开浮层会回到一页
 *
 * 用法：node tools/agent/verify-history-paging.mjs
 * 四态：0 PASS / 1 FAIL / 2 UNKNOWN（环境缺 tsx）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RE_EXEC_ENV = 'DSH_VERIFY_HISTORY_PAGING_TSX';
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

const {
  HISTORY_PAGE_SIZE,
  hasMoreHistory,
  historyCountLabel,
  nextHistoryLimit,
  visibleHistoryCount,
} = await import('@/app/layout/historyPaging');

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

console.log('');
console.log('  历史会话分页 · 契约 + 接线');
console.log('  ' + '─'.repeat(72));

// ══ 一、首屏与上限 ══
{
  t('页大小是 60', HISTORY_PAGE_SIZE === 60, HISTORY_PAGE_SIZE);
  t('首屏只渲染一页（近千条会话不一次塞进 DOM）', visibleHistoryCount(HISTORY_PAGE_SIZE, 996) === 60);
  t('总数比一页少 → 取总数（不渲染空行）', visibleHistoryCount(60, 12) === 12);
  t('上限超过总数 → 收敛到总数', visibleHistoryCount(5000, 996) === 996);
  t('非法输入不抛（NaN / 负数 / 字符串数字）',
    visibleHistoryCount(Number.NaN, 10) === 0
      && visibleHistoryCount(-5, 10) === 0
      && visibleHistoryCount('60', '12') === 12);
  t('小数向下取整', visibleHistoryCount(60.9, 100) === 60);
}

// ══ 二、翻页 ══
{
  t('★点一次「加载更多」加一页', nextHistoryLimit(60, 996) === 120);
  t('★加到头停在总数（不会超过）', nextHistoryLimit(960, 996) === 996 && nextHistoryLimit(996, 996) === 996);
  t('自定义步长', nextHistoryLimit(60, 996, 30) === 90);
  t('非法步长回落默认页（不卡死）',
    nextHistoryLimit(60, 996, Number.NaN) === 120 && nextHistoryLimit(60, 996, 0) === 120);
  t('总数非法 → 0（按钮消失而不是乱加）', nextHistoryLimit(60, Number.NaN) === 0);
  t('★还有更多 → true；到底 → false', hasMoreHistory(60, 996) && !hasMoreHistory(996, 996));
  t('总数小于一页 → 不显示按钮', !hasMoreHistory(60, 12));
  t('已显示数非法按 0（还有更多 → true）；总数非法 → false',
    hasMoreHistory(Number.NaN, 996) && !hasMoreHistory(60, Number.NaN));
}

// ══ 三、文案 ══
{
  t('★文案两个数字都来自真实数据', historyCountLabel(60, 996) === '已显示 60 / 共 996 条');
  t('显示数不会超过总数', historyCountLabel(5000, 12) === '已显示 12 / 共 12 条');
  t('非法输入 → 0 而不是 NaN', historyCountLabel(Number.NaN, Number.NaN) === '已显示 0 / 共 0 条');
}

// ══ 四、组件接线 ══
{
  const layoutDir = path.join(WEB_UI_DIR, 'src', 'app', 'layout');
  const files = readdirSync(layoutDir);
  const tsxName = files.find((f) => f.endsWith('.tsx') && !f.includes('.test.') && readFileSync(path.join(layoutDir, f), 'utf8').includes('ncc__history-list'));
  t('找到渲染历史列表的面板组件', !!tsxName, tsxName || '(未找到)');
  if (tsxName) {
    const tsx = readFileSync(path.join(layoutDir, tsxName), 'utf8');
    t('★切片走 visibleHistoryCount（不在 JSX 里写死 60）',
      /orderedHistory\.rest\.slice\(0, visibleHistoryCount\(historyLimit, orderedHistory\.rest\.length\)\)/.test(tsx));
    t('★按钮走 nextHistoryLimit（翻页算术只有一份）',
      /setHistoryLimit\(\(n\) => nextHistoryLimit\(n, orderedHistory\.rest\.length\)\)/.test(tsx));
    t('★文案走 historyCountLabel（数字不手写）', /historyCountLabel\(historyVisibleItems\.length/.test(tsx));
    t('★按钮只在还有更多时渲染（到底自动消失）',
      /hasMoreHistory\(historyVisibleItems\.length, orderedHistory\.rest\.length\)/.test(tsx));
    t('★换查询 / 重开浮层把上限重置回一页',
      (tsx.match(/setHistoryLimit\(HISTORY_PAGE_SIZE\)/g) || []).length >= 2);
    t('「加载更多」按钮带可测试标记', /data-testid="ncc-history-more"/.test(tsx));
  }
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 首屏一页、可翻到底，边界与接线都对得上'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;