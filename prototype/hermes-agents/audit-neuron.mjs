#!/usr/bin/env node
/**
 * 「记忆神经元」融入审计（v2，按最终架构）
 *
 * ══════════════════════════════════════════════════════════════════════
 *  最终架构（两套图，各司其职，不是重复）
 * ══════════════════════════════════════════════════════════════════════
 *   NEURON.json / NEURON.md   ← 神经元本体：28 边，含环，真实工作流
 *                                （= neuron.js 画的那张图，也是「记忆神经元」）
 *   kanban task_links         ← 执行用的最大无环子图：18 边
 *                                （环必须断，否则任务图死锁）
 *
 *  两者的关系：kanban ⊆ neuron。
 *  kanban 少掉的每一条边都必须能解释成「冗余」或「断环」，不能是漏掉。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  判据（全部重算源，不信任生成物）
 * ══════════════════════════════════════════════════════════════════════
 *   ① 节点      12/12 场景有 profile
 *   ② 神经元边  重算契约 → 必须 == NEURON.json 的边集合
 *   ③ 执行图    kanban ⊆ 神经元；差集只能是冗余或断环；且无环
 *   ④ 附属物    记忆/身份/技能 12/12（MCP 与面板结构性没有，如实记）
 *   ⑤ 底盘      11 个共享记忆文件都在 dsh-shared/
 *   ⑥ 记忆地图  覆盖 12/12（之前只 9）
 *   ⑦ 智能体自觉 12/12 SOUL 里有「我在神经元里的位置」
 *   ⑧ 边界      hermes 的 default profile 未被触碰
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const WB = 'D:/file/AI Temp/DeepSeek/Agent自研/workbench';
const PROF = 'C:/Users/15282/AppData/Local/hermes/profiles';
const SHARED_DST = 'C:/Users/15282/AppData/Local/hermes/dsh-shared';
const DB = 'C:/Users/15282/AppData/Local/hermes/kanban/boards/dsh/kanban.db';
const PY = 'C:/hermes/.venv/Scripts/python.exe';

const SCEN = path.join(WB, '外壳', 'scenarios');
const CONTRACTS = path.join(WB, 'sceneboard', 'scenes');
const SHARED_SRC = path.join(WB, '数据', '.dsh', '场景记忆', '_共享记忆');
const PIPE = path.join(WB, 'sceneboard', 'pipelines', 'build-software.json');

let pass = 0, fail = 0;
const mark = (ok) => { if (ok) pass++; else fail++; return ok ? '✓' : '✗'; };

// ── 场景 + 中文名映射 ──
const scenes = [];
const nameToId = {};
for (const f of fs.readdirSync(SCEN)) {
  if (!f.endsWith('.json')) continue;
  const j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8'));
  if (j.id && j.name) { scenes.push({ id: j.id, name: j.name }); nameToId[j.name] = j.id; nameToId[j.id] = j.id; }
}
scenes.sort((a, b) => a.id.localeCompare(b.id));
const byId = Object.fromEntries(scenes.map((s) => [s.id, s]));

function norm(x) {
  const out = [];
  const push = (v) => {
    if (!v) return;
    const s = String(v).trim();
    if (!s) return;
    out.push(nameToId[s] || nameToId[s.replace(/[（(].*$/, '').trim()] || null);
  };
  if (Array.isArray(x)) x.forEach(push); else push(x);
  return out.filter(Boolean);
}

// ── ② 重算契约边 ──
const wantEdges = new Set();
for (const f of fs.readdirSync(CONTRACTS)) {
  if (!f.endsWith('.json')) continue;
  const j = JSON.parse(fs.readFileSync(path.join(CONTRACTS, f), 'utf8'));
  const id = j.id || f.replace('.json', '');
  for (const o of j.outputs || []) for (const t of norm(o.to)) if (t !== id) wantEdges.add(id + '>' + t);
  for (const inp of j.inputs || []) for (const r of (Array.isArray(inp.from) ? inp.from : inp.from ? [inp.from] : []))
    for (const src of norm(r)) if (src !== id) wantEdges.add(src + '>' + id);
}

// ── NEURON.json 里的边 ──
let gotEdges = new Set();
try {
  const n = JSON.parse(fs.readFileSync(path.join(SHARED_DST, 'NEURON.json'), 'utf8'));
  for (const e of n.edges || []) gotEdges.add(e.from + '>' + e.to);
} catch { /* 下面判据会红 */ }

