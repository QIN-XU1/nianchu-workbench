/**
 * 主题模式（浅色 / 深色 / 跟随系统）· 数据契约验证
 *
 * 【要证明什么】
 *  ① 三档模式**翻译成外观包选择**，而不是自己写 `data-color-scheme` 或配置键：
 *     `light`→默认浅色包、`dark`→默认深色包、`system`→`system` 哨兵
 *  ② 反解**先看选择 id 再看配色**：否则「跟随系统 + 系统深色」会被改写成固定深色，
 *     用户一进设置页就丢了自己的选择
 *  ③ 自带深色皮肤（`openbitfun-cyber`）算「深色」档，不是只认两个默认包
 *  ④ 固定档**不受操作系统影响**；`system` 才去问 `prefers-color-scheme`
 *  ⑤ 脏配置（空串 / 大小写 / 数字 / null）回落 `system`，不炸、不显示假档位
 *
 * 关键：**直接 import 界面那一份实现**（`core/mapping.ts` + `types.ts`），
 * 不重写等价逻辑 —— 重写只证明「我抄得对」，证明不了「界面用的是这个」。
 * 常量一改名（`openbitfun-light` → 别的）这里立刻红。
 *
 * 用法（两种都行，结果一致）：
 *   node tools/agent/verify-theme-mode.mjs                     ← 一键复算入口用的这种
 *   cd apps/vouch-web/src/web-ui && node_modules\.bin\tsx ../../../../tools/agent/verify-theme-mode.mjs
 *
 * 【为什么要在脚本里自举解析器】
 *   一键复算入口（`tools/verify-all.mjs`）对每个脚本跑的是 `node <脚本>`，cwd=仓库根。
 *   而本脚本 import 的实现内部用的是 `@/...` 别名，并且**依赖 esbuild 式的「类型导入省略」**
 *   （`import { AppearancePalette } from './AppearancePalette'` 里那个名字只是类型）。
 *   纯 node 的 type-stripping **不会**省略它 → 直接崩：
 *     `SyntaxError: The requested module './AppearancePalette' does not provide an export named 'AppearancePalette'`
 *   于是汇总里出现「通过 null 失败 null / 四态 FAIL」。
 *   第 220 轮就吃过这个亏：单个脚本 PASS、汇总却红，最后被当成「偶发」重试掩盖。
 *
 *   所以：**若当前不是 tsx 进程，就用仓库自带的 tsx 重新执行自己一次**（cwd 切到 web-ui，
 *   让 tsx 读到 tsconfig 的 paths）。这样任何入口、任何 cwd 都只有一种结果。
 *   找不到 tsx 时如实退出 2（UNKNOWN，环境缺工具），**不假装通过、也不报成代码缺陷**。
 *
 * 四态：0 PASS / 1 FAIL / 2 UNKNOWN
 */

// ══ 0. 自举：用仓库自带的 tsx 重新执行自己 ══
//
// ⚠ 这里全部用**动态** import：ESM 的静态 import 会被提升到模块体之前求值，
//   那样自举代码还没跑，`@/...` 就已经在主进程里解析失败了。
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RE_EXEC_ENV = 'DSH_VERIFY_THEME_MODE_TSX';
/** web-ui 包根 —— tsx 要在这里读 tsconfig 的 `@/` 别名。 */
const WEB_UI_DIR = path.resolve(import.meta.dirname, '..', '..', 'apps', 'vouch-web', 'src', 'web-ui');
/** pnpm 的虚拟存储 —— tsx 不是直接可 resolve 的包（只有 .bin 垫片），只能按目录找。 */
const PNPM_STORE = path.resolve(WEB_UI_DIR, '..', '..', 'node_modules', '.pnpm');

