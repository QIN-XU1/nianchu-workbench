#!/usr/bin/env node
/**
 * 神经元导航层 —— 从真实契约产出「场景怎么走」的数据
 *
 * ── 为什么做这个（用户 2026-11-15 拍板：先能用，后好看）──
 * 方案/91-场景构建设计.md:220：「**神经元不是场景，是场景的导航层**」
 * 而我之前做的是在 21 个 tab 旁边又加 4 个 vouch-* tab —— 反向操作。
 *
 * 这一版**不做可视化**，只做「能用」：
 *   · 12 个场景的真实依赖边（从契约算，不是画的）
 *   · 每个场景：上游是谁（我依赖谁）、下游是谁（谁依赖我）、孤立度
 *   · 供导航用：从任一场景能走到它的上下游
 *
 * ── 数据从哪来（可复算）──────────────────────────────────
 * workbench/外壳/scenarios/*.json   场景清单（中文名 → id）
 * workbench/sceneboard/scenes/*.json 场景契约（outputs.to / inputs.from）
 * 算法复用 prototype/hermes-agents/real-neuron-graph.mjs 的三种写法展开
 *   （outputs[].to · inputs.from 数组 · inputs.from 中文名 —— 第三种老实现没读）
 *
 * ── 四态 ──────────────────────────────────────────────
 *   PASS     能产出图且 ≥1 条边
 *   WARN     有节点无边（场景互不依赖，导航层无意义）
 *   UNKNOWN  读不到契约
 *
 * 用法：node tools/ui/build-neuron.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const WB = path.join(REPO, 'workbench');
const SCEN = path.join(WB, '外壳/scenarios');
const CONTRACTS = path.join(WB, 'sceneboard/scenes');
const OUT = path.join(REPO, 'apps/vouch-web/src/web-ui/src/app/scenes/vouch/data/neuron.json');

/**
 * 把契约里的引用归一化成场景 id 数组
 *
 * 【2026-11-15 修】真实契约结构是：
 *   outputs: [{ id:'architecture-plan', to:['build-plan'] }]   ← to 在**对象内部**
 *   inputs:  [{ id:'feature-matrix',    from:['competitor-analyze'] }]
 * 第一版我读成了 `x.id` —— 那是**产物 id**（architecture-plan），不是场景 id，
 * 所以 12 个场景全部孤立、0 条边。必须按方向读 `to` / `from`。
 *
 * @param key 'to'（outputs）| 'from'（inputs）
 */
export function normRefs(list, key, nameToId) {
  const out = [];
  for (const x of (Array.isArray(list) ? list : [])) {
    let raw = null;
    if (typeof x === 'string') raw = x;
    else if (x && typeof x === 'object') raw = x[key];
    const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    for (const r of arr) if (r) out.push(nameToId[r] || r);
  }
  return out;
}

/**
 * 从契约集合构图
 *
 * @param scenes    [{id, name, ...}]
 * @param contracts { id: {outputs?, inputs?} }
 */
export function buildGraph(scenes, contracts) {
  const nameToId = {};
  for (const s of scenes) { if (s.name) nameToId[s.name] = s.id; nameToId[s.id] = s.id; }

  const ids = scenes.map((s) => s.id);
  const edges = [];
  const seen = new Set();

  for (const id of ids) {
    const c = contracts[id] || {};
    const outTargets = normRefs(c.outputs, 'to', nameToId);
    const inSources = normRefs(c.inputs, 'from', nameToId);
    for (const t of outTargets) {
      const k = id + '>' + t;
      if (!seen.has(k) && ids.includes(t)) { seen.add(k); edges.push({ from: id, to: t, how: 'outputs.to' }); }
    }
    for (const s of inSources) {
      const k = s + '>' + id;
      if (!seen.has(k) && ids.includes(s)) { seen.add(k); edges.push({ from: s, to: id, how: 'inputs.from' }); }
    }
  }

  const byId = {};
  for (const id of ids) byId[id] = { id, upstream: [], downstream: [] };
  for (const e of edges) {
    byId[e.from].downstream.push(e.to);
    byId[e.to].upstream.push(e.from);
  }

  const nodes = scenes.map((s) => ({
    id: s.id, name: s.name || s.id,
    upstream: byId[s.id].upstream,
    downstream: byId[s.id].downstream,
    deg: byId[s.id].upstream.length + byId[s.id].downstream.length,
    isolated: byId[s.id].upstream.length + byId[s.id].downstream.length === 0,
  }));

  return {
    nodes, edges,
    stats: {
      scenes: ids.length,
      edges: edges.length,
      isolated: nodes.filter((n) => n.isolated).length,
      maxDeg: nodes.reduce((a, n) => Math.max(a, n.deg), 0),
    },
  };
}

export function verdictOf(g) {
  if (!g || !g.stats || g.stats.scenes === 0) return { state: 'UNKNOWN', why: '读不到任何场景契约' };
  if (g.stats.edges === 0) return { state: 'WARN', why: '有 ' + g.stats.scenes + ' 个场景但 0 条依赖边 —— 导航层无意义' };
  const cover = 1 - g.stats.isolated / g.stats.scenes;
  return {
    state: 'PASS',
    why: g.stats.scenes + ' 场景 · ' + g.stats.edges + ' 边 · 孤立 ' + g.stats.isolated
      + ' · 最大度 ' + g.stats.maxDeg + ' · 覆盖 ' + (cover * 100).toFixed(0) + '%',
  };
}

