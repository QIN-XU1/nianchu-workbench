/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  场景编辑器（Scene Editor）—— 让场景真正可自定义修改
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 用户要求：「场景必须是可以自定义修改的」
 *
 * 原项目设计（01-场景模式/场景配置格式.md）：
 *   「一个场景 = 一份 JSON。放进 scenarios/ 目录即被自动发现：
 *    不需要注册、不需要改主进程代码。」
 *   「加场景 = 丢一份 json：目录每次都重扫，不缓存列表。」
 *
 * 但手工改 JSON 有四个坑：
 *   ① 坐标写错（col:4 w:2 会伸到第 5 列）
 *   ② 面板重叠（两个面板抢同一格）
 *   ③ type 拼错（显示"未知面板类型"但不报错）
 *   ④ 文件名必须 = id（对不上就"场景不存在"）
 *
 * 本工具解决这四个坑：
 *   ① 校验：坐标越界、重叠、type 未注册、id/文件名不符
 *   ② 排版：一句话生成常用版式（上3下1 / 左右各半 / 2×2 / 主区+侧栏）
 *   ③ 增删：加面板 / 删面板 / 移动面板，自动重排
 *   ④ 预览：输出 ASCII 版式图，改完就能看到格子怎么摆
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  用法
 * ───────────────────────────────────────────────────────────────────────────
 *   # 校验某个场景的布局
 *   node 工具\scene-edit.mjs --check hub
 *
 *   # 校验全部场景
 *   node 工具\scene-edit.mjs --check-all
 *
 *   # 看图（ASCII 版式预览）
 *   node 工具\scene-edit.mjs --show hub
 *
 *   # 用预设版式重排（会保留面板，只改坐标）
 *   node 工具\scene-edit.mjs --layout hub --preset left-1-right-3
 *
 *   # 改列数（实现任意比例）
 *   node 工具\scene-edit.mjs --layout hub --cols 20
 *
 *   # 改单个面板
 *   node 工具\scene-edit.mjs --set hub --panel hub-neuron --col 1 --row 1 --w 3 --h 5
 *
 *   # 加一个面板
 *   node 工具\scene-edit.mjs --add hub --type harness --title "AI·中枢" --w 2 --h 5
 *
 *   # 删一个面板
 *   node 工具\scene-edit.mjs --remove hub --panel hub-neuron
 *
 *   # 列出可用面板类型
 *   node 工具\scene-edit.mjs --types
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const SCENARIOS = path.join(WB, '外壳', 'scenarios');
const CONTRACTS = path.join(WB, 'sceneboard', 'scenes');
const UI_DIR = path.join(WB, '外壳', 'ui', 'panels');

