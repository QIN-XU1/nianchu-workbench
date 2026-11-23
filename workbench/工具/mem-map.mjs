/**
 * 补全记忆地图 —— 让新场景被记忆神经元识别
 *
 * 实测发现：
 *   记忆地图.json 只登记了 4 个旧场景
 *   我新建的 7 个场景（调研/竞品拆解/逆向分析/架构梳理/实施计划/管线/关系军师）全没登记
 *   ⇒ 神经元显示"私有记忆 4"，新场景在图上根本不存在
 *
 * 本工具从「场景 json + 已建记忆目录」自动生成记忆地图，
 * 并校验每个引用路径都真实存在。
 *
 * 用法：
 *   node 工具\mem-map.mjs           重建记忆地图
 *   node 工具\mem-map.mjs --dry     预览
 *   node 工具\mem-map.mjs --check   只校验
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..');
const SHELL = path.join(WB, '外壳');
const SC_DIR = path.join(SHELL, 'scenarios');
const MEM = path.join(WB, '数据', '.dsh', '场景记忆');
const MAP_FILE = path.join(MEM, '_共享记忆', '记忆地图.json');
const IDX_FILE = path.join(MEM, '_共享记忆', '索引.json');
const IDX_MD = path.join(MEM, '_共享记忆', '索引.md');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

const dry = process.argv.includes('--dry');
const onlyCheck = process.argv.includes('--check');

/** 读全部场景 */
function loadScenes() {
  if (!fs.existsSync(SC_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(SC_DIR)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SC_DIR, f), 'utf8').replace(/\uFEFF/g, ''));
      if (j.id && j.name) out.push(j);
    } catch { /* ignore */ }
  }
  return out;
}

/**
 * 为每个场景找「会话入口面板」id
 *
 * 两类入口：
 *   ① 常规场景：panels 里 type === 'harness' 的那个
 *   ② 中枢特殊：它的对话由 shell.sideEl 固定挂载（不是场景面板），
 *      配置里只有 neuron 面板，但会话入口是存在的
 *      → 用 'shell-side' 这个虚拟 id 标记
 *
 * 判据：meta.note 里提到"shell"或场景有 first:true，视为中枢。
 */
function findAiPanel(sc) {
  // ① 常规：harness 面板
  const p = (sc.panels || []).find((x) => x.type === 'harness');
  if (p) return p.id;

  // ② 中枢特殊处理：对话由外壳固定挂载
  const note = (sc.meta && sc.meta.note) || '';
  if (note.includes('shell') || note.includes('外壳')) {
    return 'shell-side';
  }

  // ③ 有 neuron 面板且是首屏（中枢特征）
  const hasNeuron = (sc.panels || []).some((x) => x.type === 'neuron');
  if (hasNeuron && sc.first) {
    return 'shell-side';
  }

  return '';
}

/** 重建记忆地图 */
function rebuild(scenes) {
  const areas = [];
  const problems = [];

  const sorted = scenes.slice().sort((a, b) => a.id.localeCompare(b.id));
  for (const sc of sorted) {
    // 找记忆目录：优先按中文名（项目原有约定）
    let memDir = sc.name;
    let memPath = path.join(MEM, memDir);
    if (!fs.existsSync(memPath)) {
      // 退而按 id
      memDir = sc.id;
      memPath = path.join(MEM, memDir);
    }
    const memExists = fs.existsSync(memPath);
    const privateMemRel = memExists ? (memDir + '\\场景私有记忆.md') : '';
    const privateMemAbs = privateMemRel ? path.join(MEM, privateMemRel) : '';
    const fileExists = privateMemRel && fs.existsSync(privateMemAbs);

    if (!memExists) problems.push({ scene: sc.id, msg: '没有记忆目录：' + memPath });
    else if (!fileExists) problems.push({ scene: sc.id, msg: '没有 场景私有记忆.md：' + privateMemAbs });

    areas.push({
      panel: findAiPanel(sc),
      scene: memDir,
      privateMemory: fileExists ? [privateMemRel] : [],
    });
  }

  return {
    map: { areas },
    problems,
  };
}

/** 校验现有地图 */
function check(map) {
  const bad = [];
  for (const a of map.areas || []) {
    // 场景目录
    const dir = path.join(MEM, a.scene);
    if (!fs.existsSync(dir)) bad.push({ scene: a.scene, msg: '目录不存在：' + dir });
    // 每个 privateMemory 路径
    for (const pm of a.privateMemory || []) {
      const full = path.join(MEM, pm);
      if (!fs.existsSync(full)) bad.push({ scene: a.scene, file: pm, msg: '文件不存在：' + full });
    }
    // 面板 id 是否对应真实面板
    if (a.panel) {
      const domain = sceneOfPanel(a.panel);
      if (!domain) bad.push({ scene: a.scene, panel: a.panel, msg: '面板 id 不存在于任何场景' });
    }
  }
  return bad;
}

