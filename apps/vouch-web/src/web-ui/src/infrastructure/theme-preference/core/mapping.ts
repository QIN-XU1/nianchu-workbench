import {
  DEFAULT_DARK_APPEARANCE_ID,
  DEFAULT_LIGHT_APPEARANCE_ID,
} from '@/infrastructure/appearance/builtins/palettes';
import {
  SYSTEM_APPEARANCE_ID,
  type AppearanceMode,
  type AppearanceSelectionId,
} from '@/infrastructure/appearance/types';
import type { ResolvedColorScheme, ThemeMode } from '../types';

/**
 * 主题模式 → 外观包选择 id。
 *
 * 整条链路上只允许这一张映射表：`AppearanceService` 是唯一持有「当前外观包」
 * 与持久化的地方，`OpenBitFunDesignSystemProvider` 又从
 * `appearance.current.mode` 落下 `data-color-scheme`。所以三档模式必须翻译成
 * 一次外观包选择，而不是自己再写一遍 DOM 属性或配置键。
 *
 * `system` 不是某个具体包：appearance 运行时会把它解析成当前操作系统对应的
 * 浅色/深色包，并在系统切换时重新解析。
 */
export function themeModeToAppearanceSelectionId(mode: ThemeMode): AppearanceSelectionId {
  switch (mode) {
    case 'light':
      return DEFAULT_LIGHT_APPEARANCE_ID;
    case 'dark':
      return DEFAULT_DARK_APPEARANCE_ID;
    case 'system':
    default:
      return SYSTEM_APPEARANCE_ID;
  }
}

/**
 * 反解：appearance 当前选择 → 面板该点亮哪一档。
 *
 * 必须先判断选择 id 是不是 `system`，不能只看 `current.mode`：否则
 * 「跟随系统 + 系统当前是深色」会被误判成「固定深色」，一进设置页就把用户的
 * 跟随系统选择改写成固定配色。
 *
 * 自带的深色皮肤（例如 `openbitfun-cyber`）同样属于「深色」，所以按
 * `current.mode` 归类，而不是按包 id 白名单。
 */
export function deriveThemeMode(
  selectedAppearanceId: AppearanceSelectionId,
  currentMode: AppearanceMode | null | undefined,
): ThemeMode {
  if (selectedAppearanceId === SYSTEM_APPEARANCE_ID) return 'system';
  return currentMode === 'dark' ? 'dark' : 'light';
}

/**
 * 固定模式直接就是配色；只有 `system` 需要去问操作系统。
 *
 * 纯函数：`systemPrefersDark` 由调用方读取，这样「系统深色 + 固定浅色」这类
 * 反例可以在单测里精确构造，不依赖 jsdom 的 matchMedia 桩。
 */
export function resolveColorScheme(
  mode: ThemeMode,
  systemPrefersDark: boolean,
): ResolvedColorScheme {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light';
  return mode;
}
