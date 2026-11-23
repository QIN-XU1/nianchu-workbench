/**
 * 面板宽度（批次 Z.29）· 纯计算 + **接线** 验证。
 *
 * 【要证明什么】
 *   ① 纯计算：夹取、脏值、视口 46vw、键盘步长、拖动换算（左拖=变宽）
 *   ② **接线**：这些函数真的被 FloatingMiniChat 调用；面板用 --openbitfun-fmc-dock-width；
 *      分隔条有 role=separator + aria-value* + 键盘/指针/双击处理；scss 有 col-resize
 *
 * 用法：node tools/agent/verify-panel-width.mjs
 * 四态：0 PASS / 1 FAIL / 2 UNKNOWN（环境缺 tsx）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RE_EXEC_ENV = 'DSH_VERIFY_PANEL_WIDTH_TSX';
const WEB_UI_DIR = path.resolve(import.meta.dirname, '..', '..', 'apps', 'vouch-web', 'src', 'web-ui');
const PNPM_STORE = path.resolve(WEB_UI_DIR, '..', '..', 'node_modules', '.pnpm');
const LAYOUT_DIR = path.join(WEB_UI_DIR, 'src', 'app', 'layout');

function findTsxCli() {
  let versions;
  try {
    versions = readdirSync(PNPM_STORE).filter(n => /^tsx@\d/.test(n));
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
  PANEL_WIDTH_DEFAULT,
  PANEL_WIDTH_KEY,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  PANEL_WIDTH_STEP,
  PANEL_WIDTH_STEP_LARGE,
  PANEL_WIDTH_VIEWPORT_RATIO,
  clampPanelWidth,
  nudgePanelWidth,
  readPanelWidth,
  widthFromDrag,
  writePanelWidth,
} = await import('@/app/layout/panelWidth');

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fails.push(name + (info ? '  → ' + info : ''));
    console.log('  ✗ ' + name + (info ? '  → ' + info : ''));
  }
};

function memStore() {
  const map = new Map();
  return {
    map,
    getItem: k => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

console.log('');
console.log('  面板宽度 · 纯计算 + 接线');
console.log('  ' + '─'.repeat(72));

// ═══ 一、clampPanelWidth ═══
{
  t('默认值原样保留', clampPanelWidth(PANEL_WIDTH_DEFAULT) === PANEL_WIDTH_DEFAULT);
  t('★数字字符串也认（localStorage 存的是字符串）', clampPanelWidth('512') === 512);
  t('★上下限夹住', clampPanelWidth(10) === PANEL_WIDTH_MIN && clampPanelWidth(9999) === PANEL_WIDTH_MAX);
  t(
    '★NaN / Infinity / 非数字 → 默认值（绝不返回 NaN）',
    [Number.NaN, Infinity, -Infinity, 'abc', {}, [], null, undefined, true].every(v => clampPanelWidth(v) === PANEL_WIDTH_DEFAULT),
  );
  t('小数四舍五入', clampPanelWidth(400.6) === 401);
  t('★视口 46vw 约束', clampPanelWidth(700, 800) === Math.floor(800 * PANEL_WIDTH_VIEWPORT_RATIO));
  t('视口够宽时仍可到 760', clampPanelWidth(700, 2000) === 700);
  t('★视口极窄以下限为准（不窄到不可用）', clampPanelWidth(400, 300) === PANEL_WIDTH_MIN);
  t('非法视口不参与约束', clampPanelWidth(9999, Number.NaN) === PANEL_WIDTH_MAX && clampPanelWidth(9999, 0) === PANEL_WIDTH_MAX);
}

// ═══ 二、读写 ═══
{
  const store = memStore();
  t('★写入再读出，值一致', writePanelWidth(520, store) === 520 && readPanelWidth(store) === 520);
  t('★落盘的是夹过的值', writePanelWidth(9999, store) === PANEL_WIDTH_MAX && store.map.get(PANEL_WIDTH_KEY) === String(PANEL_WIDTH_MAX));
  t('空存储 → 默认值', readPanelWidth(memStore()) === PANEL_WIDTH_DEFAULT);
  const dirty = memStore();
  dirty.map.set(PANEL_WIDTH_KEY, 'not-a-number');
  t('★脏数据 → 默认值（不抛）', readPanelWidth(dirty) === PANEL_WIDTH_DEFAULT);
  const broken = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('quota');
    },
  };
  t('★存储抛错 → 不抛，仍返回夹过的值', readPanelWidth(broken) === PANEL_WIDTH_DEFAULT && writePanelWidth(500, broken) === 500);
  const capped = memStore();
  writePanelWidth(700, capped, 800);
  t('★写入也受视口约束（落盘值就是 46vw）', readPanelWidth(capped, 800) === Math.floor(800 * PANEL_WIDTH_VIEWPORT_RATIO));
}

// ═══ 三、键盘步长 ═══
{
  t('往左=加宽 / 往右=变窄', nudgePanelWidth(400, 'left') === 400 + PANEL_WIDTH_STEP && nudgePanelWidth(400, 'right') === 400 - PANEL_WIDTH_STEP);
  t('Shift 大步长', nudgePanelWidth(400, 'left', true) === 400 + PANEL_WIDTH_STEP_LARGE);
  t('★到边界夹住', nudgePanelWidth(PANEL_WIDTH_MAX, 'left') === PANEL_WIDTH_MAX && nudgePanelWidth(PANEL_WIDTH_MIN, 'right') === PANEL_WIDTH_MIN);
  t('非法当前值按默认值算', nudgePanelWidth(Number.NaN, 'left') === PANEL_WIDTH_DEFAULT + PANEL_WIDTH_STEP);
}

// ═══ 四、拖动换算 ═══
{
  t('★左拖变宽', widthFromDrag(400, -120) === 520);
  t('★右拖一下拖到下限', widthFromDrag(400, 120) === PANEL_WIDTH_MIN);
  t('★超界夹住', widthFromDrag(PANEL_WIDTH_MAX, -9999) === PANEL_WIDTH_MAX && widthFromDrag(PANEL_WIDTH_MIN, 9999) === PANEL_WIDTH_MIN);
  t('非法 dx 当作没移动', widthFromDrag(400, Number.NaN) === 400 && widthFromDrag(400, 'x') === 400);
  t('非法起点按默认值 + 视口约束', widthFromDrag(null, 0) === PANEL_WIDTH_DEFAULT && widthFromDrag(700, 0, 800) === Math.floor(800 * PANEL_WIDTH_VIEWPORT_RATIO));
}

// ═══ 五、接线（组件 + scss）═══
{
  const tsx = readFileSync(path.join(LAYOUT_DIR, 'FloatingMiniChat.tsx'), 'utf8');
  const scss = readFileSync(path.join(LAYOUT_DIR, 'FloatingMiniChat.scss'), 'utf8');

  t('组件 import 了 panelWidth 的读写/夹取/换算', [
    'readPanelWidth',
    'writePanelWidth',
    'clampPanelWidth',
    'widthFromDrag',
    'nudgePanelWidth',
  ].every(name => new RegExp(`\\b${name}\\b`).test(tsx)));

  t('★面板宽度走 CSS 变量 --openbitfun-fmc-dock-width', tsx.includes("'--openbitfun-fmc-dock-width'") && scss.includes('var(--openbitfun-fmc-dock-width'));
  t('★分隔条 role=separator + 竖直方向', /role="separator"/.test(tsx) && /aria-orientation="vertical"/.test(tsx));
  t('★分隔条暴露 aria-valuemin/max/now', ['aria-valuemin', 'aria-valuemax', 'aria-valuenow'].every(a => tsx.includes(a)));
  t('★分隔条键盘可达（tabIndex + ArrowLeft/Right + Home）', /tabIndex=\{0\}/.test(tsx) && tsx.includes('ArrowLeft') && tsx.includes('ArrowRight') && tsx.includes("'Home'"));
  t('★拖动走 window 级监听（不依赖 pointer capture）+ 双击复位',
    tsx.includes('onPointerDown') && tsx.includes('onDoubleClick')
    && /window\.addEventListener\('pointermove'/.test(tsx)
    && /window\.removeEventListener\('pointerup'/.test(tsx)
    && !tsx.includes('setPointerCapture'));
  t('★落盘发生在拖动结束与键盘调节（commitPanelWidth / writePanelWidth）', tsx.includes('commitPanelWidth') && tsx.includes('writePanelWidth(panelWidthRef.current'));
  t('★scss 有 col-resize 与拖动中关过渡', scss.includes('.openbitfun-fmc__resizer') && scss.includes('cursor: col-resize') && scss.includes('&--resizing') && scss.includes('transition: none'));
  const descriptor = readFileSync(path.join(LAYOUT_DIR, 'FloatingMiniChat.appearance.ts'), 'utf8');
  t('★appearance 契约登记了 panelResizer（否则注册期直接抛 Invalid part id）', /id: 'panelResizer'/.test(descriptor) && tsx.includes('data-openbitfun-part="panelResizer"'));
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) {
  for (const f of fails) console.error('    · ' + f);
  console.log('  四态: FAIL');
  process.exit(1);
}
console.log('  四态: PASS —— 纯计算边界 + 组件/scss 接线都对得上');
