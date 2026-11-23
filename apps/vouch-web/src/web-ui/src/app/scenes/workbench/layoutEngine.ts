/**
 * 工作台布局引擎 —— **位置是数据，不是代码**
 *
 * 依据（来自 mashanglinyu/luanyujia-workbench 的 11-最小可运行壳/index.html）：
 *   `SCENES` 里每个面板是 `{ id, type, title, col, row, w, h }`，
 *   渲染成 CSS grid（`grid-template-columns: repeat(cols, minmax(0,1fr))`）。
 *   加一种面板 = 往注册表加一个函数；位置改了就换场景，不用改布局代码。
 *
 * 这份实现补上原仓库 demo 没做的两件事：
 *   ① **布局自检** —— 越界/重叠/id 重复必须能查出来（否则面板会互相盖住且不报错）
 *   ② 覆盖率 —— 一眼看出这个场景「排满了没有」
 *
 * 四态：布局合法 PASS / 有越界或重叠 FAIL / 缺面板 UNKNOWN
 */

export type PanelType =
  | 'canvas'    // 作品画布（agent 干的活摆在这）
  | 'harness'   // 主 agent 会话面板
  | 'artifact'  // 单张作品卡
  | 'reserved'; // 预留占位（版式先定、功能后补）

export type PanelDef = {
  id: string;
  type: PanelType;
  title: string;
  /** 1-based 起始列 */
  col: number;
  /** 1-based 起始行 */
  row: number;
  /** 跨列数 */
  w: number;
  /** 跨行数 */
  h: number;
  /** 该面板引用哪个面板（如 file→view 的配对），可选 */
  ref?: string;
};

export type SceneLayout = {
  id: string;
  name: string;
  icon?: string;
  cols: number;
  rows: number;
  panels: PanelDef[];
};

export type Issue = { level: 'error' | 'warn'; code: string; message: string };

/** 面板占据的格子集合（用于重叠检测） */
export function cellsOf(p: PanelDef): string[] {
  const out: string[] = [];
  for (let c = p.col; c < p.col + p.w; c++) {
    for (let r = p.row; r < p.row + p.h; r++) out.push(c + ',' + r);
  }
  return out;
}

/**
 * 布局自检（纯函数）
 *
 * 判据：
 *   · id 必须唯一（重复 ⇒ 渲染时 React key 冲突、操作打错面板）
 *   · 必须完全落在 cols×rows 内（越界 ⇒ 面板被裁掉或撑破容器）
 *   · 不允许重叠（重叠 ⇒ 上面的盖住下面的，而且**不会报错**）
 *   · 面板数为 0 ⇒ UNKNOWN（没排东西不等于排好了）
 */
export function validateLayout(layout: SceneLayout): { ok: boolean; issues: Issue[] } {
  const issues: Issue[] = [];
  const panels = layout?.panels ?? [];

  if (!layout || !Number.isFinite(layout.cols) || !Number.isFinite(layout.rows) || layout.cols < 1 || layout.rows < 1) {
    issues.push({ level: 'error', code: 'bad_grid', message: '网格尺寸非法（cols/rows 必须是 ≥1 的整数）' });
    return { ok: false, issues };
  }

  const seenId = new Set<string>();
  for (const p of panels) {
    if (!p.id || seenId.has(p.id)) {
      issues.push({ level: 'error', code: 'dup_id', message: '面板 id 重复或为空：' + String(p.id) });
    }
    seenId.add(p.id);

    if (!Number.isInteger(p.w) || !Number.isInteger(p.h) || p.w < 1 || p.h < 1) {
      issues.push({ level: 'error', code: 'bad_size', message: p.id + ' 的 w/h 必须是 ≥1 的整数' });
    }
    if (p.col < 1 || p.row < 1) {
      issues.push({ level: 'error', code: 'bad_origin', message: p.id + ' 的 col/row 必须 ≥1（1-based）' });
    }
    if (p.col + p.w - 1 > layout.cols) {
      issues.push({ level: 'error', code: 'overflow_x', message: p.id + ' 横向越界：col+w-1=' + (p.col + p.w - 1) + ' > cols=' + layout.cols });
    }
    if (p.row + p.h - 1 > layout.rows) {
      issues.push({ level: 'error', code: 'overflow_y', message: p.id + ' 纵向越界：row+h-1=' + (p.row + p.h - 1) + ' > rows=' + layout.rows });
    }
  }

  // 重叠检测：同一格子被两个面板占
  const owner = new Map<string, string>();
  for (const p of panels) {
    for (const c of cellsOf(p)) {
      const prev = owner.get(c);
      if (prev && prev !== p.id) {
        issues.push({ level: 'error', code: 'overlap', message: p.id + ' 与 ' + prev + ' 在格子 ' + c + ' 重叠' });
      } else {
        owner.set(c, p.id);
      }
    }
  }

  if (panels.length === 0) {
    issues.push({ level: 'warn', code: 'empty_layout', message: '场景里一个面板都没有 —— 判不了（不是排好了）' });
  }

  return { ok: issues.filter((i) => i.level === 'error').length === 0, issues };
}