/**
 * 找到 tsx 的 CLI 入口（`.../.pnpm/tsx@<版本>/node_modules/tsx/dist/cli.mjs`）。
 * 取**版本最高**的那个；找不到返回 null（调用方按 UNKNOWN 退出）。
 * @returns {string | null}
 */
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
    // inherit（不是 pipe）：沙箱里 pipe 会 EPERM；inherit 让子进程直接写父进程的 stdout
    stdio: 'inherit',
    env: { ...process.env, [RE_EXEC_ENV]: '1' },
  });
  process.exit(typeof child.status === 'number' ? child.status : 2);
}

// ══ 1. 实现 ══
const { SYSTEM_APPEARANCE_ID } = await import('@/infrastructure/appearance/types');
const {
  DEFAULT_LIGHT_APPEARANCE_ID,
  DEFAULT_DARK_APPEARANCE_ID,
} = await import('@/infrastructure/appearance/builtins/palettes');
const {
  deriveThemeMode,
  resolveColorScheme,
  themeModeToAppearanceSelectionId,
} = await import('@/infrastructure/theme-preference/core/mapping');
const {
  DEFAULT_THEME_PREFERENCE,
  THEME_MODES,
  normalizeThemeMode,
} = await import('@/infrastructure/theme-preference/types');

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

console.log('');
console.log('  主题模式 · 数据契约验证');
console.log('  ' + '─'.repeat(72));

// ══ 一、档位 → 外观包（唯一一张映射表）══
{
  t('三档顺序是 system → light → dark（面板按此渲染）',
    JSON.stringify(THEME_MODES) === JSON.stringify(['system', 'light', 'dark']),
    JSON.stringify(THEME_MODES));
  t('默认跟随系统（升级不改变现有外观）',
    DEFAULT_THEME_PREFERENCE.mode === 'system', DEFAULT_THEME_PREFERENCE.mode);

  t('★light → 默认浅色包（不是自己造一个 id）',
    themeModeToAppearanceSelectionId('light') === DEFAULT_LIGHT_APPEARANCE_ID,
    themeModeToAppearanceSelectionId('light'));
  t('★dark → 默认深色包',
    themeModeToAppearanceSelectionId('dark') === DEFAULT_DARK_APPEARANCE_ID,
    themeModeToAppearanceSelectionId('dark'));
  t('★system → system 哨兵（由 appearance 解析成系统对应包）',
    themeModeToAppearanceSelectionId('system') === SYSTEM_APPEARANCE_ID,
    themeModeToAppearanceSelectionId('system'));
  t('映射表只产出这三个 id，没有第四个隐藏档',
    ['system', 'light', 'dark'].every((m) => [
      SYSTEM_APPEARANCE_ID, DEFAULT_LIGHT_APPEARANCE_ID, DEFAULT_DARK_APPEARANCE_ID,
    ].includes(themeModeToAppearanceSelectionId(m))));
}

// ══ 二、反解：选择 id → 点亮哪一档 ══
{
  // 反例 1：跟随系统 + 系统当前深色 —— 最容易写成「固定深色」
  t('★反例：system 选择 + 深色包已落地 → 仍是 system（不偷改成 dark）',
    deriveThemeMode(SYSTEM_APPEARANCE_ID, 'dark') === 'system',
    deriveThemeMode(SYSTEM_APPEARANCE_ID, 'dark'));
  t('system 选择 + 还没落地（current 为空）→ system',
    deriveThemeMode(SYSTEM_APPEARANCE_ID, null) === 'system'
    && deriveThemeMode(SYSTEM_APPEARANCE_ID, undefined) === 'system');

  // 自带深色皮肤算「深色」档
  t('★自带深色皮肤 openbitfun-cyber → 点亮 dark（按配色而非白名单）',
    deriveThemeMode('openbitfun-cyber', 'dark') === 'dark',
    deriveThemeMode('openbitfun-cyber', 'dark'));
  t('默认浅色包 → 点亮 light',
    deriveThemeMode(DEFAULT_LIGHT_APPEARANCE_ID, 'light') === 'light');
  t('默认深色包 → 点亮 dark',
    deriveThemeMode(DEFAULT_DARK_APPEARANCE_ID, 'dark') === 'dark');
  t('自定义浅色皮肤 → light',
    deriveThemeMode('my-pastel-skin', 'light') === 'light');
}

