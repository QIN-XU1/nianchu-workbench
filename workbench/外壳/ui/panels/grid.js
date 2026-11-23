// ui/panels/grid.js —— 网格布局引擎（对齐 luanyujia 原设计）
//
// ══════════════════════════════════════════════════════════════════════════
//  原项目设计（research/repos/luanyujia-full/01-场景模式/布局与网格.md）
// ══════════════════════════════════════════════════════════════════════════
//
//  一句话：**列数是可配的，行是等分的。**
//
//  ┌──────────────────────────────────────────────────────────┐
//  │  默认 4 列，列宽等分；行高也等分（grid-auto-rows: minmax(0,1fr)）│
//  │  面板之间固定间隙，面板内容自己滚动，整页不滚                 │
//  │  每个面板 = 网格项：                                        │
//  │    grid-column: <col> / span <w>                          │
//  │    grid-row:    <row> / span <h>                          │
//  └──────────────────────────────────────────────────────────┘
//
//  四个数字：
//    col  起始列，从 1 开始
//    row  起始行，从 1 开始
//    w    跨几列，默认 2
//    h    跨几行，默认 2
//
//  ⚠ 坐标是「起点 + 跨度」，不是终点。
//     col:4 w:1 才是最后一列；col:4 w:2 会伸到第 5 列（越界）
//
//  三条规则：
//    ① 只写 w/h 不写 col/row → 进自动流
//    ② 整份 json 一个坐标都不写 → 全自动排版，补洞拉伸填满
//    ③ 写了起点 → 落在该格，向右跨 w、向下跨 h
//
// ──────────────────────────────────────────────────────────────────────────
//  本文件实现
// ──────────────────────────────────────────────────────────────────────────
//   · 读 scene.cols（默认 4）
//   · 按面板 col/row/w/h 精确摆放
//   · 越界检测 + 告警 + 自动按需要列数渲染
//   · 自动排版：不写坐标的面板按行优先补洞
//   · 面板 ▲ 展开到最高（占位格钉住版面 + 覆盖层）

const DEFAULT_COLS = 4;
const DEFAULT_W = 2;
const DEFAULT_H = 2;

/**
 * 计算网格布局
 * @param {object} scene 场景定义 { cols, panels }
 * @returns {object} { cols, rows, cells: [{ panel, col, row, w, h, auto }], warnings: [] }
 */
export function computeLayout(scene) {
  const panels = (Array.isArray(scene && scene.panels) ? scene.panels : []).slice();
  const declaredCols = Math.max(1, Number((scene && scene.cols) || DEFAULT_COLS));

  const warnings = [];
  const cells = [];
  const occupied = [];   // occupied[r][c] = true/false

  // ── 工具：确保网格足够大 ──
  function ensure(r, c) {
    while (occupied.length <= r) occupied.push([]);
    for (let i = 0; i < occupied.length; i++) {
      while (occupied[i].length <= c) occupied[i].push(false);
    }
  }

  function isFree(r, c, w, h) {
    for (let i = r; i < r + h; i++) {
      for (let j = c; j < c + w; j++) {
        if (occupied[i] && occupied[i][j]) return false;
      }
    }
    return true;
  }

  function mark(r, c, w, h, val) {
    for (let i = r; i < r + h; i++) {
      ensure(i, c + w - 1);
      for (let j = c; j < c + w; j++) {
        occupied[i][j] = val;
      }
    }
  }

  // ── 第一轮：有坐标的面板按坐标落位 ──
  for (const p of panels) {
    const hasCoord = (p.col !== undefined && p.col !== null) ||
                     (p.row !== undefined && p.row !== null);
    if (!hasCoord) { cells.push({ panel: p, pending: true }); continue; }

    // 坐标只写一半 → 告警并按自动流处理
    if ((p.col !== undefined) !== (p.row !== undefined)) {
      warnings.push('面板 "' + (p.id || p.title || '?') + '" 坐标只写了一半（col=' +
        p.col + ' row=' + p.row + '）→ 已按自动流处理');
      cells.push({ panel: p, pending: true });
      continue;
    }

    const col = Math.max(1, Number(p.col) || 1) - 1;   // 转 0-based
    const row = Math.max(1, Number(p.row) || 1) - 1;
    const w = Math.max(1, Number(p.w) || DEFAULT_W);
    const h = Math.max(1, Number(p.h) || DEFAULT_H);

    // 越界检测
    const needCols = col + w;
    if (needCols > declaredCols) {
      warnings.push('面板 "' + (p.id || p.title || '?') + '" 伸到第 ' + needCols +
        ' 列，超出声明的 cols=' + declaredCols + '（将按 ' + needCols + ' 列渲染）');
    }

    ensure(row + h - 1, col + w - 1);

    // 抢占检测：该格已被占？→ 找一个空位
    if (!isFree(row, col, w, h)) {
      warnings.push('面板 "' + (p.id || p.title || '?') + '" 的坐标 (' +
        (col + 1) + ',' + (row + 1) + ') 已被占用 → 改为自动补位');
      cells.push({ panel: p, pending: true });
      continue;
    }

    mark(row, col, w, h, true);
    cells.push({ panel: p, col, row, w, h, auto: false });
  }

  // ── 计算实际需要的列数（越界时扩大）──
  let actualCols = declaredCols;
  for (const c of cells) {
    if (c.pending) continue;
    actualCols = Math.max(actualCols, c.col + c.w);
  }
  for (const [i, l] of warnings.entries()) {
    if (!warnings[i].includes('超出声明的 cols')) continue;
  }

  // ── 第二轮：无坐标的面板自动补位（行优先扫描找空洞）──
  const pendingCells = cells.filter(c => c.pending);
  if (pendingCells.length) {
    // 按声明顺序补位
    for (const cell of pendingCells) {
      const p = cell.panel;
      const w = Math.max(1, Math.min(actualCols, Number(p.w) || DEFAULT_W));
      const h = Math.max(1, Number(p.h) || DEFAULT_H);

      let placed = false;
      // 行优先扫描
      for (let r = 0; r < 200 && !placed; r++) {
        for (let c = 0; c + w <= actualCols && !placed; c++) {
          ensure(r + h - 1, c + w - 1);
          if (isFree(r, c, w, h)) {
            mark(r, c, w, h, true);
            cell.col = c;
            cell.row = r;
            cell.w = w;
            cell.h = h;
            cell.auto = true;
            placed = true;
          }
        }
      }
      if (!placed) {
        // 实在放不下 → 追加到最底部
        let maxRow = 0;
        for (let i = 0; i < occupied.length; i++) if (occupied[i]) maxRow = i;
        const r = maxRow + 1;
        ensure(r + h - 1, w - 1);
        mark(r, 0, w, h, true);
        cell.col = 0; cell.row = r; cell.w = w; cell.h = h; cell.auto = true;
        warnings.push('面板 "' + (p.id || p.title || '?') + '" 无处可放 → 追加到最底部');
      }
    }
  }

  // ── 计算总行数 ──
  let rows = 1;
  for (const c of cells) {
    if (c.pending || c.row === undefined) continue;
    rows = Math.max(rows, c.row + c.h);
  }

  return {
    cols: actualCols,
    declaredCols,
    rows,
    cells: cells.filter(c => !c.pending).sort(function (a, b) {
      // 按 row 再 col 排序（渲染顺序 = 视觉顺序）
      if (a.row !== b.row) return a.row - b.row;
      return a.col - b.col;
    }),
    warnings,
  };
}

