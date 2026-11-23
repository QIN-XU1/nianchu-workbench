// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CUE_SETTINGS,
  playCompletionCue,
  readCueSettings,
  shouldCueTurn,
  writeCueSettings,
} from './completionCues';

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

describe('开关读写', () => {
  it('★默认两个都关（不主动打扰）', () => {
    expect(readCueSettings(memStore())).toEqual(DEFAULT_CUE_SETTINGS);
  });
  it('写入后能读回，合并写不丢另一个键', () => {
    const s = memStore();
    writeCueSettings({ sound: true }, s);
    expect(readCueSettings(s)).toEqual({ sound: true, notify: false });
    writeCueSettings({ notify: true }, s);
    expect(readCueSettings(s)).toEqual({ sound: true, notify: true });
  });
  it('★存储损坏 → 回退默认，不抛', () => {
    const s = memStore();
    s.setItem('nianchu.completionCues.v1', '{oops');
    expect(readCueSettings(s)).toEqual(DEFAULT_CUE_SETTINGS);
  });
  it('非布尔值不认（JSON 里 sound:"yes" 视为关）', () => {
    const s = memStore();
    s.setItem('nianchu.completionCues.v1', JSON.stringify({ sound: 'yes', notify: 1 }));
    expect(readCueSettings(s)).toEqual(DEFAULT_CUE_SETTINGS);
  });
});

describe('shouldCueTurn（只在 RUNNING→PASS 响一次）', () => {
  it('RUNNING→PASS 响', () => {
    expect(shouldCueTurn('RUNNING', 'PASS')).toBe(true);
  });
  it('★失败/中断不响（不误报成功）', () => {
    expect(shouldCueTurn('RUNNING', 'FAIL')).toBe(false);
    expect(shouldCueTurn('RUNNING', 'INTERRUPTED')).toBe(false);
  });
  it('其他边不响', () => {
    expect(shouldCueTurn('PASS', 'PASS')).toBe(false);
    expect(shouldCueTurn(null, 'PASS')).toBe(false);
    expect(shouldCueTurn('RUNNING', undefined)).toBe(false);
  });
});

describe('playCompletionCue', () => {
  it('★没有 AudioContext → 静默 false，不抛', () => {
    expect(playCompletionCue({})).toBe(false);
  });
  it('有 AudioContext → 建 2 个振荡器并启动，返回 true', () => {
    const started: number[] = [];
    const ctx = {
      currentTime: 0,
      destination: {},
      createOscillator: () => {
        const osc = {
          type: 'sine',
          frequency: { value: 0 },
          connect: vi.fn(),
          start: (t: number) => started.push(t),
          stop: vi.fn(),
        };
        return osc;
      },
      createGain: () => ({
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      }),
      close: vi.fn(),
    };
    // 普通函数才能用 new 调用（箭头函数不能构造）
    function Ctx() { return ctx as never; }
    const CtxCtor = Ctx as unknown as typeof AudioContext;
    expect(playCompletionCue({ AudioContext: CtxCtor })).toBe(true);
    expect(started).toHaveLength(2);
    expect(started[1] - started[0]).toBeCloseTo(0.16, 5);
  });
  it('构造 AudioContext 抛错 → 静默 false', () => {
    const Ctx = vi.fn(() => {
      throw new Error('blocked');
    }) as unknown as typeof AudioContext;
    expect(playCompletionCue({ AudioContext: Ctx })).toBe(false);
  });
});
