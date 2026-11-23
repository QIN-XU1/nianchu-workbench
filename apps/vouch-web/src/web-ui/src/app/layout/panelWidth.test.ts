// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  PANEL_WIDTH_DEFAULT,
  PANEL_WIDTH_KEY,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  PANEL_WIDTH_STEP,
  PANEL_WIDTH_STEP_LARGE,
  PANEL_WIDTH_VIEWPORT_RATIO,
  clampPanelWidth,
  nudgePanelWidth,
  readPanelWidth,
  widthFromDrag,
  writePanelWidth,
} from './panelWidth';

function memStore(): Pick<Storage, 'getItem'> & Pick<Storage, 'setItem'> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  } as never;
}

describe('clampPanelWidth', () => {
  it('★默认值原样保留', () => {
    expect(clampPanelWidth(PANEL_WIDTH_DEFAULT)).toBe(PANEL_WIDTH_DEFAULT);
  });

  it('★数字字符串也认（localStorage 里存的就是字符串）', () => {
    expect(clampPanelWidth('512')).toBe(512);
  });

  it('★小于下限夹到 320、大于上限夹到 760', () => {
    expect(clampPanelWidth(10)).toBe(PANEL_WIDTH_MIN);
    expect(clampPanelWidth(9999)).toBe(PANEL_WIDTH_MAX);
  });

  it('★NaN / Infinity / 非数字 / null → 默认值（绝不返回 NaN）', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity, 'abc', {}, [], null, undefined, true]) {
      expect(clampPanelWidth(bad)).toBe(PANEL_WIDTH_DEFAULT);
    }
  });

  it('★小数四舍五入到整数', () => {
    expect(clampPanelWidth(400.6)).toBe(401);
  });

  it('★给了视口宽度时受 46vw 约束', () => {
    expect(clampPanelWidth(700, 800)).toBe(Math.floor(800 * PANEL_WIDTH_VIEWPORT_RATIO));
    expect(clampPanelWidth(700, 2000)).toBe(700);
  });

  it('★视口极窄时以下限为准（不窄到不可用）', () => {
    expect(clampPanelWidth(400, 300)).toBe(PANEL_WIDTH_MIN);
  });

  it('★非法视口宽度不参与约束（回落到 760 上限）', () => {
    expect(clampPanelWidth(9999, Number.NaN)).toBe(PANEL_WIDTH_MAX);
    expect(clampPanelWidth(9999, 0)).toBe(PANEL_WIDTH_MAX);
  });
});

describe('readPanelWidth / writePanelWidth', () => {
  it('★写入再读出，值一致', () => {
    const store = memStore();
    expect(writePanelWidth(520, store)).toBe(520);
    expect(store.map.get(PANEL_WIDTH_KEY)).toBe('520');
    expect(readPanelWidth(store)).toBe(520);
  });

  it('★写入前先夹，落盘的也是夹过的值', () => {
    const store = memStore();
    expect(writePanelWidth(9999, store)).toBe(PANEL_WIDTH_MAX);
    expect(store.map.get(PANEL_WIDTH_KEY)).toBe(String(PANEL_WIDTH_MAX));
  });

  it('★空存储 → 默认值', () => {
    expect(readPanelWidth(memStore())).toBe(PANEL_WIDTH_DEFAULT);
  });

  it('★存储里是脏数据 → 默认值（不抛）', () => {
    const store = memStore();
    store.map.set(PANEL_WIDTH_KEY, 'not-a-number');
    expect(readPanelWidth(store)).toBe(PANEL_WIDTH_DEFAULT);
  });

  it('★没有存储对象 / setItem 抛错 → 不抛，返回夹过的值', () => {
    expect(readPanelWidth(null)).toBe(PANEL_WIDTH_DEFAULT);
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    } as never;
    expect(readPanelWidth(broken)).toBe(PANEL_WIDTH_DEFAULT);
    expect(writePanelWidth(500, broken)).toBe(500);
  });
});

describe('nudgePanelWidth', () => {
  it('★往左 = 加宽，往右 = 变窄，步长各一档', () => {
    expect(nudgePanelWidth(400, 'left')).toBe(400 + PANEL_WIDTH_STEP);
    expect(nudgePanelWidth(400, 'right')).toBe(400 - PANEL_WIDTH_STEP);
    expect(nudgePanelWidth(400, 'left', true)).toBe(400 + PANEL_WIDTH_STEP_LARGE);
    expect(nudgePanelWidth(400, 'right', true)).toBe(400 - PANEL_WIDTH_STEP_LARGE);
  });

  it('★到边界夹住，不会越界', () => {
    expect(nudgePanelWidth(PANEL_WIDTH_MAX, 'left')).toBe(PANEL_WIDTH_MAX);
    expect(nudgePanelWidth(PANEL_WIDTH_MIN, 'right')).toBe(PANEL_WIDTH_MIN);
  });

  it('★非法当前值按默认值算', () => {
    expect(nudgePanelWidth(Number.NaN, 'left')).toBe(PANEL_WIDTH_DEFAULT + PANEL_WIDTH_STEP);
  });
});

describe('widthFromDrag', () => {
  it('★指针向左拖（dx<0）→ 变宽；向右拖 → 变窄', () => {
    expect(widthFromDrag(400, -120)).toBe(520);
    expect(widthFromDrag(400, 120)).toBe(PANEL_WIDTH_MIN);
  });

  it('★拖到超界夹住', () => {
    expect(widthFromDrag(PANEL_WIDTH_MAX, -9999)).toBe(PANEL_WIDTH_MAX);
    expect(widthFromDrag(PANEL_WIDTH_MIN, 9999)).toBe(PANEL_WIDTH_MIN);
  });

  it('★非法 dx（NaN / 非数字）当作没移动', () => {
    expect(widthFromDrag(400, Number.NaN)).toBe(400);
    expect(widthFromDrag(400, 'x')).toBe(400);
  });

  it('★非法起点按默认值算，且受视口约束', () => {
    expect(widthFromDrag(null, 0)).toBe(PANEL_WIDTH_DEFAULT);
    expect(widthFromDrag(700, 0, 800)).toBe(Math.floor(800 * PANEL_WIDTH_VIEWPORT_RATIO));
  });
});
