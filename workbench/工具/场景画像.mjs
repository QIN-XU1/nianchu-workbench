#!/usr/bin/env node
/**
 * 场景画像 —— 让 AI 知道自己「长什么样」
 *
 * ══════════════════════════════════════════════════════════════
 *  设计依据（视频 BV1o4xg6RE9m「神经中枢控制电脑」）
 * ══════════════════════════════════════════════════════════════
 *
 *  > [10:46] 「场景画像就是每一个场景，它知道自己的场景长怎么样。
 *  >   比如说这个个人站场景，它知道自己的这个窗口是长什么样子——
 *  >   它这边有个官网预览，这边有个本地窗口，
 *  >   然后这边有个项目管理、有个我的网址，
 *  >   然后底下是它的聊天窗。
 *  >   **他知道自己这个长什么样子，他就可以掌控全局。**
 *  >   然后这个时候他就想修改什么地方就可以随意修改——
 *  >   我想在哪里加个小按钮，或者在哪里想要加一个炫酷的这种光效条，
 *  >   或者是加一个什么东西都是非常的方便。」
 *
 *  > [BV1mz4v62ECW 01:29] 「场景画像，他就是平常在码汉到他的这个脑子里的，
 *  >   他就知道他这个场景怎么分布了，对不对？这需要什么套份（token）？」
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么这个最重要
 * ══════════════════════════════════════════════════════════════
 *
 *  我们现在的 AI 不知道自己有哪些面板、布局是什么样、能操作什么。
 *  所以用户说「把那个预览窗改大点」时，AI 只能猜或者问。
 *
 *  有了画像：
 *    · AI 知道自己的面板清单、位置、大小、类型
 *    · AI 知道哪些面板能改、哪些是固定的
 *    · AI 能直接说「把 ar-web 从 1x2 改成 2x2」
 *
 * ══════════════════════════════════════════════════════════════
 *  画像内容（从场景配置生成，不是手写）
 * ══════════════════════════════════════════════════════════════
 *
 *  布局网格 / 面板清单（id·标题·类型·位置·尺寸）/ 首屏面板 /
 *  可改与不可改 / 对应的配置文件路径
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/场景画像.mjs --build            生成所有场景画像
 *  node 工具/场景画像.mjs --build --apply    写入文件
 *  node 工具/场景画像.mjs --show 架构梳理     看某场景画像
 *  node 工具/场景画像.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');
const MEM_ROOT = path.join(WB, '数据', '.dsh', '场景记忆');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// ══════════════════════════════════════════════════════════════
//  面板类型的可读说明
// ══════════════════════════════════════════════════════════════
export const PANEL_TYPES = {
  'sf-board': { name: '管线看板', canEdit: true, desc: '显示上下游关系的流程图' },
  'review-doc': { name: '文档视图', canEdit: true, desc: '渲染 Markdown 文档' },
  'embed': { name: '内嵌网页', canEdit: true, desc: '嵌入外部网页（可配 URL）' },
  'harness': { name: 'AI 对话', canEdit: false, desc: '与 AI 对话的窗口（核心，不可删）' },
  'drives': { name: '磁盘列表', canEdit: true, desc: '显示分区与容量' },
  'toplarge': { name: '大文件榜', canEdit: true, desc: '按体积排序的文件清单' },
  'junk': { name: '垃圾项', canEdit: true, desc: '可清理项列表' },
  'pc-log': { name: '清理台账', canEdit: true, desc: '历史清理记录' },
  'file-tree': { name: '文件树', canEdit: true, desc: '浏览目录结构' },
  'preview': { name: '预览窗', canEdit: true, desc: '预览文件内容（图片/视频/文本）' },
  'crash-table': { name: '崩溃表', canEdit: true, desc: '崩溃记录表格' },
  'chart': { name: '图表', canEdit: true, desc: '数据图表' },
  'list': { name: '列表', canEdit: true, desc: '通用列表' },
};

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}
function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  从场景配置生成画像
// ══════════════════════════════════════════════════════════════
export function buildPortrait(sceneJson) {
  const j = sceneJson || {};
  const panels = Array.isArray(j.panels) ? j.panels : [];

  // ── 布局网格 ──
  let maxCol = 1;
  let maxRow = 1;
  for (const p of panels) {
    maxCol = Math.max(maxCol, (p.col || 1) + (p.w || 1) - 1);
    maxRow = Math.max(maxRow, (p.row || 1) + (p.h || 1) - 1);
  }

  // ── 面板清单 ──
  const panelList = panels.map((p, i) => {
    const typeInfo = PANEL_TYPES[p.type] || { name: p.type || '未知', canEdit: true, desc: '' };
    return {
      index: i + 1,
      id: p.id || '',
      title: p.title || '',
      sub: p.sub || '',
      type: p.type || '',
      typeName: typeInfo.name,
      typeDesc: typeInfo.desc,
      canEdit: typeInfo.canEdit,
      col: p.col || 1,
      row: p.row || 1,
      w: p.w || 1,
      h: p.h || 1,
      // 额外属性
      url: p.url || null,
      extra: Object.keys(p).filter((k) =>
        !['id', 'title', 'sub', 'type', 'col', 'row', 'w', 'h'].includes(k)).reduce((a, k) => {
        a[k] = p[k];
        return a;
      }, {}),
    };
  });

  return {
    id: j.id || '',
    name: j.name || '',
    description: j.description || '',
    layout: j.layout || 'grid',
    theme: j.theme || 'dark',
    grid: { cols: maxCol, rows: maxRow },
    panelCount: panelList.length,
    panels: panelList,
    first: j.first || (panelList[0] ? panelList[0].id : ''),
    configPath: '外壳/scenarios/' + (j.id || '') + '.json',
  };
}

// ══════════════════════════════════════════════════════════════
//  生成给 AI 读的画像文本（Markdown）
// ══════════════════════════════════════════════════════════════
export function renderPortrait(portrait) {
  const p = portrait;
  const L = [];

  L.push('# 我的场景画像（' + p.name + '）');
  L.push('');
  L.push('> 这份画像由 `工具/场景画像.mjs` 从场景配置自动生成，**不要手改**。');
  L.push('> 它告诉你：你自己的界面长什么样、有哪些面板、哪些能改。');
  L.push('>');
  L.push('> 依据：视频 BV1o4xg6RE9m');
  L.push('> 「场景画像就是每一个场景，它知道自己的场景长怎么样……');
  L.push('>  他知道自己这个长什么样子，他就可以掌控全局。」');
  L.push('');
  L.push('## 我是什么');
  L.push('');
  L.push('- 场景 id：`' + p.id + '`');
  L.push('- 场景名：' + p.name);
  L.push('- 职责：' + (p.description || '（未定义）'));
  L.push('- 配置文件：`' + p.configPath + '`');
  L.push('');
  L.push('## 我的布局');
  L.push('');
  L.push('布局类型：`' + p.layout + '`　主题：`' + p.theme + '`');
  L.push('');
  L.push('网格：**' + p.grid.cols + ' 列 × ' + p.grid.rows + ' 行**');
  L.push('');
  L.push('```');
  // 简单的 ASCII 网格图
  const cellW = 12;
  for (let r = 1; r <= p.grid.rows; r++) {
    let line = '';
    for (let c = 1; c <= p.grid.cols; c++) {
      // 找占据这个格子的面板
      const hit = p.panels.find((x) =>
        c >= x.col && c < x.col + x.w && r >= x.row && r < x.row + x.h);
      const tag = hit ? hit.id.slice(0, cellW - 1) : '';
      line += '|' + tag.padEnd(cellW);
    }
    L.push(line + '|');
    if (r < p.grid.rows) {
      let sep = '';
      for (let c = 1; c <= p.grid.cols; c++) sep += '+' + '-'.repeat(cellW);
      L.push(sep + '+');
    }
  }
  L.push('```');
  L.push('');
  L.push('## 我的面板（' + p.panelCount + ' 个）');
  L.push('');
  L.push('| # | id | 标题 | 类型 | 位置 | 尺寸 | 能改 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const x of p.panels) {
    L.push('| ' + x.index + ' | `' + x.id + '` | ' + x.title +
      ' | ' + x.typeName + ' | ' + x.col + ',' + x.row +
      ' | ' + x.w + '×' + x.h +
      ' | ' + (x.canEdit ? '✓' : '🔒 固定') + ' |');
  }
  L.push('');
  L.push('### 每个面板做什么');
  L.push('');
  for (const x of p.panels) {
    L.push('- **`' + x.id + '`**（' + x.title + '）— ' + x.typeName +
      (x.typeDesc ? '：' + x.typeDesc : ''));
    if (x.sub) L.push('  - 副标题：' + x.sub);
    if (x.url) L.push('  - 内嵌地址：`' + x.url + '`');
    if (!x.canEdit) L.push('  - 🔒 **固定面板，不要删也不要移**');
  }
  L.push('');
  L.push('## 我能怎么改自己');
  L.push('');
  L.push('改自己 = 改 `' + p.configPath + '` 里的 `panels` 数组。');
  L.push('');
  L.push('**能改的**：');
  L.push('');
  L.push('- 加面板：往 `panels` 里加一项 `{id, title, type, col, row, w, h}`');
  L.push('- 删面板：删掉对应项（**但 `' + p.first + '` 和 harness 类型不能删**）');
  L.push('- 改位置：改 `col` / `row`');
  L.push('- 改尺寸：改 `w` / `h`');
  L.push('- 改标题：改 `title` / `sub`');
  L.push('- 内嵌网页：改 `url`（type 为 embed 时）');
  L.push('');
  L.push('**不能改的**：');
  L.push('');
  L.push('- `id` 已被其他地方引用时，改名要同步改引用');
  L.push('- 删掉 `harness` 类型面板 = 删掉自己和用户对话的能力');
  L.push('- 改完必须重启工作台才生效');
  L.push('');
  L.push('## 改之前先存快照');
  L.push('');
  L.push('```bash');
  L.push('node 工具/回滚.mjs --snapshot --type ui');
  L.push('# 改坏了就退回：');
  L.push('node 工具/回滚.mjs --rollback <快照id>');
  L.push('```');
  L.push('');

  return L.join('\n');
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  场景画像 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 面板类型表
  chk('有面板类型表', Object.keys(PANEL_TYPES).length > 0, Object.keys(PANEL_TYPES).length + ' 种');
  chk('harness 标为不可改', PANEL_TYPES.harness.canEdit === false, '');
  chk('embed 标为可改', PANEL_TYPES.embed.canEdit === true, '');

  // ② 从配置生成画像
  const scene = {
    id: 'test-scene',
    name: '测试场景',
    description: '这是测试用的场景',
    layout: 'grid',
    theme: 'dark',
    panels: [
      { id: 'p1', title: '面板一', type: 'sf-board', col: 1, row: 1, w: 1, h: 1 },
      { id: 'p2', title: '面板二', type: 'harness', col: 2, row: 1, w: 2, h: 2 },
    ],
    first: 'p1',
  };
  const pt = buildPortrait(scene);
  chk('生成画像', pt.id === 'test-scene', pt.id);
  chk('面板数正确', pt.panelCount === 2, pt.panelCount + '');
  chk('网格算对', pt.grid.cols === 3 && pt.grid.rows === 2, pt.grid.cols + 'x' + pt.grid.rows);
  chk('首屏面板', pt.first === 'p1', pt.first);
  chk('标出可改性', pt.panels[1].canEdit === false, 'p2 canEdit=' + pt.panels[1].canEdit);

  // ③ 渲染画像
  const md = renderPortrait(pt);
  chk('渲染出内容', md.length > 500, md.length + ' 字符');
  chk('含场景名', md.includes('测试场景'), '');
  chk('含面板清单', md.includes('`p1`') && md.includes('`p2`'), '');
  chk('含网格图', md.includes('```'), '');
  chk('标明不能删的', md.includes('固定面板'), '');
  chk('含改法说明', md.includes('改自己 = 改'), '');
  chk('含回滚提示', md.includes('回滚'), '');
  chk('含依据出处', md.includes('BV1o4xg6RE9m'), '');

  // ④ 反例：空场景不崩
  const empty = buildPortrait({});
  chk('反例：空场景不崩', empty.panelCount === 0, '');
  const emptyMd = renderPortrait(empty);
  chk('反例：空场景能渲染', emptyMd.length > 100, emptyMd.length + ' 字符');

  // ⑤ 反例：未知面板类型不崩
  const unknown = buildPortrait({
    id: 'x', name: 'X',
    panels: [{ id: 'u1', title: '未知', type: 'never-seen-type', col: 1, row: 1, w: 1, h: 1 }],
  });
  chk('反例：未知类型不崩', unknown.panels[0].typeName === 'never-seen-type',
      unknown.panels[0].typeName);

  // ⑥ 关键：画像必须包含「AI 能自己改」的信息
  chk('关键：画像告诉 AI 怎么改自己',
      md.includes('改自己 = 改') && md.includes('能改的') && md.includes('不能改的'),
      '这是画像存在的唯一理由');

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
//  真实检查（--check）
//
//  ⚠ 2026-11-12 新增。此前只有 --selftest（用构造的 scene json 跑），
//    从来没检查过「9 个真实场景的画像文件是否存在、是否是当前配置生成的」。
//
//  判据（对每个有 .json 配置的场景）：
//    ① 场景记忆目录下必须有 `场景画像.md`
//       —— 没有画像 = AI 不知道自己界面长什么样 = 这个机制对该场景不存在
//    ② 画像内容必须与**当前场景配置**一致（重新生成一次，逐字比对）
//       —— 不一致 = 配置改了但画像没重建，AI 拿到的是过期界面描述
//          （这是最危险的一种：看起来有画像，其实描述的是旧界面）
//    ③ 画像必须含关键锚点（配置路径 / 面板清单），否则是空壳
// ══════════════════════════════════════════════════════════════
export function checkReal() {
  const problems = [];
  const rows = [];
  if (!fs.existsSync(SCEN_DIR)) {
    return { ok: false, checked: 0, rows, problems: ['场景目录不存在: ' + SCEN_DIR] };
  }

  const sceneFiles = fs.readdirSync(SCEN_DIR).filter((f) => f.endsWith('.json'));

  for (const f of sceneFiles) {
    const j = readJsonSafe(path.join(SCEN_DIR, f));
    if (!j || !j.id) continue;

    const pt = buildPortrait(j);
    const expected = renderPortrait(pt);
    const target = path.join(MEM_ROOT, pt.name, '场景画像.md');

    if (!fs.existsSync(target)) {
      problems.push(pt.name + '：没有 场景画像.md（AI 不知道自己界面长什么样）');
      rows.push({ scene: pt.name, exists: false, stale: false, panels: pt.panelCount });
      continue;
    }

    const actual = readTextSafe(target);
    const norm = (s) => String(s || '').replace(/\r\n/g, '\n').trim();
    const stale = norm(actual) !== norm(expected);

    if (stale) {
      // 找出第一处差异，便于定位
      const a = norm(actual).split('\n');
      const e = norm(expected).split('\n');
      let diffAt = -1;
      for (let i = 0; i < Math.max(a.length, e.length); i++) {
        if (a[i] !== e[i]) { diffAt = i; break; }
      }
      problems.push(pt.name + '：画像与当前配置不一致（过期画像）—— 第 ' +
        (diffAt + 1) + ' 行起不同；应跑 `node 工具/场景画像.mjs --build --apply`');
    }

    // ③ 关键锚点
    if (actual && !/外壳\/scenarios\//.test(actual)) {
      problems.push(pt.name + '：画像里没有配置文件路径锚点（空壳）');
    }
    if (actual && pt.panelCount > 0 && !/面板/.test(actual)) {
      problems.push(pt.name + '：画像里没有面板清单（空壳）');
    }

    rows.push({
      scene: pt.name,
      exists: true,
      stale,
      panels: pt.panelCount,
      bytes: Buffer.byteLength(actual || '', 'utf8'),
    });
  }

  return { ok: problems.length === 0, checked: rows.length, rows, problems };
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  // ── 真实检查 ──
  if (has('--check')) {
    const r = checkReal();
    console.log('═'.repeat(76));
    console.log('  场景画像 · 真实检查（画像是否存在、是否与当前配置一致）');
    console.log('═'.repeat(76));
    console.log();
    console.log('  ' + '场景'.padEnd(12) + '画像'.padEnd(8) + '面板'.padEnd(6) +
      '大小B'.padEnd(8) + '状态');
    console.log('  ' + '─'.repeat(66));
    for (const row of r.rows) {
      console.log('  ' + row.scene.padEnd(12) +
        (row.exists ? '有' : '无!').padEnd(8) +
        String(row.panels).padEnd(6) +
        String(row.bytes || 0).padEnd(8) +
        (row.exists ? (row.stale ? '✗ 过期（配置改了没重建）' : '✓ 与配置一致') : '✗ 缺失'));
    }
    console.log('  ' + '─'.repeat(66));
    console.log('  检查了 ' + r.checked + ' 个场景');
    console.log();
    if (r.ok) {
      console.log('  ✓ 所有场景画像都存在且与当前配置一致');
    } else {
      console.log('  ✗ ' + r.problems.length + ' 个问题:');
      for (const p of r.problems.slice(0, 15)) console.log('    · ' + p);
    }
    console.log('═'.repeat(76));
    process.exit(r.ok ? 0 : 1);
  }

  const sceneFiles = fs.existsSync(SCEN_DIR)
    ? fs.readdirSync(SCEN_DIR).filter((f) => f.endsWith('.json'))
    : [];

  // ── 看某场景 ──
  if (has('--show')) {
    const want = val('--show');
    let found = null;
    for (const f of sceneFiles) {
      const j = readJsonSafe(path.join(SCEN_DIR, f));
      if (j && (j.id === want || j.name === want)) { found = j; break; }
    }
    if (!found) { console.error('找不到场景: ' + want); process.exit(2); }
    console.log(renderPortrait(buildPortrait(found)));
    process.exit(0);
  }

  // ── 生成 ──
  if (has('--build') || (!has('--show') && !has('--build'))) {
    console.log('═'.repeat(74));
    console.log('  生成场景画像' + (has('--apply') ? '' : '（预览）'));
    console.log('═'.repeat(74));
    console.log();

    let ok = 0;
    for (const f of sceneFiles) {
      const j = readJsonSafe(path.join(SCEN_DIR, f));
      if (!j || !j.id) continue;

      const pt = buildPortrait(j);
      const md = renderPortrait(pt);

      console.log('  ' + pt.name.padEnd(12) +
        '面板 ' + String(pt.panelCount).padStart(2) +
        '  网格 ' + pt.grid.cols + '×' + pt.grid.rows +
        '  画像 ' + String(Buffer.byteLength(md, 'utf8')).padStart(5) + ' B');

      if (has('--apply')) {
        const outDir = path.join(MEM_ROOT, pt.name);
        if (fs.existsSync(outDir)) {
          fs.writeFileSync(path.join(outDir, '场景画像.md'), md, 'utf8');
          ok++;
        }
      }
    }

    console.log();
    console.log('─'.repeat(74));
    if (has('--apply')) {
      console.log('  ✓ 已生成 ' + ok + ' 个场景画像');
      console.log('  位置: 数据/.dsh/场景记忆/<场景名>/场景画像.md');
    } else {
      console.log('  （预览。加 --apply 真写）');
    }
    console.log('─'.repeat(74));
    process.exit(0);
  }
}