// ── ③ kanban 边 ──
let kanbanEdges = new Set();
let taskCount = 0;
try {
  const py = `
import sqlite3, json
con = sqlite3.connect(r"${DB}")
con.row_factory = sqlite3.Row
t = {r["id"]: r["assignee"] for r in con.execute("SELECT id, assignee FROM tasks")}
n = con.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
links = set()
for r in con.execute("SELECT parent_id, child_id FROM task_links"):
    links.add(t.get(r["parent_id"], "?") + ">" + t.get(r["child_id"], "?"))
con.close()
print(json.dumps({"n": n, "links": sorted(links)}))
`;
  const j = JSON.parse(execFileSync(PY, ['-c', py], { encoding: 'utf8', timeout: 60000 }));
  taskCount = j.n;
  for (const e of j.links) kanbanEdges.add(e);
} catch { /* 红 */ }

// ── 输出 ──
console.log('='.repeat(96));
console.log('  「记忆神经元」融入审计 v2');
console.log('='.repeat(96));
console.log();
console.log('  架构：NEURON.json（本体，含环）= 神经元本体；kanban（无环子图）= 执行用');
console.log();

// ① 节点
let n1 = 0;
for (const s of scenes) if (fs.existsSync(path.join(PROF, s.id))) n1++;
console.log('  ── ① 节点 ──');
console.log('    ' + mark(n1 === 12) + ' 场景 → 智能体 ' + n1 + '/12');
console.log();

// ② 神经元边
const missing = [...wantEdges].filter((e) => !gotEdges.has(e));
const extra = [...gotEdges].filter((e) => !wantEdges.has(e));
console.log('  ── ② 神经元本体边 ──');
console.log('    契约重算 ' + wantEdges.size + ' 条 / NEURON.json ' + gotEdges.size + ' 条');
console.log('    ' + mark(missing.length === 0 && extra.length === 0) + ' 完全一致' +
  (missing.length ? '  缺: ' + missing.join(',') : '') + (extra.length ? '  多: ' + extra.join(',') : ''));
console.log();

// ③ 执行图
const kNotInNeuron = [...kanbanEdges].filter((e) => !wantEdges.has(e));
const neuronNotK = [...wantEdges].filter((e) => !kanbanEdges.has(e));

// 无环检查
const adj = {};
for (const e of kanbanEdges) { const [a, b] = e.split('>'); (adj[a] = adj[a] || []).push(b); }
let hasCycle = false;
{
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = {};
  for (const s of scenes) color[s.id] = WHITE;
  const dfs = (u) => {
    color[u] = GRAY;
    for (const v of adj[u] || []) {
      if (color[v] === GRAY) return true;
      if (color[v] === WHITE && dfs(v)) return true;
    }
    color[u] = BLACK;
    return false;
  };
  for (const s of scenes) if (color[s.id] === WHITE && dfs(s.id)) { hasCycle = true; break; }
}

// 差集能不能解释：
//   · 冗余 = 该边已被 kanban 里其他路径蕴含
//   · 断环 = 把它加回 kanban 会成环（即 b 已经能走到 a）
function reachIn(from, to, set) {
  const st = [from];
  const seen = new Set();
  while (st.length) {
    const x = st.pop();
    if (x === to) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    for (const y of set) {
      const [p, q] = y.split('>');
      if (p === x) st.push(q);
    }
  }
  return false;
}
const explained = [];
const unexplainable = [];
for (const e of neuronNotK) {
  const [a, b] = e.split('>');
  if (reachIn(a, b, kanbanEdges)) { explained.push([e, '冗余']); continue; }
  if (reachIn(b, a, kanbanEdges)) { explained.push([e, '断环']); continue; }
  unexplainable.push(e);
}

console.log('  ── ③ 执行图（kanban）──');
console.log('    任务 ' + taskCount + ' 个 / 边 ' + kanbanEdges.size + ' 条');
console.log('    ' + mark(kNotInNeuron.length === 0) + ' kanban ⊆ 神经元本体（多出来的: ' + (kNotInNeuron.join(',') || '无') + '）');
console.log('    ' + mark(!hasCycle) + ' 无环（有环则任务死锁）');
console.log('    神经元有、kanban 没有的 ' + neuronNotK.length + ' 条：');
for (const [e, why] of explained) console.log('      · ' + e.padEnd(42) + why);
console.log('    ' + mark(unexplainable.length === 0) + ' 差集全部可解释（无漏边）' +
  (unexplainable.length ? '  漏: ' + unexplainable.join(',') : ''));
console.log();

