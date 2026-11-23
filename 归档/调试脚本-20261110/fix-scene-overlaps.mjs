import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..', 'workbench');
const SCENARIOS = path.join(WB, '外壳', 'scenarios');

const DEFAULT_COLS = 4;

// ═══════════════════════════════════════════════════════════════
//  修复重叠：重新排版有问题的场景
// ═══════════════════════════════════════════════════════════════

function computeLayout(scene) {
  const panels = (scene.panels || []).slice();
  const cols = Math.max(1, Number(scene.cols || DEFAULT_COLS));
  const cells = [];
  const grid = [];
  const conflicts = [];
  let maxCol = cols, maxRow = 0;
  const pending = [];

  function ensure(r, c) {
    while (grid.length <= r) grid.push(new Array(Math.max(maxCol, c + 1)).fill(null));
    for (let i = 0; i < grid.length; i++) while (grid[i].length <= c) grid[i].push(null);
  }
  function free(r, c, w, h) {
    for (let i = r; i < r + h; i++) for (let j = c; j < c + w; j++) if (grid[i] && grid[i][j]) return false;
    return true;
  }
  function mark(r, c, w, h, id) {
    for (let i = r; i < r + h; i++) {
      ensure(i, c + w - 1);
      for (let j = c; j < c + w; j++) grid[i][j] = id;
    }
  }

  for (const p of panels) {
    const hasCol = p.col !== undefined && p.col !== null;
    const hasRow = p.row !== undefined && p.row !== null;
    if (!hasCol || !hasRow) { pending.push(p); continue; }

    const col = Math.max(1, Number(p.col)) - 1;
    const row = Math.max(1, Number(p.row)) - 1;
    const w = Math.max(1, Number(p.w) || 2);
    const h = Math.max(1, Number(p.h) || 2);

    if (col + w > cols) maxCol = Math.max(maxCol, col + w);
    ensure(row + h - 1, col + w - 1);
    if (!free(row, col, w, h)) {
      conflicts.push(p.id);
      pending.push(p);
      continue;
    }
    mark(row, col, w, h, p.id);
    cells.push({ id: p.id, col, row, w, h, panel: p });
    maxRow = Math.max(maxRow, row + h);
  }

  for (const p of pending) {
    const w = Math.min(maxCol, Math.max(1, Number(p.w) || 2));
    const h = Math.max(1, Number(p.h) || 2);
    let ok = false;
    for (let r = 0; r < 200 && !ok; r++) {
      for (let c = 0; c + w <= maxCol && !ok; c++) {
        ensure(r + h - 1, c + w - 1);
        if (free(r, c, w, h)) {
          mark(r, c, w, h, p.id);
          cells.push({ id: p.id, col: c, row: r, w, h, panel: p });
          maxRow = Math.max(maxRow, r + h);
          ok = true;
        }
      }
    }
  }

  return { cols: maxCol, rows: Math.max(1, maxRow), conflicts };
}

// ═══════════════════════════════════════════════════════════════
//  重新排版：按面板数量选版式，保持顺序
// ═══════════════════════════════════════════════════════════════
function relayout(scene) {
  const panels = scene.panels || [];
  const n = panels.length;
  if (n === 0) return { changed: false };

  const cols = Math.max(1, Number(scene.cols || DEFAULT_COLS));
  let coords = [];

  if (n === 1) {
    coords = [{ col: 1, row: 1, w: cols, h: 5 }];
  } else if (n === 2) {
    // 左右各半
    const w = Math.floor(cols / 2);
    coords = [
      { col: 1, row: 1, w, h: 5 },
      { col: 1 + w, row: 1, w: cols - w, h: 5 },
    ];
  } else if (n === 3) {
    // 上3下1 + 右下
    const w1 = Math.min(3, cols - 1);
    coords = [
      { col: 1, row: 1, w: w1, h: 3 },
      { col: 1 + w1, row: 1, w: Math.max(1, cols - w1), h: 3 },
      { col: 1, row: 4, w: cols, h: 2 },
    ];
  } else if (n === 4) {
    // 2×2
    const w = Math.floor(cols / 2);
    coords = [
      { col: 1, row: 1, w, h: 3 },
      { col: 1 + w, row: 1, w: cols - w, h: 3 },
      { col: 1, row: 4, w, h: 2 },
      { col: 1 + w, row: 4, w: cols - w, h: 2 },
    ];
  } else {
    // 4 列基准：前 4 个 2×2，其余堆底部
    const half = Math.floor(cols / 2);
    coords = [
      { col: 1, row: 1, w: half, h: 3 },
      { col: 1 + half, row: 1, w: cols - half, h: 3 },
      { col: 1, row: 4, w: half, h: 2 },
      { col: 1 + half, row: 4, w: cols - half, h: 2 },
    ];
    for (let i = 4; i < n; i++) {
      coords.push({ col: 1, row: 6 + (i - 4) * 2, w: cols, h: 2 });
    }
  }

  for (let i = 0; i < n; i++) {
    const c = coords[i] || { col: 1, row: 1 + i, w: cols, h: 2 };
    panels[i].col = c.col;
    panels[i].row = c.row;
    panels[i].w = c.w;
    panels[i].h = c.h;
  }
  return { changed: true, coords };
}

// ═══════════════════════════════════════════════════════════════
//  主流程
// ═══════════════════════════════════════════════════════════════
const files = fs.readdirSync(SCENARIOS).filter(f => f.endsWith('.json') && !f.startsWith('_'));

console.log('═══════════════════════════════════════════════════════════');
console.log('  修复场景布局重叠');
console.log('═══════════════════════════════════════════════════════════');
console.log();

let fixed = 0, ok = 0;

for (const f of files) {
  const fp = path.join(SCENARIOS, f);
  const id = f.replace('.json', '');
  let scene;
  try {
    scene = JSON.parse(fs.readFileSync(fp, 'utf8').replace(/\uFEFF/g, ''));
  } catch (e) {
    console.log('  ✗ ' + id + ': JSON 解析失败');
    continue;
  }
  if (!scene || !scene.id) continue;

  const lay = computeLayout(scene);
  if (lay.conflicts.length) {
    console.log('  ⚠ ' + id + ' 有重叠: ' + lay.conflicts.join(', '));
    const r = relayout(scene);
    if (r.changed) {
      fs.writeFileSync(fp, JSON.stringify(scene, null, 2), 'utf8');
      const recheck = computeLayout(scene);
      if (recheck.conflicts.length === 0) {
        console.log('    ✓ 已重排，' + recheck.cols + '列×' + recheck.rows + '行，无重叠');
        fixed++;
      } else {
        console.log('    ✗ 重排后仍有重叠');
      }
    }
  } else {
    ok++;
  }
}

console.log();
console.log('═══════════════════════════════════════════════════════════');
console.log('  正常 ' + ok + ' 个，修复 ' + fixed + ' 个');
console.log('═══════════════════════════════════════════════════════════');
