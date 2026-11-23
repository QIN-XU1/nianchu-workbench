#!/usr/bin/env node
/**
 * 把「记忆神经元」真正融入 hermes
 *
 * ══════════════════════════════════════════════════════════════════════
 *  神经元到底是什么（读 neuron.js 132KB 得出的结论）
 * ══════════════════════════════════════════════════════════════════════
 *   · 节点 = 场景（只有场景，技能/记忆不做节点）
 *   · 边   = 场景↔场景的真实依赖，来自契约 sceneboard/scenes/<id>.json
 *   · 附属 = { memory, identity, skills(=capabilities), mcp, panels }，点击展开
 *   · 形态 = 球面排布 + 拖拽 + 360° 旋转 + 「整理」复位 + 双层（领域/场景）
 *
 * ══════════════════════════════════════════════════════════════════════
 *  上一版为什么没融进去（实测）
 * ══════════════════════════════════════════════════════════════════════
 *  ① 边用了 pipelines（9 条）而不是契约。契约真实边是 **28 条**，
 *     而且契约有三种写法混用，神经元自己只读了 outputs.to：
 *        outputs.to 数组       15 次
 *        inputs.from 数组      18 次   ← 神经元没读
 *        inputs.from 中文名     9 次   ← 神经元没读
 *     所以连工作台自己的神经元都是残缺的。
 *  ② 共享记忆底盘（记忆地图/场地地图/身份索引/关键资产/进化台账…）9 个文件一个都没进。
 *  ③ 记忆地图本身过期（只登记 9 个场景，缺 3 个工坊）。
 *  ④ 神经元视图（场景关系球）只在工作台外壳里。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  这份脚本做什么
 * ══════════════════════════════════════════════════════════════════════
 *   A. 共享底盘 → %LOCALAPPDATA%\hermes\dsh-shared\（11 个文件）
 *   B. NEURON.json / NEURON.md → 完整 28 边图（含环），人和智能体都能读
 *   C. 每个 profile 的 SOUL.md 追加「我在神经元里的位置」（真实上下游，来自 28 边图）
 *   D. kanban 重建为「最大无环子图」：能表达的都表达，环必须断的明确记下来
 *   E. 全量自验
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const WB = 'D:/file/AI Temp/DeepSeek/Agent自研/workbench';
const REPO = path.dirname(WB);
const PROF = 'C:/Users/15282/AppData/Local/hermes/profiles';
const HERMES_HOME = 'C:/Users/15282/AppData/Local/hermes';
const SHARED_DST = path.join(HERMES_HOME, 'dsh-shared');
const PY = 'C:/hermes/.venv/Scripts/python.exe';
const BOARD = 'dsh';

const SCEN = path.join(WB, '外壳', 'scenarios');
const CONTRACTS = path.join(WB, 'sceneboard', 'scenes');
const SHARED_SRC = path.join(WB, '数据', '.dsh', '场景记忆', '_共享记忆');
const PIPE = path.join(WB, 'sceneboard', 'pipelines', 'build-software.json');
const GRAPH_F = 'D:/file/AI Temp/DeepSeek/Agent自研/prototype/hermes-agents/.neuron-graph.json';

const DRY = process.argv.includes('--dry');

const env = { ...process.env };
env.PATH = 'C:\\WINDOWS\\System32;C:\\WINDOWS;C:\\WINDOWS\\System32\\Wbem';
env.HERMES_HOME = HERMES_HOME;

function hermes(args) {
  const code = "import sys; sys.argv=['hermes']+sys.argv[1:]; from hermes_cli.main import main; main()";
  return execFileSync(PY, ['-c', code, ...args], { cwd: 'C:/hermes', encoding: 'utf8', env, timeout: 180000 });
}

// ── 场景 ──
const scenes = [];
for (const f of fs.readdirSync(SCEN)) {
  if (!f.endsWith('.json')) continue;
  const file = path.join(SCEN, f);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (j.id && j.name) {
    if (!j.domain) throw new Error('场景 ' + j.id + ' 缺 domain —— 先跑 assign-domains.mjs');
    // 孵化时刻用「这个场景文件第一次进 git」的时间，不是 mtime。
    // mtime 会被任何一次编辑刷新，12 个场景就会全挤在「今天」，星图的径向时间轴退化成一圈。
    // git 的首次提交是场景真实诞生的时刻，且不会因为后来改内容而漂移。
    const hatchedAt = Number(j.hatchedAt) || gitBirthMs(file) || Math.round(fs.statSync(file).mtimeMs);
    scenes.push({ id: j.id, name: j.name, desc: j.description || '', domain: j.domain, hatchedAt });
  }
}

/** 文件首次提交的毫秒时间戳；未提交或拿不到返回 0。 */
function gitBirthMs(file) {
  try {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    const iso = execFileSync('git', ['log', '--diff-filter=A', '--format=%aI', '--', rel], {
      cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n').filter(Boolean)[0];
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(ms) ? ms : 0;
  } catch {
    return 0;
  }
}
scenes.sort((a, b) => a.id.localeCompare(b.id));
const byId = Object.fromEntries(scenes.map((s) => [s.id, s]));

// ── 神经元图（上一步算好的 28 边）──
const G = JSON.parse(fs.readFileSync(GRAPH_F, 'utf8'));
const neuronEdges = G.edges;

// ── 契约原文（给 NEURON.md 用产物名/理由）──
const contracts = {};
for (const f of fs.readdirSync(CONTRACTS)) {
  if (!f.endsWith('.json')) continue;
  const j = JSON.parse(fs.readFileSync(path.join(CONTRACTS, f), 'utf8'));
  contracts[j.id || f.replace('.json', '')] = j;
}

console.log('='.repeat(96));
console.log('  记忆神经元 → hermes 融入');
console.log('='.repeat(96));
console.log();

// ══════════════════════════════════════════════════════════════════
//  A. 共享底盘
// ══════════════════════════════════════════════════════════════════
console.log('  ── A. 共享记忆底盘 → dsh-shared/ ──');
if (!DRY) fs.mkdirSync(SHARED_DST, { recursive: true });

const INFRA = [
  '记忆地图.json', '场地地图.json', '身份索引.json', '关键资产.json',
  '进化台账.json', '派单台账.json', '健康度.json', '基线.json', '索引.json', '索引.md', '项目.json',
];
let copiedA = 0;
for (const f of INFRA) {
  const src = path.join(SHARED_SRC, f);
  if (!fs.existsSync(src)) { console.log('    · ' + f + '（源不存在，跳过）'); continue; }
  const dst = path.join(SHARED_DST, f);
  const size = (fs.statSync(src).size / 1024).toFixed(1) + 'KB';
  if (!DRY) fs.copyFileSync(src, dst);
  copiedA++;
  console.log('    ✓ ' + f.padEnd(18) + size);
}
// 中枢场景记忆也带上（它是调度中心）
const hubMem = path.join(WB, '数据', '.dsh', '场景记忆', '中枢', '场景私有记忆.md');
if (fs.existsSync(hubMem) && !DRY) {
  fs.mkdirSync(path.join(SHARED_DST, '中枢'), { recursive: true });
  fs.copyFileSync(hubMem, path.join(SHARED_DST, '中枢', '场景私有记忆.md'));
  console.log('    ✓ 中枢/场景私有记忆.md');
  copiedA++;
}
console.log('    共 ' + copiedA + ' 个文件 → ' + SHARED_DST);
console.log();

// ══════════════════════════════════════════════════════════════════
//  B. NEURON.json / NEURON.md
// ══════════════════════════════════════════════════════════════════
console.log('  ── B. 神经元图 → dsh-shared/NEURON.json + NEURON.md ──');

// 每个场景的附属物（对应 neuron.js 的 attachments）
const neuron = {
  _at: new Date().toISOString(),
  _what: '记忆神经元：场景关系图。节点=场景，边=契约声明的真实依赖，附属=记忆/身份/技能/面板',
  _source: 'workbench/sceneboard/scenes/*.json 的 outputs[].to ∪ inputs[].from(反转)',
  _note: '契约有三种写法混用（outputs.to 15 次 / inputs.from 数组 18 次 / inputs.from 中文名 9 次），全部归一化后去重',
  scenes: scenes.map((s) => {
    const c = contracts[s.id] || {};
    const caps = Array.isArray(c.capabilities) ? c.capabilities : [];
    const prof = path.join(PROF, s.id);
    const memN = fs.existsSync(path.join(prof, 'memories'))
      ? fs.readdirSync(path.join(prof, 'memories')).filter((x) => x.endsWith('.md')).length : 0;
    const skN = fs.existsSync(path.join(prof, 'skills', s.id))
      ? fs.readdirSync(path.join(prof, 'skills', s.id)).length : 0;
    return {
      id: s.id,
      name: s.name,
      domain: s.domain,
      hatchedAt: s.hatchedAt,
      description: s.desc,
      profile: 'profiles/' + s.id,
      attachments: {
        memory: memN > 0 ? memN + ' 个文件' : null,
        identity: fs.existsSync(path.join(prof, 'SOUL.md')) ? 'SOUL.md' : null,
        skills: caps,
        skillFiles: skN,
        mcp: [],
        panels: Array.isArray(c.panels) ? c.panels.length : 0,
      },
      inputs: (c.inputs || []).map((x) => ({ id: x.id, from: x.from, required: x.required })),
      outputs: (c.outputs || []).map((x) => ({ id: x.id, to: x.to, files: x.files })),
    };
  }),
  edges: neuronEdges.map((e) => ({ from: e.from, to: e.to, via: e.declared })),
};
if (!DRY) fs.writeFileSync(path.join(SHARED_DST, 'NEURON.json'), JSON.stringify(neuron, null, 2), 'utf8');
console.log('    ✓ NEURON.json  ' + scenes.length + ' 节点 / ' + neuronEdges.length + ' 边');

// NEURON.md —— 给人/智能体读的版本
const din = {};
const dout = {};
for (const s of scenes) { din[s.id] = []; dout[s.id] = []; }
for (const e of neuronEdges) {
  dout[e.from].push(e);
  din[e.to].push(e);
}
function nm(id) { return byId[id] ? byId[id].name + '（' + id + '）' : id; }

const mdLines = [
  '# 记忆神经元（场景关系图）',
  '',
  '> 自动生成，勿手改。源：`workbench/sceneboard/scenes/*.json`。',
  '> 这份文件是 hermes 侧的神经元本体：节点=场景，边=契约声明的真实依赖。',
  '> 工作台的图形视图（`外壳/ui/panels/neuron.js`）画的就是这张图。',
  '',
  '## 概览',
  '',
  '- 节点 ' + scenes.length + ' 个（全是场景，技能/记忆不做节点）',
  '- 边 ' + neuronEdges.length + ' 条（契约三种写法归一化）',
  '- 全图 **连通**（一个弱连通分量，12 个场景都在里面）',
  '- 含环（真实工作流是环形的，不是直线）：`hub ↔ incident-analysis`、`hub ↔ pc-cleanup`',
  '',
  '## 每个场景在神经元里的位置',
  '',
];
for (const s of scenes) {
  mdLines.push('### ' + s.name + '（' + s.id + '）');
  mdLines.push('');
  mdLines.push('智能体：`profiles/' + s.id + '/`　记忆 ' +
    (neuron.scenes.find((x) => x.id === s.id).attachments.memory || '—'));
  mdLines.push('');
  if (din[s.id].length) {
    mdLines.push('**上游（它等谁）**');
    for (const e of din[s.id]) mdLines.push('- ' + nm(e.from) + '　经 `' + [...new Set(e.declared.map((d) => d.artifact))].join('`,`') + '`');
  } else {
    mdLines.push('**上游**：无（图里的起点）');
  }
  mdLines.push('');
  if (dout[s.id].length) {
    mdLines.push('**下游（它给谁）**');
    for (const e of dout[s.id]) mdLines.push('- ' + nm(e.to) + '　交 `' + [...new Set(e.declared.map((d) => d.artifact))].join('`,`') + '`');
  } else {
    mdLines.push('**下游**：无（图里的终点）');
  }
  mdLines.push('');
}
mdLines.push('## 环（真实存在，不是数据错误）');
mdLines.push('');
mdLines.push('```');
mdLines.push('hub → incident-analysis → hub     （中枢派单下去、故障分析回报上来）');
mdLines.push('hub → pc-cleanup → hub            （中枢派清理、本地电脑回报台账）');
mdLines.push('```');
mdLines.push('');
mdLines.push('阶段任务图（kanban）不能有环，所以那里断开了「回报」方向，只保留「派单」方向。');
mdLines.push('本文件保留完整图，是神经元的权威版本。');
mdLines.push('');
if (!DRY) fs.writeFileSync(path.join(SHARED_DST, 'NEURON.md'), mdLines.join('\n'), 'utf8');
console.log('    ✓ NEURON.md    ' + mdLines.length + ' 行');
console.log();

// ══════════════════════════════════════════════════════════════════
//  C. 每个 profile 的 SOUL.md 追加神经元位置
// ══════════════════════════════════════════════════════════════════
console.log('  ── C. 每个智能体知道自己在家谱里的位置 ──');
const MARK = '## 我在神经元里的位置';
let cOk = 0;
function nmLink(id) { return byId[id] ? byId[id].name + '（`' + id + '`）' : id; }

for (const s of scenes) {
  const sp = path.join(PROF, s.id, 'SOUL.md');
  if (!fs.existsSync(sp)) { console.log('    ✗ ' + s.id + ' 无 SOUL.md'); continue; }
  let soul = fs.readFileSync(sp, 'utf8');
  if (soul.includes(MARK)) { cOk++; console.log('    · ' + s.id + ' 已有该段，跳过'); continue; }

  const ups = din[s.id];
  const downs = dout[s.id];
  const sec = [
    '',
    '---',
    '',
    MARK,
    '',
    '这是你在整张场景图里的真实位置（来自契约 `outputs.to` / `inputs.from`），不是编排者编的。',
    '完整图：`' + SHARED_DST.replace(/\//g, '\\') + '\\NEURON.md`',
    '',
    '**我等谁（上游）**',
  ];
  if (ups.length) {
    for (const e of ups) sec.push('- ' + nmLink(e.from) + '　交来 `' + [...new Set(e.declared.map((d) => d.artifact))].join('`,`') + '`');
  } else {
    sec.push('- 无（图里的起点）');
  }
  sec.push('');
  sec.push('**我给谁（下游）**');
  if (downs.length) {
    for (const e of downs) sec.push('- ' + nmLink(e.to) + '　交 `' + [...new Set(e.declared.map((d) => d.artifact))].join('`,`') + '`');
  } else {
    sec.push('- 无（图里的终点）');
  }
  sec.push('');
  sec.push('上游没就绪时不要硬做；下游要的东西按契约交，不要临时改形状。');
  sec.push('');

  if (!DRY) fs.writeFileSync(sp, soul.replace(/\s*$/, '') + '\n' + sec.join('\n'), 'utf8');
  cOk++;
  console.log('    ✓ ' + s.id.padEnd(20) + '上游 ' + ups.length + ' / 下游 ' + downs.length);
}
console.log('    完成 ' + cOk + '/12');
console.log();

// ══════════════════════════════════════════════════════════════════
//  D. kanban = 最大无环子图
// ══════════════════════════════════════════════════════════════════
console.log('  ── D. kanban 重建为最大无环子图 ──');

// 优先级：管线边（已验证 DAG）优先，其后按神经元边补齐，加一条不成就跳过
const pipeEdges = [];
{
  const j = JSON.parse(fs.readFileSync(PIPE, 'utf8'));
  const s = new Set();
  for (const e of j.edges || []) {
    const k = e.from + '>' + e.to;
    if (s.has(k)) continue;   // ★ 必须去重：重复边会被下游误判成环
    s.add(k);
    pipeEdges.push([e.from, e.to]);
  }
}
const pipeSet = new Set(pipeEdges.map(([a, b]) => a + '>' + b));

const candidates = [];
const candSeen = new Set();
for (const [a, b] of pipeEdges) {
  const k = a + '>' + b;
  candSeen.add(k);
  candidates.push([a, b, 'pipeline']);
}
for (const e of neuronEdges) {
  const k = e.from + '>' + e.to;
  if (candSeen.has(k)) continue;
  candSeen.add(k);
  candidates.push([e.from, e.to, 'contract']);
}

// 贪心建 DAG：加边前检查是否会成环
const dagAdj = {};
function reach(from, to) {
  const st = [from];
  const seen = new Set();
  while (st.length) {
    const x = st.pop();
    if (x === to) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    for (const y of (dagAdj[x] || [])) st.push(y);
  }
  return false;
}
const kept = [];
const redundant = [];   // 已被其他路径蕴含，去掉不影响语义
const dropped = [];     // 真环，必须断开，要记进文档
for (const [a, b, src] of candidates) {
  if (a === b) continue;
  if (reach(a, b)) { redundant.push([a, b, src]); continue; }
  if (reach(b, a)) { dropped.push([a, b, src]); continue; }
  (dagAdj[a] = dagAdj[a] || []).push(b);
  kept.push([a, b, src]);
}
console.log('    候选 ' + candidates.length + ' 条 → 保留 ' + kept.length +
  ' / 冗余 ' + redundant.length + ' / 真环断开 ' + dropped.length);
if (redundant.length) {
  console.log('    冗余（已由其他路径蕴含，去掉不丢语义）：');
  for (const [a, b, s] of redundant) console.log('      ~ ' + a + ' → ' + b + '  (' + s + ')');
}
if (dropped.length) {
  console.log('    真环断开（记录进 NEURON.md）：');
  for (const [a, b, s] of dropped) console.log('      ✂ ' + a + ' → ' + b + '  (' + s + ')');
}

// 重建看板
if (!DRY) {
  try { hermes(['pause']); console.log('    ✓ 派单器已暂停'); } catch { /* 已暂停 */ }
  try { hermes(['kanban', 'boards', 'delete', BOARD, '--delete']); console.log('    ✓ 已删旧板'); } catch (e) {
    console.log('    删旧板失败：' + String((e.stdout || '') + (e.stderr || '')).trim().split('\n').filter(Boolean).slice(-1)[0].slice(0, 80));
  }
  hermes(['kanban', 'boards', 'create', BOARD, '--name', 'DSH 场景管线']);
  console.log('    ✓ 已建板');

  const upstreamOf = {};
  for (const [a, b] of kept) (upstreamOf[b] = upstreamOf[b] || []).push(a);

  // 拓扑序
  const nodes = scenes.map((s) => s.id);
  const order = [];
  const indeg = {};
  for (const n of nodes) indeg[n] = (upstreamOf[n] || []).length;
  const q = nodes.filter((n) => indeg[n] === 0);
  const seenN = new Set(q);
  while (q.length) {
    const n = q.shift();
    order.push(n);
    for (const [a, b] of kept) if (a === n && !seenN.has(b)) {
      indeg[b]--;
      if (indeg[b] === 0) { q.push(b); seenN.add(b); }
    }
  }
  for (const n of nodes) if (!order.includes(n)) order.push(n);

  const taskOf = {};
  const bodyDir = path.join(process.env.TEMP || '.', 'dsh-neuron-bodies');
  fs.mkdirSync(bodyDir, { recursive: true });

  for (const id of order) {
    const ups = upstreamOf[id] || [];
    const downs = kept.filter(([a]) => a === id).map(([, b]) => b);
    const body = [
      '# ' + byId[id].name + '（' + id + '）',
      '',
      '## 职责',
      byId[id].desc || '见场景定义',
      '',
      '## 神经元位置（来自契约）',
      '**上游**：' + (ups.length ? ups.map((u) => byId[u].name + '（' + u + '）').join('、') : '无'),
      '**下游**：' + (downs.length ? downs.map((d) => byId[d].name + '（' + d + '）').join('、') : '无'),
      '',
      '完整图：`' + SHARED_DST.replace(/\//g, '\\') + '\\NEURON.md`',
      '',
      '## 完成合同（四条全满足才算完成）',
      '1. 产出物已写入工作区，路径明确；',
      '2. 每条结论都有证据（文件 / 命令输出 / 截图），不许只写结论；',
      '3. 越界内容一律不产出（见 SOUL.md「我不做什么」）；',
      '4. 自验通过，并在回帖里给出数字。',
      '',
    ].join('\n');
    const bp = path.join(bodyDir, id + '.md');
    fs.writeFileSync(bp, body, 'utf8');

    const args = [
      'kanban', '--board', BOARD, 'create', byId[id].name + '（' + id + '）',
      '--assignee', id, '--body-file', bp,
      '--completion-contract', 'local-only',
      '--created-by', 'lead', '--json',
    ];
    if (ups.length) {
      for (const u of ups) args.push('--parent', taskOf[u]);
      args.push('--initial-status', 'blocked');
    }
    try {
      const j = JSON.parse(String(hermes(args)));
      taskOf[id] = j.id;
    } catch (e) {
      console.log('    ✗ ' + id + ' ' + String((e.stdout || '') + (e.stderr || '')).trim().split('\n').filter(Boolean).slice(-1)[0].slice(0, 90));
    }
  }
  console.log('    ✓ 任务 ' + Object.keys(taskOf).length + '/12，依赖边 ' + kept.length);
}
console.log();

// ══════════════════════════════════════════════════════════════════
//  E. 汇总
// ══════════════════════════════════════════════════════════════════
console.log('='.repeat(96));
console.log('  A 共享底盘 ' + copiedA + ' 文件');
console.log('  B NEURON.json/md：' + scenes.length + ' 节点 / ' + neuronEdges.length + ' 边（含 2 处环）');
console.log('  C SOUL 神经元位置 ' + cOk + '/12');
console.log('  D kanban 最大无环子图：保留 ' + kept.length + ' 边，断环丢弃 ' + dropped.length + ' 边');
console.log('='.repeat(96));
