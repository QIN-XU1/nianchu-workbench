/**
 * 念初面板主题（批次 Z.17）· 数据契约 + 样式绑定验证
 *
 * 【要证明什么】
 *  ① 档位是**受控词汇表**：id 只有 system/light/dark/claude/dsh 五个，顺序固定
 *  ② 脏值（空串 / 大写 / 带空格 / 旧词 / 数字 / null / 对象）一律回落 `system`，
 *     不猜、不抛、不显示假档位
 *  ③ 存取往返不漂移；存储抛错（隐私模式）与「没有 localStorage」都能降级不炸
 *  ④ **样式与组件都认这同一份枚举**（这才是「点了没反应」的真因）：
 *     - scss 里必须有 `.ncc[data-ncc-theme='<id>']` 五块，且每块都覆盖**全部** `--ncc-*` 令牌
 *       （少一个令牌 = 该档只换了一半颜色，肉眼很难发现）
 *     - 组件根节点必须把 `data-ncc-theme` 绑到 state 上，且**不再自己定义**一份枚举
 *
 * 关键：**直接 import 界面那一份实现**（`app/layout/panelTheme.ts`），不重写等价逻辑。
 * 常量一改名（`ncc_theme` → 别的）这里立刻红。
 *
 * 用法：node tools/agent/verify-panel-theme.mjs
 * 四态：0 PASS / 1 FAIL / 2 UNKNOWN（环境缺 tsx）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RE_EXEC_ENV = 'DSH_VERIFY_PANEL_THEME_TSX';
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

// 自举：`@/...` 别名要 tsx 才解析得到（纯 node 的 type-stripping 不会省略类型导入）
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

// ══ 1. 实现 ══
const {
  DEFAULT_NCC_THEME,
  NCC_THEME_IDS,
  NCC_THEME_OPTIONS,
  NCC_THEME_STORAGE_KEY,
  NCC_THEME_TIP,
  isNccTheme,
  normalizeNccTheme,
  readNccTheme,
  writeNccTheme,
} = await import('@/app/layout/panelTheme');

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

console.log('');
console.log('  念初面板主题 · 数据契约 + 样式绑定');
console.log('  ' + '─'.repeat(72));

// ══ 二、受控词汇表 ══
{
  t('五档顺序 system → light → dark → claude → dsh',
    JSON.stringify([...NCC_THEME_IDS]) === JSON.stringify(['system', 'light', 'dark', 'claude', 'dsh']),
    JSON.stringify([...NCC_THEME_IDS]));
  t('默认档 system（升级不改变现有外观）', DEFAULT_NCC_THEME === 'system', DEFAULT_NCC_THEME);
  t('选项表 id 集合与枚举一致（改名必然红）',
    [...NCC_THEME_OPTIONS.map((o) => o.id)].sort().join() === [...NCC_THEME_IDS].sort().join(),
    NCC_THEME_OPTIONS.map((o) => o.id).join());
  t('每档都有文案与说明（界面上不会出现空行）',
    NCC_THEME_OPTIONS.every((o) => o.label.trim() && o.hint.trim()),
    NCC_THEME_OPTIONS.map((o) => o.label).join(' / '));
  t('说明文案点明「只影响面板」与「跟随应用」',
    NCC_THEME_TIP.includes('只影响念初面板') && NCC_THEME_TIP.includes('跟随应用'),
    NCC_THEME_TIP);
  t('存储键是 ncc_ 前缀（与完成提示等本地偏好同域）',
    NCC_THEME_STORAGE_KEY.startsWith('ncc_'), NCC_THEME_STORAGE_KEY);
}

// ══ 三、归一化（脏值兜底）══
{
  t('五个合法值原样返回', NCC_THEME_IDS.every((id) => normalizeNccTheme(id) === id));
  const dirty = ['', ' ', 'DARK', ' dark', 'auto', 'claude-light', 1, 0, null, undefined, {}, [], true];
  for (const v of dirty) {
    t('★脏值 ' + JSON.stringify(v) + ' → 回落 system（不猜、不抛）', normalizeNccTheme(v) === 'system', String(v));
  }
  t('类型守卫只认五个字面量（大小写敏感）',
    isNccTheme('claude') && !isNccTheme('Claude') && !isNccTheme(undefined) && !isNccTheme(5));
}

// ══ 四、存取（含降级）══
{
  const mem = () => {
    const map = new Map();
    return {
      map,
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => void map.set(k, v),
    };
  };

  t('未写过 → 默认档', readNccTheme(mem()) === 'system');
  t('★五档「写 → 读」往返都不漂移',
    NCC_THEME_IDS.every((id) => {
      const s = mem();
      writeNccTheme(id, s);
      return readNccTheme(s) === id;
    }));
  {
    const s = mem();
    t('★写脏值 → 归一化后再落盘（存储里只有合法 id）',
      writeNccTheme('DARK', s) === 'system' && s.getItem(NCC_THEME_STORAGE_KEY) === 'system',
      s.getItem(NCC_THEME_STORAGE_KEY));
  }
  {
    const boom = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    t('★存储抛错（隐私模式）→ 读回落默认、写不抛且返回传入档位',
      readNccTheme(boom) === 'system' && writeNccTheme('claude', boom) === 'claude');
  }
  {
    const s = mem();
    s.setItem('other_theme', 'dark');
    t('存的是别的键 → 不算数（回落默认）', readNccTheme(s) === 'system');
  }
}

// ══ 五、样式与组件的绑定（真正防「点了没反应」）══
{
  const layoutDir = path.join(WEB_UI_DIR, 'src', 'app', 'layout');
  const files = readdirSync(layoutDir);
  const scssName = files.find((f) => f.endsWith('.scss') && readFileSync(path.join(layoutDir, f), 'utf8').includes('data-ncc-theme'));
  const tsxName = files.find((f) => f.endsWith('.tsx') && !f.includes('.test.') && readFileSync(path.join(layoutDir, f), 'utf8').includes('data-ncc-theme='));

  t('★找到定义了 data-ncc-theme 的面板样式文件', !!scssName, scssName || '(未找到)');
  t('★找到把 data-ncc-theme 绑到 state 的面板组件', !!tsxName, tsxName || '(未找到)');

  if (scssName) {
    const scss = readFileSync(path.join(layoutDir, scssName), 'utf8');
    // 从基础块里取「必须被每个档位覆盖」的令牌清单，避免这里再抄一份常量
    const baseBlock = scss.slice(scss.indexOf('.ncc {'), scss.indexOf('.ncc__head'));
    const tokens = [...baseBlock.matchAll(/--(ncc-[a-z-]+)\s*:/g)].map((m) => m[1]);
    t('基础块解析出 ≥ 10 个 --ncc-* 令牌（否则本项检查没意义）', tokens.length >= 10, tokens.length);

    for (const id of NCC_THEME_IDS) {
      if (id === 'system') {
        // system 不写令牌：直接继承应用级主题，这是设计而非遗漏
        t('system 档不覆盖令牌（跟随应用 = 继承，不是硬编码一套浅色）',
          !new RegExp(`\\.ncc\\[data-ncc-theme='system'\\]`).test(scss));
        continue;
      }
      const start = scss.indexOf(`.ncc[data-ncc-theme='${id}']`);
      t(`样式里存在 [data-ncc-theme='${id}'] 块`, start >= 0, id);
      if (start < 0) continue;
      const block = scss.slice(start, scss.indexOf('}', start));
      const missing = tokens.filter((tok) => !block.includes(`--${tok}:`));
      t(`★${id} 档覆盖全部 ${tokens.length} 个令牌（少一个 = 只换一半颜色）`,
        missing.length === 0, missing.join(','));
    }

    // 弹层容器必须存在，否则按钮点了也看不见
    t('弹层容器 .ncc__theme 有定位（absolute + 层级）',
      /\.ncc__theme\s*\{[^}]*position:\s*absolute/.test(scss) && /\.ncc__theme\s*\{[^}]*z-index:\s*\d+/.test(scss));
    t('档位行 .ncc__theme-row 有选中态样式（aria-checked）',
      scss.includes(".ncc__theme-row[aria-checked='true']"));
  }

  if (tsxName) {
    const tsx = readFileSync(path.join(layoutDir, tsxName), 'utf8');
    t('★组件把 data-ncc-theme 绑到主题 state（不是写死的字面量）',
      /data-ncc-theme=\{theme\}/.test(tsx));
    t('★组件从 panelTheme 导入，而不是自己再定义一份枚举',
      /from '\.\/panelTheme'/.test(tsx) && !/type\s+NccTheme\s*=/.test(tsx));
    t('组件用 readNccTheme 初始化、用 writeNccTheme 落盘',
      /useState<NccTheme>\(\(\) => readNccTheme\(\)\)/.test(tsx) && /writeNccTheme\(next\)/.test(tsx));
    t('弹层用 radiogroup + radio 语义（可被读屏识别为单选）',
      /role="radiogroup"/.test(tsx) && /role="radio"/.test(tsx));
    t('五档由枚举 map 渲染（加档不用改 JSX）',
      /NCC_THEME_OPTIONS\.map/.test(tsx));
    t('说明文案来自常量（不在 JSX 里再抄一遍）', /NCC_THEME_TIP\}/.test(tsx));
  }
}

// ══ 六、键盘可达性（批次 Z.18：弹层不是「只能用鼠标」）══
{
  const { isRadioNavKey, nextRadioIndex } = await import('@/app/layout/rovingRadio');

  t('★方向键按原生 radio 约定换档：向下/向右 +1、向上/向左 -1',
    nextRadioIndex(0, 5, 'ArrowDown') === 1
      && nextRadioIndex(0, 5, 'ArrowRight') === 1
      && nextRadioIndex(2, 5, 'ArrowUp') === 1
      && nextRadioIndex(2, 5, 'ArrowLeft') === 1);
  t('★到边界回绕（末项向下→第一项、首项向上→末项）',
    nextRadioIndex(4, 5, 'ArrowDown') === 0 && nextRadioIndex(0, 5, 'ArrowUp') === 4);
  t('Home / End 跳首尾', nextRadioIndex(3, 5, 'Home') === 0 && nextRadioIndex(1, 5, 'End') === 4);
  t('★没聚焦任何一项时：向下从第一项开始、向上从末项开始',
    nextRadioIndex(-1, 5, 'ArrowDown') === 0 && nextRadioIndex(-1, 5, 'ArrowUp') === 4);
  t('★Tab / Esc / Enter 不归导航层管（返回 null，不吞键）',
    ['Tab', 'Escape', 'Enter', ' '].every((k) => nextRadioIndex(1, 5, k) === null));
  t('★档位为 0 / 负数 / NaN 时返回 null（不编下标）',
    nextRadioIndex(0, 0, 'ArrowDown') === null
      && nextRadioIndex(0, -1, 'ArrowDown') === null
      && nextRadioIndex(0, Number.NaN, 'ArrowDown') === null);
  t('isRadioNavKey 只认六个导航键', isRadioNavKey('End') && !isRadioNavKey('Tab'));

  const layoutDir = path.join(WEB_UI_DIR, 'src', 'app', 'layout');
  const files = readdirSync(layoutDir);
  const tsxName = files.find((f) => f.endsWith('.tsx') && !f.includes('.test.') && readFileSync(path.join(layoutDir, f), 'utf8').includes('data-ncc-theme='));
  if (tsxName) {
    const tsx = readFileSync(path.join(layoutDir, tsxName), 'utf8');
    t('★组件用导航层算下标（不自己再写一遍方向键算术）',
      /from '\.\/rovingRadio'/.test(tsx) && /nextRadioIndex\(/.test(tsx));
    t('★Esc 关闭弹层并把焦点还给触发按钮',
      /e\.key === 'Escape'[\s\S]{0,200}themeBtnRef\.current\?\.focus\(\)/.test(tsx));
    t('★方向键换档后把焦点落到新档位',
      /querySelector<HTMLButtonElement>\(`\[data-theme-id="\$\{opt\.id\}"\]`\)\?\.focus\(\)/.test(tsx)
      || /data-theme-id="\$\{opt\.id\}"/.test(tsx) && /\.focus\(\)/.test(tsx));
    t('★单选组用 roving tabindex（只有选中项可 Tab 进入）',
      /tabIndex=\{theme === opt\.id \? 0 : -1\}/.test(tsx));
    t('★点弹层外面会收起（pointerdown 捕获阶段，不是靠再点一次按钮）',
      /addEventListener\('pointerdown'/.test(tsx) && /setThemeOpen\(false\)/.test(tsx));
    t('★Esc 挂在 document 捕获阶段（鼠标点开时焦点不在弹层里也能关）',
      /addEventListener\('keydown', onKeyDown, true\)/.test(tsx) && /e\.key !== 'Escape'/.test(tsx));
    t('触发按钮声明 aria-haspopup="dialog" + aria-expanded',
      /aria-haspopup="dialog"/.test(tsx) && /aria-expanded=\{themeOpen\}/.test(tsx));
    t('完成提示弹层同样支持 Esc 关闭并归还焦点',
      /cueBtnRef\.current\?\.focus\(\)/.test(tsx));
  }
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 五档受控、脏值回落、存取不漂移，且样式与组件认同一份枚举'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;
