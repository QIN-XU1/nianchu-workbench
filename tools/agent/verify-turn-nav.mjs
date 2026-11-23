/**
 * 提问跳转（turn-nav）· 纯计算 + **接线**验证（批次 Z.20）
 *
 * 【要证明什么】
 *  ① 纯计算：`clampTurnIndex` 首尾钳制、空对话；`activeTurnFromOffsets` 两条之间取上一条、
 *     slack 边界、滚到底取末条、负 scrollTop 当 0
 *  ② ★**接线**：这些函数真的被组件调用（Z.9 的注释写着「由滚动位置推导」，
 *     但 `activeTurnFromOffsets` 当时是**死代码**，没人调 —— 注释与行为相反。
 *     所以这里不只测函数，还检查：组件里出现调用、有 scroll 监听、有 rAF 合并、
 *     有「程序化跳转期间不反推」的抑制窗口。
 *  ③ 组件保留了「提问数量变化 → 跟到最新一条」的兜底（历史加载完成时不至于停在 0）
 *
 * 用法：node tools/agent/verify-turn-nav.mjs
 * 四态：0 PASS / 1 FAIL / 2 UNKNOWN（环境缺 tsx）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RE_EXEC_ENV = 'DSH_VERIFY_TURN_NAV_TSX';
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

const { activeTurnFromOffsets, clampTurnIndex } = await import('@/app/layout/turnNav');

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

console.log('');
console.log('  提问跳转 · 纯计算 + 接线');
console.log('  ' + '─'.repeat(72));

// ══ 一、clampTurnIndex ══
{
  t('中间前进/后退', clampTurnIndex(1, 1, 4) === 2 && clampTurnIndex(2, -1, 4) === 1);
  t('★第一条按上一条 → 停在 0（不越界）', clampTurnIndex(0, -1, 4) === 0);
  t('★最后一条按下一条 → 停在末位', clampTurnIndex(3, 1, 4) === 3);
  t('空对话 → 0（不崩）', clampTurnIndex(0, 1, 0) === 0);
  t('非数字 current / dir 兜底', clampTurnIndex(Number.NaN, 1, 4) === 1 && clampTurnIndex(1, Number.NaN, 4) === 1);
}

// ══ 二、activeTurnFromOffsets ══
{
  const offsets = [0, 900, 1800, 2700];
  t('在顶部 → 第 0 条', activeTurnFromOffsets(offsets, 0) === 0);
  t('★两条之间 → 取上一条（用户正在看上一段）', activeTurnFromOffsets(offsets, 1200) === 1);
  t('正好到某条偏移（含 slack）→ 该条', activeTurnFromOffsets(offsets, 1800) === 2);
  t('★差 1px 未到（slack=24 之外）→ 仍是上一条', activeTurnFromOffsets(offsets, 1770) === 1);
  t('★滚动位置落在 slack 内 → 已算下一条', activeTurnFromOffsets(offsets, 1780) === 2);
  t('滚到底 → 最后一条', activeTurnFromOffsets(offsets, 99999) === 3);
  t('空列表 → 0', activeTurnFromOffsets([], 500) === 0);
  t('负 scrollTop → 按 0 处理', activeTurnFromOffsets(offsets, -100) === 0);
  t('单条提问 → 恒为 0', activeTurnFromOffsets([300], 0) === 0 && activeTurnFromOffsets([300], 9999) === 0);
  t('偏移相等（两条贴在一起）→ 取靠后的那条', activeTurnFromOffsets([100, 100], 100) === 1);
  t('★滚到底 → 最后一条（末条提问滚不到顶部也认）',
    activeTurnFromOffsets([16, 4759, 5840], 5338, 24, false) === 1
      && activeTurnFromOffsets([16, 4759, 5840], 5338, 24, true) === 2);
  t('atBottom 只在真的到底时生效（中途传 false 仍按偏移）',
    activeTurnFromOffsets([0, 900, 1800], 1200, 24, false) === 1);
  t('空偏移 + atBottom → 0（不返回 -1）', activeTurnFromOffsets([], 0, 24, true) === 0);
}

// ══ 三、接线（Z.20 的修复点）══
{
  const layoutDir = path.join(WEB_UI_DIR, 'src', 'app', 'layout');
  const files = readdirSync(layoutDir);
  const tsxName = files.find((f) => f.endsWith('.tsx') && !f.includes('.test.') && readFileSync(path.join(layoutDir, f), 'utf8').includes('ncc-turnnav__count'));
  t('找到渲染 turn-nav 计数的面板组件', !!tsxName, tsxName || '(未找到)');
  if (tsxName) {
    const tsx = readFileSync(path.join(layoutDir, tsxName), 'utf8');
    t('★组件导入了 activeTurnFromOffsets（不是只留注释）',
      /import \{[^}]*activeTurnFromOffsets[^}]*\} from '\.\/turnNav'/.test(tsx));
    t('★组件真的调用了它（死代码会在这里红）', /activeTurnFromOffsets\(offsets, scrollTop, 24, atBottom\)/.test(tsx));
    t('★滚动监听是 passive 的（不阻塞滚动）',
      /addEventListener\('scroll', onScroll, \{ passive: true \}\)/.test(tsx));
    t('★多次滚动用 rAF 合并（不是每帧 setState）',
      /requestAnimationFrame\(derive\)/.test(tsx) && /cancelAnimationFrame\(raf\)/.test(tsx));
    t('★到底时传 atBottom（末条提问滚不到顶部）', /scrollHeight - scrollTop - body.clientHeight < 24/.test(tsx));
    t('★程序化跳转期间抑制反推（否则平滑滚动会闪计数）',
      /turnJumpUntilRef/.test(tsx) && /performance\.now\(\) < turnJumpUntilRef\.current/.test(tsx));
    t('★提问数量变化仍跟随到最新一条（历史加载完成时兜底）',
      /setActiveTurn\(total - 1\)/.test(tsx));
    t('计数与按钮都用同一份 userTurnIds（不会一个按 id、一个按下标）',
      /activeTurn \+ 1\}\/\{userTurnIds\.length\}/.test(tsx));
    t('跳转按 data-mid 定位（消息 id，不是数组下标）',
      /querySelector\('\[data-mid="' \+ ids\[next\] \+ '"\]'\)/.test(tsx));
  }
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 纯计算边界正确，且「按滚动位置推导」真的接进了组件'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;