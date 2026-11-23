/**
 * 主题模式：界面配色的三档选择。
 *
 * 这不是第二套主题系统。配色 token、`data-color-scheme` 与「用户选了哪个外观包」
 * 的持久化都由 `infrastructure/appearance` 持有；本模块只是它的一个三档视图：
 *
 * - `system` 跟随操作系统，并在运行期继续跟随；
 * - `light` / `dark` 固定配色，不随操作系统变化。
 */
export type ThemeMode = 'system' | 'light' | 'dark';

/** 真正落到界面上的配色。`system` 永远不会出现在这里。 */
export type ResolvedColorScheme = 'light' | 'dark';

export interface ThemePreference {
  mode: ThemeMode;
}

/**
 * 默认 `system`，与 appearance 系统自身「未选择时跟随系统」的行为一致：
 * 升级到带本偏好的版本不会改变任何用户的现有外观。
 */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = { mode: 'system' };

export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

/** 任何不在 {@link THEME_MODES} 里的值（脏配置、旧版本、非法输入）都退回 `system`。 */
export function normalizeThemeMode(value: unknown): ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value)
    ? value as ThemeMode
    : DEFAULT_THEME_PREFERENCE.mode;
}