// ═══════════════════════════════════════════════════════════════
//  已注册的面板类型（从 ui/index.js 的 RENDERERS 读）
// ═══════════════════════════════════════════════════════════════
function loadRendererTypes() {
  const types = [];
  try {
    const idx = fs.readFileSync(path.join(WB, '外壳', 'ui', 'index.js'), 'utf8');
    // 找 RENDERERS 数组 - 兼容多种写法
    const m = idx.match(/RENDERERS\s*=\s*\[([\s\S]*?)\];/);
    if (m) {
      const re = /type:\s*['"]?([a-z][a-z0-9-]*)['"]?/g;
      let x;
      while ((x = re.exec(m[1]))) types.push(x[1]);
    }
    // 兜底：扫描 panels/ 目录的文件名
    if (!types.length) {
      for (const f of fs.readdirSync(UI_DIR)) {
        if (!f.endsWith('.js')) continue;
        const base = f.replace('.js', '');
        if (base.startsWith('_') || ['base', 'registry', 'grid', 'frame'].includes(base)) continue;
        types.push(base);
      }
    }
  } catch (e) { /* 忽略 */ }
  return types;
}

// ═══════════════════════════════════════════════════════════════
//  布局计算（与 ui/panels/grid.js 同逻辑，但用于 CLI 校验）
// ═══════════════════════════════════════════════════════════════
const DEFAULT_COLS = 4;

function computeLayout(scene) {
  const panels = (scene.panels || []).slice();
  const declaredCols = Math.max(1, Number(scene.cols || DEFAULT_COLS));
  const warnings = [];
  const cells = [];
  const grid = [];   // grid[r][c] = 面板 id 或 null
  let maxCol = declaredCols, maxRow = 0;

  function ensure(r, c) {
    while (grid.length <= r) grid.push(new Array(Math.max(maxCol, c + 1)).fill(null));
    for (let i = 0; i < grid.length; i++) {
      while (grid[i].length <= c) grid[i].push(null);
    }
  }
  function free(r, c, w, h) {
    for (let i = r; i < r + h; i++) {
      for (let j = c; j < c + w; j++) {
        if (grid[i] && grid[i][j]) return false;
      }
    }
    return true;
  }
  function mark(r, c, w, h, id) {
    for (let i = r; i < r + h; i++) {
      ensure(i, c + w - 1);
      for (let j = c; j < c + w; j++) grid[i][j] = id;
    }
  }

  // 有坐标的先放
  const pending = [];
  for (const p of panels) {
    const hasCol = p.col !== undefined && p.col !== null;
    const hasRow = p.row !== undefined && p.row !== null;
    if (!hasCol || !hasRow) { pending.push(p); continue; }

    const col = Math.max(1, Number(p.col)) - 1;
    const row = Math.max(1, Number(p.row)) - 1;
    const w = Math.max(1, Number(p.w) || 2);
    const h = Math.max(1, Number(p.h) || 2);

    if (col + w > declaredCols) {
      warnings.push('❌ 面板 "' + (p.id || '?') + '" 越界：col=' + (col + 1) +
        ' w=' + w + ' → 伸到第 ' + (col + w) + ' 列，超出 cols=' + declaredCols);
      maxCol = Math.max(maxCol, col + w);
    }
    ensure(row + h - 1, col + w - 1);
    if (!free(row, col, w, h)) {
      warnings.push('❌ 面板 "' + (p.id || '?') + '" 与其它面板重叠于 (' +
        (col + 1) + ',' + (row + 1) + ')');
      pending.push(p);
      continue;
    }
    mark(row, col, w, h, p.id);
    cells.push({ id: p.id, col, row, w, h, type: p.type, title: p.title, auto: false });
    maxRow = Math.max(maxRow, row + h);
  }

  // 无坐标的自动补位
  for (const p of pending) {
    const w = Math.min(maxCol, Math.max(1, Number(p.w) || 2));
    const h = Math.max(1, Number(p.h) || 2);
    let ok = false;
    for (let r = 0; r < 200 && !ok; r++) {
      for (let c = 0; c + w <= maxCol && !ok; c++) {
        ensure(r + h - 1, c + w - 1);
        if (free(r, c, w, h)) {
          mark(r, c, w, h, p.id);
          cells.push({ id: p.id, col: c, row: r, w, h, type: p.type, title: p.title, auto: true });
          maxRow = Math.max(maxRow, r + h);
          ok = true;
        }
      }
    }
    if (!ok) warnings.push('❌ 面板 "' + (p.id || '?') + '" 无处可放');
  }

  return { cols: maxCol, rows: Math.max(1, maxRow), cells, grid, warnings };
}

// ═══════════════════════════════════════════════════════════════
//  ASCII 版式预览
// ═══════════════════════════════════════════════════════════════
function renderAscii(layout, scene) {
  const { cols, rows, grid } = layout;
  const CW = 14;   // 每格字符宽
  const CH = 3;    // 每格字符高

  // ── 建立「左上角」标记：面板只在自己的起始格画名字 ──
  const origin = {};   // "r,c" -> panel id
  const cover = {};    // "r,c" -> panel id（所有被覆盖的格）
  for (const cell of layout.cells) {
    origin[cell.row + ',' + cell.col] = cell.id;
    for (let i = cell.row; i < cell.row + cell.h; i++) {
      for (let j = cell.col; j < cell.col + cell.w; j++) {
        cover[i + ',' + j] = cell.id;
      }
    }
  }

  const byId = {};
  for (const c of layout.cells) byId[c.id] = c;

  const lines = [];

  // 列号标尺
  let ruler = '       ';
  for (let c = 0; c < cols; c++) {
    ruler += String(c + 1).padEnd(CW + 1);
  }
  lines.push(ruler);

  for (let r = 0; r < rows; r++) {
    // 顶边
    let top = '       ';
    for (let c = 0; c < cols; c++) {
      const id = cover[r + ',' + c];
      const isTop = id && origin[r + ',' + c];
      top += (id ? (isTop ? '┌' : '├') : '┌') + '─'.repeat(CW);
    }
    lines.push(top);

    // 内容
    for (let k = 0; k < CH; k++) {
      let rowStr = (k === 0 ? String(r + 1).padEnd(4) : '    ') + '   ';
      for (let c = 0; c < cols; c++) {
        const id = cover[r + ',' + c];
        const cell = id ? byId[id] : null;
        const isOrigin = origin[r + ',' + c];

        let text = '';
        if (k === 0) {
          if (isOrigin && cell) {
            // 只在左上角写面板 id
            text = '#' + cell.id;
            if (text.length > CW - 1) text = text.slice(0, CW - 2) + '…';
          } else if (id) {
            // 跨格延续：省略
            text = '';
          }
        } else if (k === 1) {
          if (isOrigin && cell) {
            text = cell.w + '×' + cell.h;
            if (cell.type) text += ' ' + cell.type;
            if (text.length > CW - 1) text = text.slice(0, CW - 2) + '…';
          }
        } else {
          text = '';
        }

        rowStr += '│' + text.padEnd(CW);
      }
      lines.push(rowStr);
    }

    // 底边
    let bot = '       ';
    for (let c = 0; c < cols; c++) {
      const id = cover[r + ',' + c];
      const cell = id ? byId[id] : null;
      const isBottom = cell && (cell.row + cell.h - 1 === r);
      bot += (isBottom ? '└' : '│') + '─'.repeat(CW);
    }
    lines.push(bot);
  }
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
//  预设版式
// ═══════════════════════════════════════════════════════════════
const PRESETS = {
  'single': (n) => [{ col: 1, row: 1, w: 4, h: 5 }],
  'left-right-half': (n) => [
    { col: 1, row: 1, w: 2, h: 5 },
    { col: 3, row: 1, w: 2, h: 5 },
  ],
  'left-1-right-3': (n) => [
    { col: 1, row: 1, w: 1, h: 5 },
    { col: 2, row: 1, w: 3, h: 5 },
  ],
  'top-3-bottom-1': (n) => [
    { col: 1, row: 1, w: 3, h: 3 },
    { col: 4, row: 1, w: 1, h: 3 },
    { col: 1, row: 4, w: 4, h: 2 },
  ],
  'grid-2x2': (n) => [
    { col: 1, row: 1, w: 2, h: 3 },
    { col: 3, row: 1, w: 2, h: 3 },
    { col: 1, row: 4, w: 2, h: 2 },
    { col: 3, row: 4, w: 2, h: 2 },
  ],
  'main-side-toolbar': (n) => [
    { col: 1, row: 1, w: 3, h: 4 },
    { col: 4, row: 1, w: 1, h: 4 },
    { col: 1, row: 5, w: 4, h: 1 },
  ],
  'stack': (n) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ col: 1, row: i + 1, w: 4, h: 1 });
    return out;
  },
  'neuron-only': (n) => [{ col: 1, row: 1, w: 4, h: 5 }],
};

