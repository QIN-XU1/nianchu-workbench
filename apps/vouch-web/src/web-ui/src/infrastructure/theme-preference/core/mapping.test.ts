import { describe, expect, it } from 'vitest';
import {
  deriveThemeMode,
  resolveColorScheme,
  themeModeToAppearanceSelectionId,
} from './mapping';

describe('themeModeToAppearanceSelectionId', () => {
  it('maps system to the appearance system sentinel, not to a package', () => {
    expect(themeModeToAppearanceSelectionId('system')).toBe('system');
  });

  it('maps light to the default light package', () => {
    expect(themeModeToAppearanceSelectionId('light')).toBe('openbitfun-light');
  });

  it('maps dark to the default dark package', () => {
    expect(themeModeToAppearanceSelectionId('dark')).toBe('openbitfun-dark');
  });
});

describe('deriveThemeMode', () => {
  it('reports system even when the resolved package is dark', () => {
    // 反例：只看 current.mode 会把「跟随系统 + 系统是深色」误判成「固定深色」，
    // 一进设置页就把用户的跟随系统选择改写成固定配色。
    expect(deriveThemeMode('system', 'dark')).toBe('system');
  });

  it('reports system when the resolved package is light', () => {
    expect(deriveThemeMode('system', 'light')).toBe('system');
  });

  it('reports system before the appearance package has resolved', () => {
    expect(deriveThemeMode('system', null)).toBe('system');
    expect(deriveThemeMode('system', undefined)).toBe('system');
  });

  it('reports dark for a custom dark skin, not just the default dark package', () => {
    expect(deriveThemeMode('openbitfun-cyber', 'dark')).toBe('dark');
  });

  it('reports light for the default light package', () => {
    expect(deriveThemeMode('openbitfun-light', 'light')).toBe('light');
  });

  it('falls back to light when the package mode is unknown', () => {
    expect(deriveThemeMode('openbitfun-custom', null)).toBe('light');
  });
});

describe('resolveColorScheme', () => {
  it('keeps a pinned light choice on a dark system', () => {
    expect(resolveColorScheme('light', true)).toBe('light');
  });

  it('keeps a pinned dark choice on a light system', () => {
    expect(resolveColorScheme('dark', false)).toBe('dark');
  });

  it('follows a dark system in system mode', () => {
    expect(resolveColorScheme('system', true)).toBe('dark');
  });

  it('follows a light system in system mode', () => {
    expect(resolveColorScheme('system', false)).toBe('light');
  });
});