/** 覆盖率：被占用的格子 / 总格子（0~1） */
export function coverage(layout: SceneLayout): number {
  const total = (layout?.cols || 0) * (layout?.rows || 0);
  if (!total) return 0;
  const owner = new Set<string>();
  for (const p of layout.panels || []) for (const c of cellsOf(p)) owner.add(c);
  return Math.min(1, owner.size / total);
}

/** 布局 → CSS grid 样式 */
export function gridStyle(layout: SceneLayout): Record<string, string | number> {
  return {
    display: 'grid',
    gridTemplateColumns: 'repeat(' + layout.cols + ', minmax(0, 1fr))',
    gridTemplateRows: 'repeat(' + layout.rows + ', minmax(0, 1fr))',
    gap: '10px',
    height: '100%',
    minHeight: 0,
  };
}

/** 单个面板 → CSS grid 定位 */
export function panelStyle(p: PanelDef): Record<string, string | number> {
  return {
    gridColumn: p.col + ' / span ' + p.w,
    gridRow: p.row + ' / span ' + p.h,
    minWidth: 0,
    minHeight: 0,
  };
}

/** 布局是否「能下结论」—— 给界面用 */
export function layoutVerdict(layout: SceneLayout): 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN' {
  const r = validateLayout(layout);
  if (!layout || !Array.isArray(layout.panels)) return 'UNKNOWN';
  if (r.issues.some((i) => i.level === 'error')) return 'FAIL';
  if (layout.panels.length === 0) return 'UNKNOWN';
  if (r.issues.length > 0) return 'WARN';
  return 'PASS';
}

/**
 * 默认工作台布局 —— **活人在左，主 agent 在右**
 *
 * 12 列 × 8 行：
 *   左（col 1-8）  ：作品画布，agent 干出来的东西都摆在这
 *   右（col 9-12） ：主 agent 会话面板（钉一条会话）
 *
 * 为什么 agent 在右：用户明确要求「主 agent 在画面右侧，agent 实际干的活在左侧」。
 * 这也和 luanyujia 默认场景一致（AI 面板在 col 7 / 共 8 列）。
 */
export const DEFAULT_LAYOUT: SceneLayout = {
  id: 'workbench',
  name: '工作台',
  icon: '⬚',
  cols: 12,
  rows: 8,
  panels: [
    { id: 'canvas', type: 'canvas', title: '作品画布', col: 1, row: 1, w: 8, h: 8 },
    { id: 'agent', type: 'harness', title: '念初 · 主 agent', col: 9, row: 1, w: 4, h: 8 },
  ],
};

/* ─────────────────────────────────────────────────────────────
   画布拖拽的坐标数学 —— 单独抽出来是因为「拖动会飘」全出在这里：
   视口坐标 → 画布坐标要同时扣掉 **滚动** 和 **缩放**，少扣一个就飘。
   ───────────────────────────────────────────────────────────── */

export type Point = { x: number; y: number };

/** 视口坐标 → 画布内坐标（必须扣滚动与缩放） */
export function toCanvasPoint(args: {
  clientX: number;
  clientY: number;
  rectLeft: number;
  rectTop: number;
  scrollLeft: number;
  scrollTop: number;
  zoom: number;
}): Point {
  const z = args.zoom > 0 ? args.zoom : 1;
  return {
    x: (args.clientX - args.rectLeft + args.scrollLeft) / z,
    y: (args.clientY - args.rectTop + args.scrollTop) / z,
  };
}

/** 夹到画布范围内（不允许拖到负坐标，也不允许超出内层尺寸） */
export function clampPos(p: Point, bounds: { width: number; height: number; cardW: number; cardH: number }): Point {
  const maxX = Math.max(0, bounds.width - bounds.cardW);
  const maxY = Math.max(0, bounds.height - bounds.cardH);
  return {
    x: Math.min(Math.max(0, Math.round(p.x)), maxX),
    y: Math.min(Math.max(0, Math.round(p.y)), maxY),
  };
}

/**
 * 拖动结果 = 当前指针的画布坐标 − 按下时的偏移
 * @param pointerLocal 当前指针的画布坐标
 * @param grabOffset   按下时「指针 − 卡片左上角」的偏移
 */
export function dragTo(pointerLocal: Point, grabOffset: Point): Point {
  return { x: pointerLocal.x - grabOffset.x, y: pointerLocal.y - grabOffset.y };
}

/** 判定是「点击」还是「拖动」：位移 ≤ 阈值算点击（否则轻微抖动会吃掉点击） */
export function isDrag(moved: Point, threshold = 3): boolean {
  return Math.abs(moved.x) > threshold || Math.abs(moved.y) > threshold;
}

