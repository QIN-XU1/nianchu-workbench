// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NCC_THEME,
  NCC_THEME_IDS,
  NCC_THEME_OPTIONS,
  NCC_THEME_STORAGE_KEY,
  NCC_THEME_TIP,
  isNccTheme,
  normalizeNccTheme,
  readNccTheme,
  writeNccTheme,
} from './panelTheme';

function memStore(): Pick<Storage, 'getItem'> & Pick<Storage, 'setItem'> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  } as never;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('档位表（唯一真源）', () => {
  it('五档顺序：system → light → dark → claude → dsh', () => {
    expect([...NCC_THEME_IDS]).toEqual(['system', 'light', 'dark', 'claude', 'dsh']);
  });

  it('默认档是 system（升级不改变现有外观）', () => {
    expect(DEFAULT_NCC_THEME).toBe('system');
  });

  it('★选项表的 id 集合与枚举完全一致（改名必然红）', () => {
    expect(NCC_THEME_OPTIONS.map((o) => o.id).sort()).toEqual([...NCC_THEME_IDS].sort());
  });

  it('每个选项都有非空文案与说明（界面上不会出现空行）', () => {
    for (const opt of NCC_THEME_OPTIONS) {
      expect(opt.label.trim().length).toBeGreaterThan(0);
      expect(opt.hint.trim().length).toBeGreaterThan(0);
    }
  });

  it('说明文案点明「只影响面板」与「跟随应用」两件事', () => {
    expect(NCC_THEME_TIP).toContain('只影响念初面板');
    expect(NCC_THEME_TIP).toContain('跟随应用');
  });
});

describe('normalizeNccTheme（脏值兜底）', () => {
  it('五个合法值原样返回', () => {
    for (const id of NCC_THEME_IDS) expect(normalizeNccTheme(id)).toBe(id);
  });

  it('★脏值一律回落 system（不猜、不抛）', () => {
    const dirty = ['', ' ', 'DARK', ' dark', 'auto', 'claude-light', 1, 0, null, undefined, {}, [], true];
    for (const v of dirty) expect(normalizeNccTheme(v)).toBe('system');
  });

  it('类型守卫只认五个字面量', () => {
    expect(isNccTheme('claude')).toBe(true);
    expect(isNccTheme('Claude')).toBe(false);
    expect(isNccTheme(undefined)).toBe(false);
    expect(isNccTheme(5)).toBe(false);
  });
});

describe('读写持久化', () => {
  it('未写过 → 默认档', () => {
    expect(readNccTheme(memStore())).toBe('system');
  });

  it('★写入后能读回（真的落盘，不是内存态）', () => {
    const s = memStore();
    writeNccTheme('dark', s);
    expect(s.map.get(NCC_THEME_STORAGE_KEY)).toBe('dark');
    expect(readNccTheme(s)).toBe('dark');
  });

  it('★写入脏值 → 归一化后再落盘（存储里只有合法 id）', () => {
    const s = memStore();
    expect(writeNccTheme('DARK' as never, s)).toBe('system');
    expect(s.map.get(NCC_THEME_STORAGE_KEY)).toBe('system');
  });

  it('★存储抛错（隐私模式）→ 读回落默认、写不抛且返回传入档位', () => {
    const boom = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    } as never;
    expect(readNccTheme(boom)).toBe('system');
    expect(writeNccTheme('claude', boom)).toBe('claude');
  });

  it('★没有 localStorage（SSR / node）→ 默认档，不抛', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readNccTheme()).toBe('system');
    expect(writeNccTheme('dsh')).toBe('dsh');
  });

  it('存的是别的键 → 不算数', () => {
    const s = memStore();
    s.setItem('other_theme', 'dark');
    expect(readNccTheme(s)).toBe('system');
  });
});

describe('往返一致', () => {
  it('★五档各自「写 → 读」都不漂移', () => {
    for (const id of NCC_THEME_IDS) {
      const s = memStore();
      writeNccTheme(id, s);
      expect(readNccTheme(s)).toBe(id);
    }
  });
});