/** 自检 —— 4 条反例 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  // ── 正例：图构建必须**真的建出**节点和边，不只是「不许建错」──────────
  // 为什么需要它：如果 buildGraph 永远返回 { nodes: [], edges: [] }，
  // 那 4 条「不许重复」「不许指向不存在」的反例全都会通过 ——
  // 但整个神经元图就是空的，界面什么都不显示。
  // 必须显式断言它在正常输入下**确实**建出了预期数量的节点与边。
  const okScenes = [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }];
  const okContracts = {
    a: { outputs: [{ to: '乙', name: '产物' }] },
    b: { inputs: [{ from: '甲' }] },
  };
  const gOK = buildGraph(okScenes, okContracts);
  T('正例 · 图构建：2 个场景 ⇒ 2 个节点',
    (gOK?.nodes || []).length === 2, 'nodes=' + (gOK?.nodes || []).length);
  T('正例 · 图构建：a 输出指向乙 ⇒ 建出 1 条边 a→b',
    (gOK?.edges || []).length === 1 && gOK?.edges?.[0]?.from === 'a' && gOK?.edges?.[0]?.to === 'b',
    JSON.stringify(gOK?.edges || []));
  T('正例 · 图构建：两端度数都要算上（a 出度 1、b 入度 1）',
    ((gOK?.nodes || []).find((n) => n.id === 'a')?.deg ?? 0) >= 1
    && ((gOK?.nodes || []).find((n) => n.id === 'b')?.deg ?? 0) >= 1,
    JSON.stringify((gOK?.nodes || []).map((n) => [n.id, n.deg])));
  T('正例 · 判定：有场景有边 ⇒ PASS',
    verdictOf(gOK).state === 'PASS', JSON.stringify(verdictOf(gOK)));
  const scenes = [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }, { id: 'c', name: '丙' }];

  // ── 反例 1（核心）：中文名输入边必须能解析（老实现没读）──
  const g1 = buildGraph(scenes, { a: { inputs: [{ id: 'x', from: ['乙'] }] }, b: {}, c: {} });
  T('反例 · inputs.from 用中文名（乙）也必须解析成边 b→a',
    (g1?.edges || []).some((e) => e.from === 'b' && e.to === 'a'), JSON.stringify(g1?.edges));

  // ── 反例 2：指向不存在场景的边必须丢弃（不许造幽灵节点）──
  const g2 = buildGraph(scenes, { a: { outputs: [{ id: 'y', to: ['不存在的场景'] }] }, b: {}, c: {} });
    T('反例 · 指向不存在场景的边必须丢弃', (g2?.edges || []).length === 0, JSON.stringify(g2?.edges || []));

  // ── 反例 3：同一条边不许重复计数（outputs 与 inputs 同时声明）──
  const g3 = buildGraph(scenes, { a: { outputs: [{ id: 'z', to: ['b'] }] }, b: { inputs: [{ id: 'w', from: ['甲'] }] }, c: {} });
  T('反例 · 同一对场景不许重复计边（a→b 只算 1 条）',
    (g3?.edges || []).filter((e) => e.from === 'a' && e.to === 'b').length === 1, JSON.stringify(g3?.edges));

  // ── 反例 4：0 边必须判 WARN，不许 PASS ──
  const g4 = buildGraph(scenes, { a: {}, b: {}, c: {} });
  T('反例 · 有场景但 0 边 ⇒ WARN（不许 PASS）', verdictOf(g4).state === 'WARN', JSON.stringify(verdictOf(g4).state));

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  神经元导航层 · 自检（4 反例）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

// ── 主流程 ──
function loadAll() {
  const scenes = [];
  if (fs.existsSync(SCEN)) {
    for (const f of fs.readdirSync(SCEN)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8'));
        const id = j.id || f.replace(/\.json$/, '');
        scenes.push({ id, name: j.name || id, raw: j });
      } catch { /* 坏文件跳过，不中断 */ }
    }
  }
  const contracts = {};
  if (fs.existsSync(CONTRACTS)) {
    for (const f of fs.readdirSync(CONTRACTS)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(CONTRACTS, f), 'utf8'));
        contracts[j.id || f.replace(/\.json$/, '')] = j;
      } catch { /* 同上 */ }
    }
  }
  return { scenes, contracts };
}

const { scenes, contracts } = loadAll();
const g = buildGraph(scenes, contracts);
const v = verdictOf(g);

console.log('');
console.log('  神经元导航层 —— 场景怎么走（数据来自真实契约，不是画的）');
console.log('  ' + '='.repeat(76));
console.log('  ' + v.state + ' —— ' + v.why);
console.log('');
if (g.nodes.length) {
  console.log('  场景                 上游   下游   度');
  for (const n of [...g.nodes].sort((a, b) => b.deg - a.deg)) {
    console.log('  ' + String(n.name).slice(0, 18).padEnd(20)
      + String(n.upstream.length).padStart(4) + String(n.downstream.length).padStart(7)
      + String(n.deg).padStart(6) + (n.isolated ? '   ⚠ 孤立' : ''));
  }
  console.log('');
}

if (v.state !== 'UNKNOWN') {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), state: v.state, ...g }, null, 2) + '\n', 'utf8');
  console.log('  → ' + path.relative(REPO, OUT));
  console.log('');
}
process.exit(v.state === 'PASS' ? 0 : v.state === 'WARN' ? 3 : 2);