// ═══════════════════════════════════════════════════════════════
//  读写
// ═══════════════════════════════════════════════════════════════
function loadScene(id) {
  const f = path.join(SCENARIOS, String(id) + '.json');
  if (!fs.existsSync(f)) throw new Error('场景不存在: ' + id + '（找 ' + f + '）');
  return { path: f, data: JSON.parse(fs.readFileSync(f, 'utf8').replace(/\uFEFF/g, '')) };
}

function saveScene(f, data) {
  fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8');
}

// ═══════════════════════════════════════════════════════════════
//  CLI
// ═══════════════════════════════════════════════════════════════
const argv = process.argv.slice(2);
function arg(n) {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
}
function has(n) { return argv.includes('--' + n); }

function doCheck(id) {
  const { data: scene } = loadScene(id);
  const layout = computeLayout(scene);
  const types = loadRendererTypes();

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  场景校验: ' + scene.name + ' (' + scene.id + ')');
  console.log('═══════════════════════════════════════════════════════════');
  console.log();
  console.log('  列数: ' + (scene.cols || DEFAULT_COLS) + '（' + (scene.cols ? '已配置' : '默认') + '）');
  console.log('  面板: ' + (scene.panels || []).length + ' 个，占 ' + layout.cols + ' 列 × ' + layout.rows + ' 行');
  console.log();

  // 文件名 = id 校验
  const fname = path.basename(loadScene(id).path, '.json');
  if (fname !== scene.id) {
    console.log('  ❌ 文件名(' + fname + ') ≠ id(' + scene.id + ') —— 会"场景不存在"');
  } else {
    console.log('  ✓ 文件名 = id');
  }

  // type 校验
  let typeOk = true;
  for (const p of (scene.panels || [])) {
    if (!types.includes(p.type)) {
      console.log('  ❌ 面板 "' + (p.id || '?') + '" 的 type="' + p.type + '" 未注册（会显示未知面板类型）');
      typeOk = false;
    }
  }
  if (typeOk) console.log('  ✓ 所有面板 type 已注册');

  // 布局告警
  if (layout.warnings.length) {
    for (const w of layout.warnings) console.log('  ' + w);
  } else {
    console.log('  ✓ 无越界 / 无重叠');
  }

  console.log();
  console.log(renderAscii(layout, scene));
  console.log();

  const ok = typeOk && layout.warnings.length === 0 && fname === scene.id;
  console.log(ok ? '  ✅ 校验通过' : '  ⚠ 有 ' + (layout.warnings.length + (typeOk ? 0 : 1)) + ' 个问题');
  return ok;
}

