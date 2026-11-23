import { describe, it, expect } from 'vitest';
import {
  validateLayout,
  coverage,
  cellsOf,
  gridStyle,
  panelStyle,
  layoutVerdict,
  DEFAULT_LAYOUT,
  toCanvasPoint,
  clampPos,
  dragTo,
  isDrag,
} from './layoutEngine';
import type { SceneLayout } from './layoutEngine';

/**
 * 布局引擎反例验收。
 * 重点：越界 / 重叠 / id 重复必须被查出来 —— 否则面板会互相盖住且不报错。
 */

const L = (panels: SceneLayout['panels'], cols = 12, rows = 8): SceneLayout => ({
  id: 't', name: 't', cols, rows, panels,
});

describe('validateLayout —— 布局自检', () => {
  it('正例：默认布局合法', () => {
    const r = validateLayout(DEFAULT_LAYOUT);
    expect(r.ok).toBe(true);
    expect(r.issues.filter((i) => i.level === 'error').length).toBe(0);
  });

  it('正例：默认布局里画布在左、agent 在右（col 9 起）', () => {
    const canvas = DEFAULT_LAYOUT.panels.find((p) => p.type === 'canvas');
    const agent = DEFAULT_LAYOUT.panels.find((p) => p.type === 'harness');
    expect(canvas).toBeTruthy();
    expect(agent).toBeTruthy();
    // agent 必须整体在 canvas 右侧
    expect(agent!.col).toBeGreaterThan(canvas!.col + canvas!.w - 1);
  });

  it('反例：横向越界 ⇒ error overflow_x', () => {
    const r = validateLayout(L([{ id: 'a', type: 'canvas', title: 'a', col: 10, row: 1, w: 5, h: 1 }]));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'overflow_x')).toBe(true);
  });

  it('反例：纵向越界 ⇒ error overflow_y', () => {
    const r = validateLayout(L([{ id: 'a', type: 'canvas', title: 'a', col: 1, row: 7, w: 1, h: 5 }]));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'overflow_y')).toBe(true);
  });

  it('反例：两个面板重叠 ⇒ error overlap（不许静默盖住）', () => {
    const r = validateLayout(L([
      { id: 'a', type: 'canvas', title: 'a', col: 1, row: 1, w: 4, h: 4 },
      { id: 'b', type: 'harness', title: 'b', col: 3, row: 3, w: 4, h: 4 },
    ]));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'overlap')).toBe(true);
  });

  it('正例：相邻但不重叠 ⇒ 不算重叠', () => {
    const r = validateLayout(L([
      { id: 'a', type: 'canvas', title: 'a', col: 1, row: 1, w: 4, h: 4 },
      { id: 'b', type: 'harness', title: 'b', col: 5, row: 1, w: 4, h: 4 },
    ]));
    expect(r.ok).toBe(true);
  });

  it('反例：id 重复 ⇒ error dup_id', () => {
    const r = validateLayout(L([
      { id: 'a', type: 'canvas', title: 'a', col: 1, row: 1, w: 2, h: 2 },
      { id: 'a', type: 'canvas', title: 'a2', col: 3, row: 1, w: 2, h: 2 },
    ]));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'dup_id')).toBe(true);
  });

  it('反例：col/row 小于 1 ⇒ error bad_origin（1-based）', () => {
    const r = validateLayout(L([{ id: 'a', type: 'canvas', title: 'a', col: 0, row: 1, w: 2, h: 2 }]));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'bad_origin')).toBe(true);
  });

  it('反例：w/h 非整数或 <1 ⇒ error bad_size', () => {
    const r = validateLayout(L([{ id: 'a', type: 'canvas', title: 'a', col: 1, row: 1, w: 0, h: 2 }]));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'bad_size')).toBe(true);
  });

  it('反例：网格尺寸非法 ⇒ bad_grid', () => {
    expect(validateLayout(L([], 0, 8)).issues.some((i) => i.code === 'bad_grid')).toBe(true);
  });

  it('反例：一个面板都没有 ⇒ warn empty_layout 且判 UNKNOWN（不是 PASS）', () => {
    const r = validateLayout(L([]));
    expect(r.issues.some((i) => i.code === 'empty_layout')).toBe(true);
    expect(layoutVerdict(L([]))).toBe('UNKNOWN');
  });
});

describe('coverage', () => {
  it('默认布局：画布 8×8 + agent 4×8 = 96/96 ⇒ 100%', () => {
    expect(coverage(DEFAULT_LAYOUT)).toBeCloseTo(1, 5);
  });

  it('反例：空布局 ⇒ 0（不是 1）', () => {
    expect(coverage(L([]))).toBe(0);
  });

  it('部分覆盖算得对：12×8 里放 1×1 ⇒ 1/96', () => {
    expect(coverage(L([{ id: 'a', type: 'reserved', title: 'a', col: 1, row: 1, w: 1, h: 1 }]))).toBeCloseTo(1 / 96, 6);
  });
});

