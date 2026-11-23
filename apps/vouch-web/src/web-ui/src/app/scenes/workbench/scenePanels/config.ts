/**
 * 场景内部布局 —— **格式与规则照搬 luanyujia-workbench**
 *
 * 出处：
 *   D:/refs/luanyujia/luanyujia-workbench-main/01-场景模式/场景配置格式.md
 *   D:/refs/luanyujia/luanyujia-workbench-main/01-场景模式/布局与网格.md
 *   D:/refs/luanyujia/luanyujia-workbench-main/06-场景实例/self-review.json
 *
 * 照搬的规则（逐条对应原文）：
 *   §1  一个场景 = 一份 JSON：`{ id, name, description?, cols?, panels[] }`
 *   §3  面板字段：`id` / `title` / `type` 必填；`sub` / `col` / `row` / `w` / `h` / `expand` 可选
 *   网格：默认 4 列，列宽等分；行高等分（`grid-auto-rows: minmax(0,1fr)`）
 *   坐标：`col` / `row` 从 1 开始，是**起点 + 跨度**，不是终点
 *   自动流：不写 `col`/`row` ⇒ 进入自动流（`grid-auto-flow: row dense` 补洞）
 *   越界：面板伸到声明列数之外时，**按实际需要的列数渲染并打印告警**（不画歪）
 *   ▲ 展开：把该面板临时撑到整个网格高度，**其它面板位置完全不动**
 *   未知类型：显示一行灰字「未知面板类型: xxx」，**不报错、不崩**
 */

export type PanelConfig = {
  id: string;
  title: string;
  type: string;
  sub?: string;
  col?: number;
  row?: number;
  w?: number;
  h?: number;
  expand?: boolean;
  /** 面板自定义字段：渲染器从 meta 里读 */
  [key: string]: unknown;
};

export type SceneConfig = {
  id: string;
  name: string;
  description?: string;
  cols?: number;
  panels: PanelConfig[];
  meta?: Record<string, unknown>;
};

export const DEFAULT_COLS = 4;
export const DEFAULT_W = 2;
export const DEFAULT_H = 2;

/** 照搬「越界」规则：算出这份配置**实际**需要的列数，并给出告警 */
export function resolveCols(cfg: SceneConfig): { cols: number; warnings: string[] } {
  const declared = cfg.cols ?? DEFAULT_COLS;
  const warnings: string[] = [];
  let needed = declared;
  for (const p of cfg.panels) {
    if (p.col == null || p.w == null) continue;
    const end = p.col + p.w - 1;
    if (end > declared) {
      needed = Math.max(needed, end);
      warnings.push(`面板 ${p.id} 伸到第 ${end} 列，超出声明的 cols=${declared}（已按 ${needed} 列渲染）`);
    }
  }
  return { cols: needed, warnings };
}

/** 生成 CSS Grid 定位（只对写了起点的面板生效；没写起点的交给自动流） */
export function gridStyleOf(p: PanelConfig): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (p.col != null) style.gridColumn = `${p.col} / span ${p.w ?? DEFAULT_W}`;
  else if (p.w != null) style.gridColumn = `span ${p.w}`;
  if (p.row != null) style.gridRow = `${p.row} / span ${p.h ?? DEFAULT_H}`;
  else if (p.h != null) style.gridRow = `span ${p.h}`;
  return style;
}