function doShow(id) {
  const { data: scene } = loadScene(id);
  const layout = computeLayout(scene);
  console.log(renderAscii(layout, scene));
}

function doTypes() {
  const types = loadRendererTypes();
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  已注册面板类型（' + types.length + ' 种）');
  console.log('═══════════════════════════════════════════════════════════');
  console.log();
  for (const t of types) console.log('  · ' + t);
  console.log();
  console.log('  在场景 json 的 panels 里写 {"type": "<上面某个>"} 即可用');
}

function doLayout(id) {
  const { path: f, data: scene } = loadScene(id);
  const preset = arg('preset');
  const colsArg = arg('cols');

  if (colsArg) {
    scene.cols = Math.max(1, Number(colsArg));
    console.log('  列数改为 ' + scene.cols);
  }

  if (preset) {
    if (!PRESETS[preset]) {
      throw new Error('未知预设: ' + preset + '。可用: ' + Object.keys(PRESETS).join(', '));
    }
    const coords = PRESETS[preset]((scene.panels || []).length);
    const panels = scene.panels || [];
    for (let i = 0; i < panels.length && i < coords.length; i++) {
      panels[i].col = coords[i].col;
      panels[i].row = coords[i].row;
      panels[i].w = coords[i].w;
      panels[i].h = coords[i].h;
    }
    // 多余面板给默认坐标
    for (let i = coords.length; i < panels.length; i++) {
      panels[i].col = undefined;
      panels[i].row = undefined;
    }
    console.log('  已应用版式: ' + preset + '（' + Math.min(panels.length, coords.length) + ' 个面板定位）');
  }

  saveScene(f, scene);
  console.log('  ✓ 已保存');
  doCheck(id);
}

function doSet(id) {
  const { path: f, data: scene } = loadScene(id);
  const panelId = arg('panel');
  if (!panelId) throw new Error('缺少 --panel <面板id>');
  const p = (scene.panels || []).find(x => x.id === panelId);
  if (!p) throw new Error('找不到面板: ' + panelId);

  for (const k of ['col', 'row', 'w', 'h']) {
    const v = arg(k);
    if (v) p[k] = Number(v);
  }
  const title = arg('title');
  if (title) p.title = title;
  const sub = arg('sub');
  if (sub) p.sub = sub;

  saveScene(f, scene);
  console.log('  ✓ 面板 ' + panelId + ' 已更新: ' +
    JSON.stringify({ col: p.col, row: p.row, w: p.w, h: p.h }));
  doCheck(id);
}

