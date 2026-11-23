/**
 * 念初面板主题（批次 Z.17，对标 Claude Code 的 `/theme` 与 dsh-claude-style 的配色卡）。
 *
 * 【为什么单独一层】主题档位是**受控词汇表**：界面上五个按钮、scss 里五组 `--ncc-*` 令牌、
 * localStorage 里一个字符串，三处必须对同一个 id 名。写成「各处自己写字符串」，
 * 改名/加档时必然出现「按钮点了没反应」「刷新回到默认」这类静默错位。
 * 所以这里只做三件事：**枚举**（唯一真源）、**归一化**（脏值兜底）、**存取**（持久化）。
 *
 * 【如实边界】
 *  - `system` 不写任何令牌，直接沿用应用级主题（即「跟随应用」）；其余四套只覆盖
 *    本面板自己的 `--ncc-*`，**不碰** `document.documentElement` 的 `data-color-scheme`，
 *    因此面板换肤不会污染应用其他区域。
 *  - `claude` / `dsh` 只有浅色底（暖米色 / 近白），**没有**各自的深色变体；
 *    深色需求走 `dark` 档。不假装「五套皮肤都能深色」。
 *  - 持久化用 localStorage；隐私模式写不进时**本次会话仍生效**（内存态），
 *    下次打开回到默认 —— 这是浏览器限制，不是静默失败。
 */

/** 五个档位的 id —— scss `[data-ncc-theme='…']` 与界面按钮共用这一份。 */
export const NCC_THEME_IDS = ['system', 'light', 'dark', 'claude', 'dsh'] as const;

/** 面板主题档位。 */
export type NccTheme = (typeof NCC_THEME_IDS)[number];

/** 默认档：跟随应用（升级不改变现有外观）。 */
export const DEFAULT_NCC_THEME: NccTheme = 'system';

/** localStorage 键名（与 `completionCues` 的 `ncc_*` 前缀保持一致）。 */
export const NCC_THEME_STORAGE_KEY = 'ncc_theme';

/**
 * 界面渲染用的档位表：id + 文案 + 一行说明。
 * 顺序即面板里的显示顺序（默认档在最前，符合「先给我看默认」）。
 */
export const NCC_THEME_OPTIONS: ReadonlyArray<{ id: NccTheme; label: string; hint: string }> = [
  { id: 'system', label: '跟随应用', hint: '与应用外观一致' },
  { id: 'light', label: '浅色', hint: '纯白底、深灰字' },
  { id: 'dark', label: '深色', hint: '近黑底、浅灰字' },
  { id: 'claude', label: 'Claude 暖色', hint: '米色底、砖红强调' },
  { id: 'dsh', label: 'DSH 蓝', hint: '白底、品牌蓝强调' },
];

/** 类型守卫：只认这五个字面量，其余（含大小写变体）一律不认。 */
export function isNccTheme(value: unknown): value is NccTheme {
  return typeof value === 'string' && (NCC_THEME_IDS as readonly string[]).includes(value);
}

/**
 * 归一化：合法值原样返回，脏值（空串 / 大写 / 带空格 / 旧词 / 数字 / null /
 * 对象）一律回落 `system`。
 *
 * 为什么不「尽量猜」：猜错会把用户带到一套他没选的配色上，比回到默认更难解释。
 */
export function normalizeNccTheme(value: unknown): NccTheme {
  return isNccTheme(value) ? value : DEFAULT_NCC_THEME;
}

/**
 * 读档位。storage 可注入（单测用），不传则取全局 localStorage；
 * 无 localStorage / 抛错 / 值损坏 → 默认档。
 */
export function readNccTheme(storage?: Pick<Storage, 'getItem'> | null): NccTheme {
  try {
    const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    return normalizeNccTheme(store?.getItem(NCC_THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_NCC_THEME;
  }
}

/**
 * 写档位，返回**本次实际生效**的档位（写入前先归一化，所以脏值不会落盘）。
 * 写失败（隐私模式 / 配额满）不抛：调用方按返回值渲染，内存态仍然生效。
 */
export function writeNccTheme(
  theme: unknown,
  storage?: Pick<Storage, 'setItem'> | null,
): NccTheme {
  const next = normalizeNccTheme(theme);
  try {
    const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    store?.setItem(NCC_THEME_STORAGE_KEY, next);
  } catch {
    /* 写不进就用内存态，不打断用户 */
  }
  return next;
}

/**
 * 弹层底部的说明文案：把「只影响面板」和「system 跟随应用」两件事一次说清，
 * 避免用户以为换了面板主题会改整个应用。
 */
export const NCC_THEME_TIP = '只影响念初面板；「跟随应用」随整站外观切换。';