// ④ 附属物
console.log('  ── ④ 附属物（点击节点展开）──');
const a1 = scenes.filter((s) => {
  const d = path.join(PROF, s.id, 'memories');
  return fs.existsSync(d) && fs.readdirSync(d).some((x) => x.endsWith('.md'));
}).length;
const a2 = scenes.filter((s) => {
  const p = path.join(PROF, s.id, 'SOUL.md');
  return fs.existsSync(p) && /##\s*我是谁/.test(fs.readFileSync(p, 'utf8'));
}).length;
const a3 = scenes.filter((s) => {
  const d = path.join(PROF, s.id, 'skills', s.id);
  return fs.existsSync(d) && fs.readdirSync(d).length > 0;
}).length;
console.log('    ' + mark(a1 === 12) + ' 记忆 memory     ' + a1 + '/12');
console.log('    ' + mark(a2 === 12) + ' 身份 identity   ' + a2 + '/12');
console.log('    ' + mark(a3 === 12) + ' 技能 skills     ' + a3 + '/12');
console.log('    · MCP：契约里 mcp 全为空数组，双方都空 → 无事可做');
console.log('    · 面板：工作台外壳概念，hermes 无对应物 → 结构性没有（如实记录，不假装）');
console.log();

// ⑤ 底盘
const INFRA = ['记忆地图.json', '场地地图.json', '身份索引.json', '关键资产.json',
  '进化台账.json', '派单台账.json', '健康度.json', '基线.json', '索引.json', '索引.md', '项目.json'];
const infraIn = INFRA.filter((f) => fs.existsSync(path.join(SHARED_DST, f))).length;
console.log('  ── ⑤ 共享记忆底盘 ──');
console.log('    ' + mark(infraIn === INFRA.length) + ' dsh-shared/ ' + infraIn + '/' + INFRA.length);
const neuronDoc = path.join(SHARED_DST, 'NEURON.md');
const docLines = fs.existsSync(neuronDoc) ? fs.readFileSync(neuronDoc, 'utf8').split('\n').length : 0;
console.log('    ' + mark(docLines > 100) + ' NEURON.md ' + docLines + ' 行（人/智能体可读）');
console.log();

// ⑥ 记忆地图
let mmCover = 0, mmTotal = 0;
try {
  const mm = JSON.parse(fs.readFileSync(path.join(SHARED_SRC, '记忆地图.json'), 'utf8'));
  const mapped = new Set((mm.areas || []).map((a) => a.scene));
  mmTotal = scenes.length;
  mmCover = scenes.filter((s) => mapped.has(s.name)).length;
  const miss = scenes.filter((s) => !mapped.has(s.name)).map((s) => s.id);
  console.log('  ── ⑥ 记忆地图（神经元数据源）──');
  console.log('    ' + mark(mmCover === mmTotal) + ' 覆盖 ' + mmCover + '/' + mmTotal +
    (miss.length ? '  缺: ' + miss.join(',') : ''));
} catch {
  console.log('  ── ⑥ 记忆地图 ──');
  console.log('    ' + mark(false) + ' 读不了');
}
console.log();

// ⑦ 智能体自觉
const aware = scenes.filter((s) => {
  const p = path.join(PROF, s.id, 'SOUL.md');
  return fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('## 我在神经元里的位置');
}).length;
console.log('  ── ⑦ 智能体知道自己在家谱里的位置 ──');
console.log('    ' + mark(aware === 12) + ' SOUL.md 含「我在神经元里的位置」 ' + aware + '/12');
console.log();

// ⑧ 边界
const zero = new Date('2026-11-13T00:00:00').getTime();
const touched = [];
const dd = path.join(PROF, 'default');
if (fs.existsSync(dd)) {
  for (const f of ['SOUL.md', 'profile.yaml', 'config.yaml']) {
    const fp = path.join(dd, f);
    if (fs.existsSync(fp) && fs.statSync(fp).mtimeMs > zero) touched.push(f);
  }
}
console.log('  ── ⑧ 边界 ──');
console.log('    ' + mark(touched.length === 0) + ' hermes 的 default profile 未被触碰' +
  (touched.length ? ' → 被改: ' + touched.join(',') : ''));
console.log();

console.log('─'.repeat(96));
console.log('  断言：通过 ' + pass + '  失败 ' + fail);
console.log('  神经元 ' + gotEdges.size + ' 边（含环）· 执行图 ' + kanbanEdges.size + ' 边（无环）· 节点 12');
console.log('─'.repeat(96));
console.log('='.repeat(96));
process.exit(fail === 0 ? 0 : 1);