function doAdd(id) {
  const { path: f, data: scene } = loadScene(id);
  const type = arg('type');
  if (!type) throw new Error('缺少 --type');
  const types = loadRendererTypes();
  if (!types.includes(type)) {
    throw new Error('type="' + type + '" 未注册。可用: ' + types.join(', '));
  }

  const prefix = String(id).replace(/[^a-z]/g, '').slice(0, 2) || 'p';
  const panel = {
    id: String(arg('id') || (prefix + '-' + type + '-' + ((scene.panels || []).length + 1))),
    title: arg('title') || type,
    type,
    w: Number(arg('w') || 2),
    h: Number(arg('h') || 5),
  };
  // 不写 col/row → 自动补位
  if (arg('col')) panel.col = Number(arg('col'));
  if (arg('row')) panel.row = Number(arg('row'));

  scene.panels = scene.panels || [];
  scene.panels.push(panel);
  saveScene(f, scene);
  console.log('  ✓ 已添加面板 ' + panel.id + ' (type=' + type + ', ' + panel.w + '×' + panel.h + ')');
  doCheck(id);
}

function doRemove(id) {
  const { path: f, data: scene } = loadScene(id);
  const panelId = arg('panel');
  if (!panelId) throw new Error('缺少 --panel <面板id>');
  const before = (scene.panels || []).length;
  scene.panels = (scene.panels || []).filter(x => x.id !== panelId);
  if (scene.panels.length === before) throw new Error('找不到面板: ' + panelId);
  saveScene(f, scene);
  console.log('  ✓ 已删除面板 ' + panelId + '（剩 ' + scene.panels.length + ' 个）');
  doCheck(id);
}

function doCheckAll() {
  const files = fs.readdirSync(SCENARIOS).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  let bad = 0;
  for (const f of files) {
    const id = f.replace('.json', '');
    try {
      const ok = doCheck(id);
      if (!ok) bad++;
    } catch (e) {
      console.log('  ❌ ' + id + ': ' + e.message);
      bad++;
    }
    console.log();
  }
  console.log('检查 ' + files.length + ' 个场景，' + (bad ? bad + ' 个有问题' : '全部通过'));
  process.exitCode = bad ? 1 : 0;
}

(function main() {
  try {
    if (has('types')) { doTypes(); return; }

    const checkOne = arg('check');
    if (checkOne) { doCheck(checkOne); return; }

    if (has('check-all')) { doCheckAll(); return; }

    const showOne = arg('show');
    if (showOne) { doShow(showOne); return; }

    const layoutOne = arg('layout');
    if (layoutOne) { doLayout(layoutOne); return; }

    const setOne = arg('set');
    if (setOne) { doSet(setOne); return; }

    const addOne = arg('add');
    if (addOne) { doAdd(addOne); return; }

    const rmOne = arg('remove');
    if (rmOne) { doRemove(rmOne); return; }

    console.log('用法:');
    console.log('  node 工具\\scene-edit.mjs --types              列出面板类型');
    console.log('  node 工具\\scene-edit.mjs --check <id>          校验场景布局');
    console.log('  node 工具\\scene-edit.mjs --check-all          校验全部');
    console.log('  node 工具\\scene-edit.mjs --show <id>           看 ASCII 版式图');
    console.log('  node 工具\\scene-edit.mjs --layout <id> --preset <版式>');
    console.log('  node 工具\\scene-edit.mjs --layout <id> --cols 20');
    console.log('  node 工具\\scene-edit.mjs --set <id> --panel <pid> --col N --row N --w N --h N');
    console.log('  node 工具\\scene-edit.mjs --add <id> --type <t> --title <名字> --w N --h N');
    console.log('  node 工具\\scene-edit.mjs --remove <id> --panel <pid>');
    console.log();
    console.log('可用版式: ' + Object.keys(PRESETS).join(', '));
  } catch (e) {
    console.error('✗ ' + (e && e.message || e));
    process.exitCode = 1;
  }
})();
