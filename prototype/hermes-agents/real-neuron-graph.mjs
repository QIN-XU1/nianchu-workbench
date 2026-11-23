/**
 * 算「真实神经元图」：把契约里的两种写法都展开成边
 *
 * ══════════════════════════════════════════════════════════════════════
 *  发现的根因
 * ══════════════════════════════════════════════════════════════════════
 *  neuron.js 只读 `outputs[].to`。但实测契约里有三种写法混用：
 *
 *    ① outputs: [{ id, to: ["build-plan"] }]        ← 出边，id 形式
 *    ② inputs:  [{ id, from: ["arch-review"] }]     ← 入边，数组 id
 *    ③ inputs:  [{ id, from: "架构梳理" }]           ← 入边，**中文场景名**
 *
 *  只读 ① 会漏掉 ②③ 声明的全部关系。
 *  所以真实边 = ① ∪ ②（反转）∪ ③（反转，先中文名转 id）
 *
 * ══════════════════════════════════════════════════════════════════════
 *  输出
 * ══════════════════════════════════════════════════════════════════════
 *  · 真实边集合（去重）
 *  · 与管线边、与 kanban 边的差异
 *  · 每个场景在神经元里的 in/out 度
 */

import fs from 'node:fs';
import path from 'node:path';

const WB = 'D:/file/AI Temp/DeepSeek/Agent自研/workbench';
const SCEN = path.join(WB, '外壳', 'scenarios');
const CONTRACTS = path.join(WB, 'sceneboard', 'scenes');
const PIPE = path.join(WB, 'sceneboard', 'pipelines', 'build-software.json');

// ── 场景清单 + 中文名→id ──
const scenes = [];
const nameToId = {};
for (const f of fs.readdirSync(SCEN)) {
  if (!f.endsWith('.json')) continue;
  const j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8'));
  if (j.id && j.name) {
    scenes.push({ id: j.id, name: j.name });
    nameToId[j.name] = j.id;
    nameToId[j.id] = j.id;
  }
}
scenes.sort((a, b) => a.id.localeCompare(b.id));

