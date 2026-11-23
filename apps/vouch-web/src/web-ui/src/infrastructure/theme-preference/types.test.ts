import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME_PREFERENCE, THEME_MODES, normalizeThemeMode } from './types';

describe('normalizeThemeMode', () => {
  it.each(['system', 'light', 'dark'] as const)('keeps the valid %s mode', (mode) => {
    expect(normalizeThemeMode(mode)).toBe(mode);
  });

  it.each([undefined, null, '', 'purple', 'Dark', 'dark ', 0, false, ['dark'], { mode: 'dark' }])(
    'falls back to the default for %s',
    (value) => {
      expect(normalizeThemeMode(value)).toBe(DEFAULT_THEME_PREFERENCE.mode);
    },
  );

  it('keeps the default aligned with the OS-following shell it replaces', () => {
    // `index.html` painted from `prefers-color-scheme` before this preference
    // existed; an upgrade must not change how the app looks.
    expect(DEFAULT_THEME_PREFERENCE.mode).toBe('system');
    expect(THEME_MODES).toEqual(['system', 'light', 'dark']);
  });
});
