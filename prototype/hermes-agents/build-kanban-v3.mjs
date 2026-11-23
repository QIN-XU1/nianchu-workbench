/**
 * 建 hermes kanban「合同协作」任务图（第三版，最终）
 *
 * 四处实测坑（全部踩过）：
 *   ① create --json 是格式化多行 JSON，必须整段 parse（不能 split('\n').pop()）
 *   ② 依赖必须在 create 时传 --parent；事后再 link 会报
 *      "child is already running"（ready 已算启动），且无法回退
 *   ③ --completion-contract 语义是交付落点（local-only / OWNER/REPO / PR URL），
 *      不是自由文本；验收标准走 --body-file
 *   ④ **kanban 派单器会自动拉起 worker** —— 实测一次建 12 个 ready 任务后，
 *      python 进程从 2 个涨到 48 个。所以必须先 `hermes pause` 再建。
 *
 * 结构（管线 9 条边，去重后）：
 *   research ─┬→ competitor-analyze ─┐
 *             ├→ reverse-eng ────────┼→ arch-review → build-plan ─┬→ backend-craft
 *             └→ arch-review ────────┘                            ├→ frontend-craft
 *                                                                  └→ tool-forge
 *   独立：hub / incident-analysis / pc-cleanup / self-review
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PY = 'C:/hermes/.venv/Scripts/python.exe';
const WB = 'D:/file/AI Temp/DeepSeek/Agent自研/workbench';
const BOARD = 'dsh';
const BOARD_NAME = 'DSH 场景管线';

const env = { ...process.env };
env.PATH = 'C:\\WINDOWS\\System32;C:\\WINDOWS;C:\\WINDOWS\\System32\\Wbem';
env.HERMES_HOME = 'C:\\Users\\15282\\AppData\\Local\\hermes';

function hermes(args) {
  const code = "import sys; sys.argv=['hermes']+sys.argv[1:]; from hermes_cli.main import main; main()";
  return execFileSync(PY, ['-c', code, ...args], { cwd: 'C:/hermes', encoding: 'utf8', env, timeout: 120000 });
}

const SCEN = path.join(WB, '外壳', 'scenarios');
const scenes = {};
for (const f of fs.readdirSync(SCEN)) {
  if (!f.endsWith('.json')) continue;
  const j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8'));
  if (j.id && j.name) scenes[j.id] = { id: j.id, name: j.name, desc: j.description || '' };
}

const pipe = JSON.parse(fs.readFileSync(path.join(WB, 'sceneboard', 'pipelines', 'build-software.json'), 'utf8'));
const edges = [];
const seen = new Set();
for (const e of pipe.edges || []) {
  const k = e.from + '>' + e.to;
  if (seen.has(k)) continue;
  seen.add(k);
  edges.push(e);
}
const upstreamOf = {};
for (const e of edges) (upstreamOf[e.to] = upstreamOf[e.to] || []).push(e.from);

function depth(id, guard = new Set()) {
  if (guard.has(id)) return 0;
  guard.add(id);
  const ups = upstreamOf[id] || [];
  if (!ups.length) return 0;
  return 1 + Math.max(...ups.map((u) => depth(u, new Set(guard))));
}
const ALL = Object.keys(scenes).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));

const bodyDir = path.join(process.env.TEMP || '.', 'dsh-kanban-bodies');
fs.mkdirSync(bodyDir, { recursive: true });
function bodyOf(id) {
  const s = scenes[id];
  const ups = upstreamOf[id] || [];
  const downs = edges.filter((e) => e.from === id).map((e) => e.to);
  const nm = (x) => (scenes[x] ? scenes[x].name : x) + '（' + x + '）';
  const lines = [
    '# ' + s.name + '（' + id + '）',
    '',
    '## 职责',
    s.desc || '见场景定义',
    '',
    '## 上游（等谁）',
    ups.length ? ups.map((u) => '- ' + nm(u)).join('\n') : '- 无（管线起点）',
    '',
    '## 下游（给谁）',
    downs.length ? downs.map((d) => '- ' + nm(d)).join('\n') : '- 无（管线终点）',
    '',
    '## 完成合同（四条全满足才算完成）',
    '1. 产出物已写入工作区，路径明确；',
    '2. 每条结论都有证据（文件 / 命令输出 / 截图），不许只写结论；',
    '3. 越界内容一律不产出（越界清单见本智能体 SOUL.md 的「我不做什么」）；',
    '4. 自验通过，并在回帖里给出数字。',
    '',
  ];
  const p = path.join(bodyDir, id + '.md');
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
  return p;
}

// ── 坑④：先暂停派单，否则建完就被自动拉起 worker ──
console.log('=== 暂停派单器 ===');
try {
  const r = hermes(['pause']);
  console.log('  ✓ ' + String(r).trim().split('\n').filter(Boolean)[0].slice(0, 100));
} catch (e) {
  const m = String((e.stdout || '') + (e.stderr || '')).trim().split('\n').filter(Boolean).slice(-1)[0] || '';
  console.log('  ⚠ ' + m.slice(0, 100));
}

// ── 建板 ──
console.log();
console.log('=== 建板 ===');
try {
  hermes(['kanban', 'boards', 'create', BOARD, '--name', BOARD_NAME]);
  console.log('  ✓ ' + BOARD + ' (' + BOARD_NAME + ')');
} catch {
  console.log('  板已存在，复用');
}

// ── 建任务 ──
console.log();
console.log('=== 建任务（拓扑序 + 依赖）===');
const taskOf = {};
for (const id of ALL) {
  const s = scenes[id];
  const ups = (upstreamOf[id] || []).map((u) => taskOf[u]).filter(Boolean);
  const args = [
    'kanban', '--board', BOARD, 'create', s.name + '（' + id + '）',
    '--assignee', id,
    '--body-file', bodyOf(id),
    '--completion-contract', 'local-only',
    '--created-by', 'lead',
    '--json',
  ];
  if (ups.length) {
    for (const p of ups) args.push('--parent', String(p));
    args.push('--initial-status', 'blocked');
  }
  try {
    const j = JSON.parse(String(hermes(args)));
    taskOf[id] = j.id;
    console.log('  ✓ ' + id.padEnd(20) + String(j.id).padEnd(12) + j.status.padEnd(9) +
      'parents=' + (upstreamOf[id] || []).length);
  } catch (e) {
    const m = String((e.stdout || '') + (e.stderr || '')).trim().split('\n').filter(Boolean).slice(-1)[0] || String(e.message);
    console.log('  ✗ ' + id.padEnd(20) + m.slice(0, 100));
  }
}

console.log();
console.log('  任务 ' + Object.keys(taskOf).length + ' / ' + ALL.length + '，依赖边 ' + edges.length);
console.log('  派单器保持暂停（需要执行时跑 `hermes resume`）');
