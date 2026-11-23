export type { ResolvedColorScheme, ThemeMode, ThemePreference } from './types';
export {
  DEFAULT_THEME_PREFERENCE,
  normalizeThemeMode,
  THEME_MODES,
} from './types';
export {
  deriveThemeMode,
  resolveColorScheme,
  themeModeToAppearanceSelectionId,
} from './core/mapping';
export {
  ThemePreferenceService,
  themePreferenceService,
  type ThemeChangeListener,
  type ThemePreferenceState,
} from './core/ThemePreferenceService';
export { useThemePreference, type ThemePreferenceControls } from './hooks/useThemePreference';
export { ThemePreferencePanel } from './components/ThemePreferencePanel';
export { themePreferenceAppearanceDescriptor } from './appearance';