/** 归一化：可能是 id、可能是中文名、可能是数组 */
function norm(v) {
  const out = [];
  const push = (x) => {
    if (!x) return;
    const s = String(x).trim();
    if (!s) return;
    // 中文名可能带后缀说明，先精确匹配再前缀匹配
    const id = nameToId[s] || nameToId[s.replace(/[（(].*$/, '').trim()];
    out.push(id || null);
  };
  if (Array.isArray(v)) v.forEach(push);
  else push(v);
  return out.filter(Boolean);
}

// ── 从契约抽边（三种写法都算）──
const edges = new Map(); // "from>to" -> [{src:'outputs.to'|'inputs.from', id}]
function addEdge(from, to, how, artifact) {
  if (!from || !to || from === to) return;
  const k = from + '>' + to;
  if (!edges.has(k)) edges.set(k, []);
  edges.get(k).push({ how, artifact });
}

const contractStats = { toDecl: 0, fromDeclArr: 0, fromDeclName: 0, unknownFrom: [] };

for (const f of fs.readdirSync(CONTRACTS)) {
  if (!f.endsWith('.json')) continue;
  const j = JSON.parse(fs.readFileSync(path.join(CONTRACTS, f), 'utf8'));
  const id = j.id || f.replace('.json', '');

  // ① outputs[].to
  for (const o of j.outputs || []) {
    const tos = norm(o.to);
    for (const t of tos) {
      addEdge(id, t, 'outputs.to', o.id);
      contractStats.toDecl++;
    }
  }

  // ②③ inputs[].from（反转：from → id）
  for (const inp of j.inputs || []) {
    if (!inp.from) continue;
    const raws = Array.isArray(inp.from) ? inp.from : [inp.from];
    for (const r of raws) {
      const froms = norm(r);
      if (!froms.length) {
        contractStats.unknownFrom.push(id + ' ← ' + JSON.stringify(r));
        continue;
      }
      for (const src of froms) {
        addEdge(src, id, 'inputs.from', inp.id);
        if (Array.isArray(inp.from)) contractStats.fromDeclArr++;
        else contractStats.fromDeclName++;
      }
    }
  }
}

// ── 管线边 ──
const pipeEdges = new Set();
{
  const j = JSON.parse(fs.readFileSync(PIPE, 'utf8'));
  for (const e of j.edges || []) pipeEdges.add(e.from + '>' + e.to);
}

// ── 输出 ──
console.log('='.repeat(96));
console.log('  真实神经元图（契约三种写法全展开）');
console.log('='.repeat(96));
console.log();
console.log('  场景 ' + scenes.length + ' 个；契约声明计数：');
console.log('    outputs.to      ' + contractStats.toDecl + ' 次');
console.log('    inputs.from 数组 ' + contractStats.fromDeclArr + ' 次');
console.log('    inputs.from 中文名 ' + contractStats.fromDeclName + ' 次   ← 神经元原来完全没读');
if (contractStats.unknownFrom.length) {
  console.log('    ✗ 认不出归属的 from：');
  for (const u of contractStats.unknownFrom) console.log('        ' + u);
}
console.log();

const realEdges = [...edges.keys()].sort();
console.log('  真实边 ' + realEdges.length + ' 条：');
for (const e of realEdges) {
  const hows = [...new Set(edges.get(e).map((x) => x.how))].join('+');
  const arts = [...new Set(edges.get(e).map((x) => x.artifact))].join(',');
  const inPipe = pipeEdges.has(e) ? '  管线也有' : '  ✗管线没有';
  console.log('    ' + e.padEnd(42) + hows.padEnd(24) + arts.padEnd(20) + inPipe);
}
console.log();

// ── 与管线比对 ──
const realSet = new Set(realEdges);
const onlyReal = realEdges.filter((e) => !pipeEdges.has(e));
const onlyPipe = [...pipeEdges].filter((e) => !realSet.has(e)).sort();
console.log('  与管线比对：');
console.log('    真实 ' + realEdges.length + ' 条 / 管线 ' + pipeEdges.size + ' 条 / 共同 ' + (realEdges.length - onlyReal.length) + ' 条');
console.log('    ✗ 真实有、管线没有（' + onlyReal.length + ' 条）：');
for (const e of onlyReal) console.log('        ' + e);
console.log('    ✗ 管线有、真实没有（' + onlyPipe.length + ' 条）：');
for (const e of onlyPipe) console.log('        ' + e);
console.log();

// ── 度 ──
const din = {};
const dout = {};
for (const s of scenes) { din[s.id] = 0; dout[s.id] = 0; }
for (const e of realEdges) {
  const [a, b] = e.split('>');
  dout[a] = (dout[a] || 0) + 1;
  din[b] = (din[b] || 0) + 1;
}
console.log('  每个场景在神经元里的连接：');
console.log('    ' + '场景'.padEnd(22) + '入度  出度  上游 / 下游');
for (const s of scenes) {
  const ups = realEdges.filter((e) => e.endsWith('>' + s.id)).map((e) => e.split('>')[0]);
  const downs = realEdges.filter((e) => e.startsWith(s.id + '>')).map((e) => e.split('>')[1]);
  console.log('    ' + (s.id + ' ' + s.name).padEnd(22) +
    String(din[s.id]).padStart(3) + String(dout[s.id]).padStart(6) + '  ' +
    (ups.join(',') || '—') + ' / ' + (downs.join(',') || '—'));
}
console.log();
console.log('='.repeat(96));

// ── 落盘，给下一步用 ──
const outFile = path.join(WB, '..', 'prototype', 'hermes-agents', '.neuron-graph.json');
const graph = {
  _at: new Date().toISOString(),
  _note: '真实神经元图：outputs.to ∪ inputs.from(反转)，两种写法归一化后去重',
  scenes: scenes.map((s) => ({ id: s.id, name: s.name })),
  edges: realEdges.map((e) => {
    const [from, to] = e.split('>');
    return { from, to, declared: edges.get(e) };
  }),
};
fs.writeFileSync(outFile, JSON.stringify(graph, null, 2), 'utf8');
console.log('  已写 ' + outFile);