/**
 * 应用布局到网格容器
 * @param {HTMLElement} gridEl  网格容器
 * @param {object} layout       computeLayout 的返回值
 */
export function applyGrid(gridEl, layout) {
  if (!gridEl) return;
  gridEl.style.display = 'grid';
  gridEl.style.gap = 'var(--sp1, 4px)';
  gridEl.style.padding = 'var(--sp1, 4px)';
  // ⚠ 2026-11-13 修（行高没有下限，低分辨率下面板矮到不可用）
  //
  //   原值：minmax(0, 1fr) —— **下限是 0**
  //
  //   实测（ui-research 于 1366×768 量得）：
  //     · 每列只有 268px（低于 280px 可读下限）
  //     · 2 行面板只有 186px 高，内容区 160px
  //     · frontend-craft 的 AI 面板放不下 3 条消息
  //
  //   根因：minmax(0, 1fr) 高度不够时不会溢出，而是把面板压扁到任意小。
  //
  //   修法：给下限 280×180（「能放下一行消息 + 标题」的实测底线）。
  //        超出可视区就让它滚动，而不是继续压扁 ——
  //        压在 186px 高的面板不如滚动着看。
  gridEl.style.gridTemplateColumns = 'repeat(' + layout.cols + ', minmax(280px, 1fr))';
  gridEl.style.gridAutoRows = 'minmax(180px, 1fr)';
  gridEl.style.overflow = 'hidden';
  gridEl.dataset.cols = String(layout.cols);
  gridEl.dataset.rows = String(layout.rows);
}

/**
 * 应用单个面板的网格位置
 * @param {HTMLElement} el    面板容器
 * @param {object} cell       computeLayout 的 cell
 */
export function applyCell(el, cell) {
  if (!el || !cell) return;
  el.style.gridColumn = String(cell.col + 1) + ' / span ' + cell.w;
  el.style.gridRow = String(cell.row + 1) + ' / span ' + cell.h;
  el.dataset.gridCol = String(cell.col + 1);
  el.dataset.gridRow = String(cell.row + 1);
  el.dataset.gridW = String(cell.w);
  el.dataset.gridH = String(cell.h);
}

/**
 * 自动排版兜底：整份 json 无坐标时，按面板顺序均分
 * （只在 computeLayout 已处理的情况下补充极端情况）
 */
export function autoFlowFallback(panels, cols) {
  const c = Math.max(1, Number(cols) || DEFAULT_COLS);
  const out = [];
  let row = 0, col = 0;
  for (const p of panels) {
    const w = Math.max(1, Math.min(c, Number(p.w) || DEFAULT_W));
    const h = Math.max(1, Number(p.h) || DEFAULT_H);
    if (col + w > c) { col = 0; row += h; }
    out.push({ panel: p, col, row, w, h, auto: true });
    col += w;
  }
  return { cols: c, rows: row + 1, cells: out, warnings: [] };
}