// ══ 三、落地配色：固定档不受系统影响 ══
{
  t('★固定浅色：系统深色也不改（light 就是 light）',
    resolveColorScheme('light', true) === 'light', resolveColorScheme('light', true));
  t('★固定深色：系统浅色也不改（dark 就是 dark）',
    resolveColorScheme('dark', false) === 'dark', resolveColorScheme('dark', false));
  t('system + 系统深色 → dark',
    resolveColorScheme('system', true) === 'dark');
  t('system + 系统浅色 → light',
    resolveColorScheme('system', false) === 'light');
  t('★落地配色永远只有 light/dark（system 不会漏到 DOM 属性上）',
    ['system', 'light', 'dark'].every((m) => ['light', 'dark'].includes(resolveColorScheme(m, true))
      && ['light', 'dark'].includes(resolveColorScheme(m, false))));
}

// ══ 四、脏配置回落 ══
{
  const dirty = [
    ['', '空串'], ['DARK', '大写'], [' dark', '带空格'], ['auto', '旧词'],
    [1, '数字'], [null, 'null'], [undefined, 'undefined'], [{ mode: 'dark' }, '对象'],
  ];
  for (const [value, label] of dirty) {
    t('★脏值 ' + label + ' → 回落 system（不抛、不显示假档位）',
      normalizeThemeMode(value) === 'system', String(value));
  }
  t('合法值原样返回（system/light/dark）',
    normalizeThemeMode('system') === 'system'
    && normalizeThemeMode('light') === 'light'
    && normalizeThemeMode('dark') === 'dark');
}

// ══ 五、往返一致：档位 → 选择 → 反解 → 档位 ══
{
  for (const mode of THEME_MODES) {
    const selectionId = themeModeToAppearanceSelectionId(mode);
    // appearance 把 selection 解析成落地包：system 用当前系统包（这里两档都试）
    const resolvedMode = mode === 'system' ? null : mode;
    t('往返 ' + mode + '：' + selectionId + ' → ' + mode,
      deriveThemeMode(selectionId, resolvedMode) === mode,
      deriveThemeMode(selectionId, resolvedMode));
  }

  for (const prefersDark of [true, false]) {
    for (const mode of THEME_MODES) {
      const selectionId = themeModeToAppearanceSelectionId(mode);
      const derived = deriveThemeMode(selectionId, mode === 'system' ? null : mode);
      // 反解出的档位算出的配色，必须等于「该档位在同样系统偏好下的配色」
      t('配色一致 ' + mode + '（系统' + (prefersDark ? '深' : '浅') + '色）',
        resolveColorScheme(derived, prefersDark) === resolveColorScheme(mode, prefersDark),
        mode + ' / derived=' + derived);
    }
  }
}

// ══ 六、自举本身也要证明（否则「跑不起来」会被误读成「实现坏了」）══
{
  t('★解释器自检：纯 node 也能解析 `@/` 别名（cwd 无关）',
    typeof themeModeToAppearanceSelectionId === 'function'
    && typeof SYSTEM_APPEARANCE_ID === 'string'
    && SYSTEM_APPEARANCE_ID.length > 0,
    'system 哨兵=' + SYSTEM_APPEARANCE_ID);
  t('★自检：默认包 id 是真的 openbitfun 包（不是空串回落出来的假绿）',
    DEFAULT_LIGHT_APPEARANCE_ID.startsWith('openbitfun-')
    && DEFAULT_DARK_APPEARANCE_ID.startsWith('openbitfun-'),
    DEFAULT_LIGHT_APPEARANCE_ID + ' / ' + DEFAULT_DARK_APPEARANCE_ID);
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 三档只翻译成一次外观包选择、反解不偷改选择、固定档不受系统影响、脏值有兜底'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;
