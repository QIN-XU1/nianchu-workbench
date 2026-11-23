/**
 * 面板宽度（批次 Z.29，对标 Cherry Studio 的 `--assistants-width` 布局令牌与
 * Cursor / Claude 的侧栏拖宽）。
 *
 * 【为什么】面板宽度此前写死 `--openbitfun-fmc-dock-width: 400px`：
 *  - 代码多的时候一行太短，diff 折成豆腐块；
 *  - 屏幕宽的时候又空着一大片。
 * 宽度是**本机视图偏好**，存 localStorage（刷新仍在、换机器不跟随），
 * 不假装跨设备同步。
 *
 * 纯函数，边界写死：
 *  - 非法输入（NaN / 非数字 / 非有限 / 非对象）→ 默认值，绝不返回 NaN 或 0
 *  - 一律夹到 [320, 760]；给了视口宽度时再夹到「不超过 46vw」（与 scss 的
 *    `max-width: 46vw` 同一个上限，避免键盘调大后在窄屏上溢出）
 *  - 拖动方向：分隔条在面板**左边缘**，向左拖 = 变宽（dx 为负 → 加宽）
 *  - 存储损坏 → 默认值（不抛）
 */

/** localStorage 键名。 */
export const PANEL_WIDTH_KEY = 'ncc_panel_width';

/** 最窄：再窄工具卡会挤断。 */
export const PANEL_WIDTH_MIN = 320;

/** 最宽：再宽会把工作区挤没。 */
export const PANEL_WIDTH_MAX = 760;

/** 默认宽度（与改造前的写死值一致，老用户无感）。 */
export const PANEL_WIDTH_DEFAULT = 400;

/** 方向键步长。 */
export const PANEL_WIDTH_STEP = 16;

/** Shift + 方向键步长。 */
export const PANEL_WIDTH_STEP_LARGE = 64;

/** scss 里 `max-width: 46vw` 的同源上限（0–1）。 */
export const PANEL_WIDTH_VIEWPORT_RATIO = 0.46;

/** 把任意值收成合法宽度；viewportWidth 给了就同时受 46vw 约束。 */
export function clampPanelWidth(value: unknown, viewportWidth?: number): number {
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  const base = Number.isFinite(num) ? Math.round(num) : PANEL_WIDTH_DEFAULT;
  let upper = PANEL_WIDTH_MAX;
  if (typeof viewportWidth === 'number' && Number.isFinite(viewportWidth) && viewportWidth > 0) {
    const byViewport = Math.floor(viewportWidth * PANEL_WIDTH_VIEWPORT_RATIO);
    // 视口极窄时 46vw 可能小于下限：此时以下限为准（宁可挤，也不要窄到不可用）
    upper = Math.max(PANEL_WIDTH_MIN, Math.min(PANEL_WIDTH_MAX, byViewport));
  }
  return Math.min(upper, Math.max(PANEL_WIDTH_MIN, base));
}

/** 读宽度；无存储 / 损坏 / 非法 → 默认值（不抛）。 */
export function readPanelWidth(
  storage?: Pick<Storage, 'getItem'> | null,
  viewportWidth?: number,
): number {
  try {
    const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    const raw = store?.getItem(PANEL_WIDTH_KEY);
    if (raw === null || raw === undefined || raw === '') return clampPanelWidth(PANEL_WIDTH_DEFAULT, viewportWidth);
    return clampPanelWidth(raw, viewportWidth);
  } catch {
    return clampPanelWidth(PANEL_WIDTH_DEFAULT, viewportWidth);
  }
}

/** 写宽度（先夹再落盘），返回实际写入的值。 */
export function writePanelWidth(
  width: unknown,
  storage?: Pick<Storage, 'setItem'> | null,
  viewportWidth?: number,
): number {
  const next = clampPanelWidth(width, viewportWidth);
  try {
    const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    store?.setItem(PANEL_WIDTH_KEY, String(next));
  } catch {
    /* 隐私模式/配额满：忽略，仍返回夹过的值 */
  }
  return next;
}

/** 键盘/按钮微调：direction=left 表示「往左拉宽」。 */
export function nudgePanelWidth(
  current: unknown,
  direction: 'left' | 'right',
  large = false,
  viewportWidth?: number,
): number {
  const base = clampPanelWidth(current, viewportWidth);
  const step = large ? PANEL_WIDTH_STEP_LARGE : PANEL_WIDTH_STEP;
  return clampPanelWidth(direction === 'left' ? base + step : base - step, viewportWidth);
}

/**
 * 拖动换算：分隔条在左边缘。
 * dx = 指针相对按下点的水平位移（向右为正）→ 面板由右对齐，**右移变窄**。
 */
export function widthFromDrag(startWidth: unknown, dx: unknown, viewportWidth?: number): number {
  const start = clampPanelWidth(startWidth, viewportWidth);
  const delta = typeof dx === 'number' && Number.isFinite(dx) ? dx : 0;
  return clampPanelWidth(start - delta, viewportWidth);
}
