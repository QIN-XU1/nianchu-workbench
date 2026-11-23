// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedColorScheme, ThemeMode } from '../types';
import { ThemePreferencePanel } from './ThemePreferencePanel';

const preferenceState = vi.hoisted(() => ({
  mode: 'system' as ThemeMode,
  resolved: 'light' as ResolvedColorScheme,
  busy: false,
  setMode: vi.fn(),
}));

const notificationMocks = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Interpolate the one translated option so the assertion can prove the
    // resolved scheme reaches the hint instead of a static string.
    t: (key: string, options?: { scheme?: string }) => (
      options?.scheme ? `${key}:${options.scheme}` : key
    ),
  }),
}));

vi.mock('../hooks/useThemePreference', () => ({
  useThemePreference: () => ({
    mode: preferenceState.mode,
    resolved: preferenceState.resolved,
    busy: preferenceState.busy,
    setMode: preferenceState.setMode,
  }),
}));

vi.mock('@/shared/notification-system', () => ({
  notificationService: notificationMocks,
}));

function segments(container: ParentNode): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
}

function renderInteractive(): { container: HTMLDivElement; root: Root } {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  return { container, root };
}

describe('ThemePreferencePanel', () => {
  beforeEach(() => {
    preferenceState.mode = 'system';
    preferenceState.resolved = 'light';
    preferenceState.busy = false;
    preferenceState.setMode.mockReset();
    preferenceState.setMode.mockResolvedValue(undefined);
    notificationMocks.error.mockReset();
  });

  it('offers all three modes and reports the resolved scheme', () => {
    document.body.innerHTML = renderToStaticMarkup(<ThemePreferencePanel />);

    const buttons = segments(document);
    expect(buttons.map((button) => button.textContent)).toEqual([
      'themeMode.system',
      'themeMode.light',
      'themeMode.dark',
    ]);
    // 每档都带上值标记与外观契约，e2e 可以直接按 data-openbitfun-value 定位/断言。
    expect(buttons.map((button) => button.getAttribute('data-openbitfun-value'))).toEqual([
      'system',
      'light',
      'dark',
    ]);
    expect(buttons.map((button) => button.getAttribute('data-openbitfun-part'))).toEqual([
      'segment',
      'segment',
      'segment',
    ]);
    expect(buttons.map((button) => button.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    // In `system` mode the segments cannot say which scheme is on screen.
    expect(
      document.querySelector('[data-testid="appearance-theme-mode-resolved"]')?.textContent,
    ).toBe('themeMode.resolvedHint:themeMode.light');
    expect(
      document.querySelector('[data-testid="appearance-theme-mode"]')
        ?.getAttribute('data-openbitfun-component'),
    ).toBe('theme-preference');
    expect(
      document.querySelector('[data-openbitfun-part="controls"]'),
    ).not.toBeNull();
  });

  it('reports the dark scheme when the OS resolves dark', () => {
    preferenceState.resolved = 'dark';

    document.body.innerHTML = renderToStaticMarkup(<ThemePreferencePanel />);

    expect(
      document.querySelector('[data-testid="appearance-theme-mode-resolved"]')?.textContent,
    ).toBe('themeMode.resolvedHint:themeMode.dark');
  });

  it('marks the active mode as checked', () => {
    preferenceState.mode = 'dark';
    preferenceState.resolved = 'dark';

    document.body.innerHTML = renderToStaticMarkup(<ThemePreferencePanel />);

    expect(segments(document).map((button) => button.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'true',
    ]);
  });

  it('disables every mode while the appearance package is applying', () => {
    preferenceState.busy = true;

    document.body.innerHTML = renderToStaticMarkup(<ThemePreferencePanel />);

    expect(
      document.querySelector('[data-testid="appearance-theme-mode"]')?.getAttribute('aria-busy'),
    ).toBe('true');
    expect(
      document.querySelector('[data-testid="appearance-theme-mode-group"]')
        ?.getAttribute('aria-disabled'),
    ).toBe('true');
    expect(segments(document).every((button) => button.disabled)).toBe(true);
  });

  it('stays interactive and quiet once the package is ready', () => {
    document.body.innerHTML = renderToStaticMarkup(<ThemePreferencePanel />);

    expect(
      document.querySelector('[data-testid="appearance-theme-mode"]')?.hasAttribute('aria-busy'),
    ).toBe(false);
    expect(segments(document).some((button) => button.disabled)).toBe(false);
  });

  it('forwards the picked mode to the service', async () => {
    const { container, root } = renderInteractive();
    try {
      await act(async () => root.render(<ThemePreferencePanel />));
      const dark = container.querySelector<HTMLButtonElement>('[data-openbitfun-value="dark"]');
      expect(dark).not.toBeNull();
      await act(async () => {
        dark?.click();
      });
      expect(preferenceState.setMode).toHaveBeenCalledWith('dark');
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('moves the selection with arrow keys', async () => {
    const { container, root } = renderInteractive();
    try {
      await act(async () => root.render(<ThemePreferencePanel />));
      const group = container.querySelector('[data-testid="appearance-theme-mode-group"]');
      expect(group).not.toBeNull();
      await act(async () => {
        group?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      });
      expect(preferenceState.setMode).toHaveBeenCalledWith('light');
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('explains a failed save instead of silently reverting', async () => {
    preferenceState.setMode.mockRejectedValue(new Error('offline'));
    const { container, root } = renderInteractive();
    try {
      await act(async () => root.render(<ThemePreferencePanel />));
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-openbitfun-value="light"]')?.click();
      });
      expect(preferenceState.setMode).toHaveBeenCalledWith('light');
      expect(notificationMocks.error).toHaveBeenCalledWith('themeMode.saveFailed');
    } finally {
      await act(async () => root.unmount());
    }
  });
});