describe('cellsOf / gridStyle / panelStyle', () => {
  it('cellsOf 返回 w×h 个格子', () => {
    expect(cellsOf({ id: 'a', type: 'canvas', title: 'a', col: 1, row: 1, w: 3, h: 2 }).length).toBe(6);
  });

  it('gridStyle 用 repeat(cols/rows)', () => {
    const s = gridStyle(DEFAULT_LAYOUT) as Record<string, unknown>;
    expect(String(s.gridTemplateColumns)).toContain('repeat(12');
    expect(String(s.gridTemplateRows)).toContain('repeat(8');
  });

  it('panelStyle 用 span 表达跨格', () => {
    const s = panelStyle({ id: 'a', type: 'canvas', title: 'a', col: 9, row: 1, w: 4, h: 8 }) as Record<string, unknown>;
    expect(s.gridColumn).toBe('9 / span 4');
    expect(s.gridRow).toBe('1 / span 8');
  });
});

describe('layoutVerdict', () => {
  it('默认布局 ⇒ PASS', () => {
    expect(layoutVerdict(DEFAULT_LAYOUT)).toBe('PASS');
  });
  it('反例：越界 ⇒ FAIL', () => {
    expect(layoutVerdict(L([{ id: 'a', type: 'canvas', title: 'a', col: 12, row: 1, w: 4, h: 1 }]))).toBe('FAIL');
  });
  it('可复算：同输入两次一致', () => {
    expect(layoutVerdict(DEFAULT_LAYOUT)).toBe(layoutVerdict(DEFAULT_LAYOUT));
  });
});

describe('拖拽坐标数学 —— 「拖动会飘」全出在这里', () => {
  const base = { rectLeft: 100, rectTop: 50, scrollLeft: 0, scrollTop: 0, zoom: 1 };

  it('正例：无滚动无缩放 ⇒ 直接减去矩形原点', () => {
    const p = toCanvasPoint({ ...base, clientX: 300, clientY: 250 });
    expect(p).toEqual({ x: 200, y: 200 });
  });

  it('反例：画布滚动了必须扣掉 scroll（不扣就飘）', () => {
    const p = toCanvasPoint({ ...base, clientX: 300, clientY: 250, scrollLeft: 120, scrollTop: 40 });
    expect(p).toEqual({ x: 320, y: 240 });
  });

  it('反例：缩放 0.5 时必须除以 zoom（不除就飘一倍）', () => {
    const p = toCanvasPoint({ ...base, clientX: 300, clientY: 250, zoom: 0.5 });
    expect(p).toEqual({ x: 400, y: 400 });
  });

  it('反例：缩放 2 时必须除以 zoom', () => {
    const p = toCanvasPoint({ ...base, clientX: 300, clientY: 250, zoom: 2 });
    expect(p).toEqual({ x: 100, y: 100 });
  });

  it('反例：zoom=0 不许除出 Infinity（兜底当 1）', () => {
    const p = toCanvasPoint({ ...base, clientX: 300, clientY: 250, zoom: 0 });
    expect(Number.isFinite(p.x)).toBe(true);
    expect(p).toEqual({ x: 200, y: 200 });
  });

  it('正例：clampPos 夹到 0 以上', () => {
    expect(clampPos({ x: -50, y: -20 }, { width: 480, height: 1040, cardW: 216, cardH: 200 })).toEqual({ x: 0, y: 0 });
  });

  it('反例：clampPos 夹到右下边界（不许拖出画布）', () => {
    expect(clampPos({ x: 9999, y: 9999 }, { width: 480, height: 1040, cardW: 216, cardH: 200 }))
      .toEqual({ x: 264, y: 840 });
  });

  it('正例：dragTo = 指针 − 抓取偏移', () => {
    expect(dragTo({ x: 500, y: 400 }, { x: 30, y: 20 })).toEqual({ x: 470, y: 380 });
  });

  it('反例：轻微抖动不算拖动（否则点击会被吃掉）', () => {
    expect(isDrag({ x: 2, y: 1 })).toBe(false);
  });

  it('正例：超过阈值算拖动', () => {
    expect(isDrag({ x: 6, y: 0 })).toBe(true);
  });

  it('可复算：同输入两次一致', () => {
    const a = toCanvasPoint({ ...base, clientX: 300, clientY: 250, scrollLeft: 10, zoom: 1.5 });
    const b = toCanvasPoint({ ...base, clientX: 300, clientY: 250, scrollLeft: 10, zoom: 1.5 });
    expect(a).toEqual(b);
  });
});