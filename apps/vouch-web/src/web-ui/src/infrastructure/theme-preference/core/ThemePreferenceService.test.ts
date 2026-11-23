// @vitest-environment jsdom

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configAPI } from '@/infrastructure/api';
import { ThemePreferenceService } from './ThemePreferenceService';

type AppearanceMode = 'light' | 'dark';

interface FakeSnapshot {
  initialized: boolean;
  status: 'initializing' | 'ready' | 'applying' | 'degraded';
  persistedSelectionId: string | null;
  selectedAppearanceId: string;
  resolvedAppearanceId: string | null;
  appearances: readonly unknown[];
  current: { id: string; mode: AppearanceMode } | null;
}

const PACKAGE_MODES: Record<string, AppearanceMode> = {
  'openbitfun-light': 'light',
  'openbitfun-dark': 'dark',
  'openbitfun-cyber': 'dark',
};

const fake = vi.hoisted(() => {
  const state = {
    snapshot: null as unknown as FakeSnapshot,
    listeners: new Set<() => void>(),
  };

  function reset(patch: Partial<FakeSnapshot> = {}): void {
    state.snapshot = {
      initialized: true,
      status: 'ready',
      persistedSelectionId: 'openbitfun-light',
      selectedAppearanceId: 'openbitfun-light',
      resolvedAppearanceId: 'openbitfun-light',
      appearances: [],
      current: { id: 'openbitfun-light', mode: 'light' },
      ...patch,
    } as FakeSnapshot;
    state.listeners.forEach(listener => listener());
  }

  const appearanceService = {
    getSnapshot: () => state.snapshot,
    initialize: vi.fn(async () => {}),
    subscribe: vi.fn((listener: () => void) => {
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    }),
    select: vi.fn(async (id: string) => {
      const mode = PACKAGE_MODES[id];
      state.snapshot = {
        ...state.snapshot,
        selectedAppearanceId: id,
        resolvedAppearanceId: mode ? id : null,
        current: mode ? { id, mode } : null,
      };
      state.listeners.forEach(listener => listener());
    }),
  };

  reset();

  return { state, reset, appearanceService };
});

vi.mock('@/infrastructure/appearance', () => ({
  appearanceService: fake.appearanceService,
}));

vi.mock('@/infrastructure/api', () => ({
  configAPI: {
    getConfig: vi.fn(async () => undefined),
    setConfig: vi.fn(async () => {}),
  },
}));

/** `system` 模式下读操作系统外观。 */
function stubSystemPrefersDark(prefersDark: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: prefersDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  })));
}

let service: ThemePreferenceService;

beforeEach(() => {
  fake.reset();
  service = new ThemePreferenceService();
  stubSystemPrefersDark(false);
});

afterEach(() => {
  service.dispose();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('getMode', () => {
  it('derives system from a system selection even when the package is dark', () => {
    fake.reset({
      selectedAppearanceId: 'system',
      current: { id: 'openbitfun-dark', mode: 'dark' },
    });

    expect(service.getMode()).toBe('system');
    expect(service.getPreference()).toEqual({ mode: 'system' });
  });

  it('derives dark from a custom dark skin', () => {
    fake.reset({
      selectedAppearanceId: 'openbitfun-cyber',
      current: { id: 'openbitfun-cyber', mode: 'dark' },
    });

    expect(service.getMode()).toBe('dark');
  });

  it('derives light from the default light package', () => {
    expect(service.getMode()).toBe('light');
  });
});

describe('getResolvedColorScheme', () => {
  it('follows the operating system while system mode has no applied package', () => {
    fake.reset({ selectedAppearanceId: 'system', current: null });
    stubSystemPrefersDark(true);

    expect(service.getResolvedColorScheme()).toBe('dark');

    stubSystemPrefersDark(false);

    expect(service.getResolvedColorScheme()).toBe('light');
  });

  it('prefers the applied package over the operating system', () => {
    stubSystemPrefersDark(true);

    expect(service.getResolvedColorScheme()).toBe('light');
  });
});

describe('isBusy', () => {
  it('reports busy while the appearance package is applying', () => {
    fake.reset({ status: 'applying' });

    expect(service.isBusy()).toBe(true);
  });

  it('reports busy before appearance initializes', () => {
    fake.reset({ initialized: false, status: 'initializing' });

    expect(service.isBusy()).toBe(true);
  });

  it('reports idle once the package is ready', () => {
    expect(service.isBusy()).toBe(false);
  });
});

describe('setMode', () => {
  it('selects the default dark package for dark', async () => {
    await service.setMode('dark');

    expect(fake.appearanceService.select).toHaveBeenCalledWith('openbitfun-dark');
    expect(service.getMode()).toBe('dark');
  });

  it('selects the default light package for light', async () => {
    fake.reset({
      selectedAppearanceId: 'openbitfun-dark',
      current: { id: 'openbitfun-dark', mode: 'dark' },
    });
    stubSystemPrefersDark(true);

    await service.setMode('light');

    expect(fake.appearanceService.select).toHaveBeenCalledWith('openbitfun-light');
    expect(service.getResolvedColorScheme()).toBe('light');
  });

  it('selects the system sentinel instead of a fixed dark package', async () => {
    fake.reset({
      selectedAppearanceId: 'openbitfun-dark',
      current: { id: 'openbitfun-dark', mode: 'dark' },
    });

    await service.setMode('system');

    expect(fake.appearanceService.select).toHaveBeenCalledWith('system');
  });

  it('does not reselect when the requested mode is already active', async () => {
    fake.reset({
      selectedAppearanceId: 'openbitfun-cyber',
      current: { id: 'openbitfun-cyber', mode: 'dark' },
    });

    await service.setMode('dark');

    expect(fake.appearanceService.select).not.toHaveBeenCalled();
  });

  it('propagates a failed appearance switch so callers can report it', async () => {
    fake.appearanceService.select.mockRejectedValueOnce(new Error('host offline'));

    await expect(service.setMode('dark')).rejects.toThrow('host offline');
  });

  it('never writes the colour scheme attribute itself', async () => {
    // 反例：早先的实现同时写 `data-color-scheme` 和 `app.theme_mode`，与
    // appearance 的 provider 抢同一个属性，出现「属性是 dark、token 还是浅色」。
    const setAttribute = vi.spyOn(document.documentElement, 'setAttribute');
    const styleSpy = vi.spyOn(document.documentElement.style, 'setProperty');

    await service.setMode('dark');
    await service.setMode('system');

    expect(setAttribute).not.toHaveBeenCalled();
    expect(styleSpy).not.toHaveBeenCalled();
    expect(configAPI.setConfig).not.toHaveBeenCalled();
  });
});

describe('subscriptions', () => {
  it('notifies listeners with the derived mode after an appearance change', async () => {
    const listener = vi.fn();
    service.subscribe(listener);

    await service.setMode('dark');

    expect(listener).toHaveBeenCalled();
    expect(listener).toHaveBeenLastCalledWith({ mode: 'dark' }, 'dark');
  });

  it('keeps a stable snapshot reference until a value changes', async () => {
    // useSyncExternalStore 要求快照引用稳定，否则会无限重渲染。
    const first = service.getState();
    expect(service.getState()).toBe(first);

    await service.setMode('dark');

    const next = service.getState();
    expect(next).not.toBe(first);
    expect(next).toBe(service.getState());
  });

  it('stops notifying after dispose', async () => {
    const listener = vi.fn();
    service.subscribe(listener);
    service.dispose();

    await service.setMode('dark');

    expect(listener).not.toHaveBeenCalled();
  });
});