function sceneOfPanel(panelId) {
  for (const sc of loadScenes()) {
    if ((sc.panels || []).some(p => p.id === panelId)) return sc.id;
  }
  return null;
}

// ---------------- 主流程 ----------------
const scenes = loadScenes();
if (!scenes.length) { console.error('找不到场景'); process.exit(1); }

if (onlyCheck) {
  let map = { areas: [] };
  try { map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8').replace(/\uFEFF/g, '')); } catch { /* ignore */ }
  const bad = check(map);
  console.log(C.bold + '记忆地图校验' + C.reset);
  console.log('  登记 ' + (map.areas || []).length + ' 个场景 · 场景总数 ' + scenes.length);
  if (bad.length) {
    for (const b of bad) console.log('  ' + C.red + 'X' + C.reset + ' ' + b.scene + '  ' + b.msg);
    process.exit(2);
  }
  console.log('  ' + C.green + 'OK 全部路径有效' + C.reset);
  process.exit(0);
}

const { map, problems } = rebuild(scenes);

console.log(C.bold + '重建记忆地图' + C.reset);
console.log('  找到场景 ' + scenes.length + ' 个');
console.log();

if (problems.length) {
  console.log(C.red + '问题 ' + problems.length + ' 项（这些场景的记忆文件不存在，会显示"路径失效"）' + C.reset);
  for (const p of problems) console.log('  ' + C.yellow + '!' + C.reset + ' ' + p.scene + '  ' + p.msg);
  console.log();
}

console.log('  将写入登记表：');
for (const a of map.areas) {
  const hasMem = (a.privateMemory || []).length > 0;
  console.log('    ' + (a.scene || '').padEnd(12) + ' panel=' + String(a.panel || '—').padEnd(12) +
    (hasMem ? C.green + '有记忆' + C.reset : C.yellow + '无记忆' + C.reset));
}

if (dry) {
  console.log();
  console.log(C.dim + '（dry 预览，未写入）' + C.reset);
  process.exit(0);
}

fs.mkdirSync(path.dirname(MAP_FILE), { recursive: true });
fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2) + '\n', 'utf8');
console.log();
console.log(C.green + 'OK' + C.reset + ' 已写入 ' + path.relative(WB, MAP_FILE));

// 同步 索引.json（areas 部分）
try {
  let idx = { areas: [] };
  if (fs.existsSync(IDX_FILE)) {
    idx = JSON.parse(fs.readFileSync(IDX_FILE, 'utf8').replace(/\uFEFF/g, ''));
  }
  const prev = {};
  for (const a of idx.areas || []) prev[a.id] = a;
  idx.areas = map.areas.map(a => {
    const sc = scenes.find(s => s.name === a.scene || s.id === a.scene);
    const id = sc ? sc.id : a.scene;
    const old = prev[id] || {};
    return {
      id,
      name: a.scene,
      owner: a.panel || '',
      memory: '场景记忆/' + a.scene,
      file: old.file || ('areas/' + id + '.md'),
      panel: a.panel || '',
    };
  });
  fs.writeFileSync(IDX_FILE, JSON.stringify(idx, null, 2) + '\n', 'utf8');
  console.log(C.green + 'OK' + C.reset + ' 已同步 ' + path.relative(WB, IDX_FILE) + ' (' + idx.areas.length + ' 个)');
} catch (e) {
  console.log(C.yellow + '!' + C.reset + ' 同步索引.json 失败：' + e.message);
}

// 同步 索引.md（人读版）
try {
  const lines = ['# 总索引', '', '> 场景 ↔ 记忆 ↔ 面板。共 ' + map.areas.length + ' 个场景。', '',
    '| 场景 | 面板 | 私有记忆 |', '|---|---|---|'];
  for (const a of map.areas) {
    const pm = (a.privateMemory || []).join('<br>') || '—';
    lines.push('| ' + a.scene + ' | `' + (a.panel || '—') + '` | `' + pm + '` |');
  }
  lines.push('');
  fs.writeFileSync(IDX_MD, lines.join('\n'), 'utf8');
  console.log(C.green + 'OK' + C.reset + ' 已同步 ' + path.relative(WB, IDX_MD));
} catch (e) {
  console.log(C.yellow + '!' + C.reset + ' 同步索引.md 失败：' + e.message);
}

process.exit(problems.length ? 1 : 0);
