#!/usr/bin/env node
// 工具/管线调度.mjs —— 中枢按管线告诉它「下一个该派给谁」
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具
// ══════════════════════════════════════════════════════════════════════
//  实测发现：中枢的 SKILL.md 里**完全没提到管线**（grep 管线 = false）。
//
//  而路由表.mjs 只回答「这个需求该派给谁」，
//  不回答「按管线，现在轮到谁了」。
//
//  所以中枢无法：
//    · 判断下一个该派给谁
//    · 检查上游产物是否就绪
//    · 按管线顺序推进
//
//  → 管线定义了，但没人真的按它调度。
//
// ══════════════════════════════════════════════════════════════════════
//  做什么
// ══════════════════════════════════════════════════════════════════════
//  读 pipeline 定义 + 产物契约 + 实际产出文件，算出：
//    ① 哪些节点的产物已就绪
//    ② 哪些节点「上游都就绪、自己还没产出」= 现在轮到它
//    ③ 哪些节点「上游没就绪」= 还得等
//
//  用法：
//    node 工具/管线调度.mjs                    # 所有管线的状态
//    node 工具/管线调度.mjs --pipeline build-software
//    node 工具/管线调度.mjs --next             # 只报「现在该派谁」
//    node 工具/管线调度.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA = path.join(WB, '数据', '.dsh');
const MEM = path.join(DATA, '场景记忆');
const PIPE_DIR = path.join(WB, 'sceneboard', 'pipelines');
const CONTRACT_FILE = path.join(DATA, '产物契约.json');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const val = (k, d) => {
  const i = argv.indexOf('--' + k);
  if (i < 0) return d;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? d : v;
};

// ⚠ 2026-11-14 改：不再硬编码场景名表，动态从 scenarios/*.json 读
//
//   原来是：
//     const SCENE_NAME = {
//       'arch-review': '架构梳理', 'build-plan': '实施计划', ...
//     };   // ← 只有 9 个
//
//   新增 3 个工坊后**两个工具都忘了更新**，导致：
//     sceneMem('backend-craft') 用 'backend-craft' 当目录名 → 读不到记忆
//     → 误判「下游未消费」
//
//   根因是**同一个事实存了两份**。唯一权威应该是 scenarios/*.json
//   里的 { id, name }。现在动态读，新增场景自动生效。
const SCENE_NAME = (() => {
  const map = {};
  try {
    const dir = path.join(WB, '外壳', 'scenarios');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (j && j.id && j.name) map[j.id] = j.name;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return map;
})();

function loadContract() {
  try {
    if (!fs.existsSync(CONTRACT_FILE)) return { artifacts: {} };
    const j = JSON.parse(fs.readFileSync(CONTRACT_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return { artifacts: j.artifacts || j };
  } catch { return { artifacts: {} }; }
}

function loadPipelines() {
  if (!fs.existsSync(PIPE_DIR)) return [];
  return fs.readdirSync(PIPE_DIR).filter((f) => f.endsWith('.json')).map((f) => {
    try { return { file: f, ...JSON.parse(fs.readFileSync(path.join(PIPE_DIR, f), 'utf8')) }; }
    catch { return null; }
  }).filter(Boolean);
}

/** 某场景的某 artifact 是否就绪 */
export function artifactStatus(contract, artifact, sceneId) {
  const entry = contract.artifacts[artifact];
  if (!entry) return { ready: 0, total: 0, unmapped: true };
  const cn = SCENE_NAME[sceneId] || sceneId;
  const dir = path.join(MEM, cn);
  const files = Array.isArray(entry.files) ? entry.files : [];
  const ready = files.filter((f) => {
    try { return fs.existsSync(path.join(dir, f)); } catch { return false; }
  });
  return { ready: ready.length, total: files.length, files, readyFiles: ready };
}

/** 算一条管线的节点状态 */
export function pipelineStatus(pipeline, contract) {
  const nodes = (pipeline.nodes || []).map((n) => n.scene);
  const edges = pipeline.edges || [];

  const status = nodes.map((sceneId) => {
    // 该节点的「上游边」
    const inEdges = edges.filter((e) => e.to === sceneId);
    // 该节点的「下游边」（它要产出什么）
    const outEdges = edges.filter((e) => e.from === sceneId);

    // 上游是否全就绪
    const upstream = inEdges.map((e) => {
      const st = artifactStatus(contract, e.artifact, e.from);
      return { from: e.from, artifact: e.artifact, ...st, isReady: st.total > 0 && st.ready === st.total };
    });
    const upstreamReady = upstream.length === 0 || upstream.every((u) => u.isReady);

    // 自己的产出是否就绪
    const outputs = outEdges.map((e) => {
      const st = artifactStatus(contract, e.artifact, sceneId);
      return { artifact: e.artifact, ...st, isReady: st.total > 0 && st.ready === st.total };
    });
    const outputsReady = outputs.length > 0 && outputs.every((o) => o.isReady);

    return {
      scene: sceneId,
      sceneCn: SCENE_NAME[sceneId] || sceneId,
      upstream,
      upstreamReady,
      outputs,
      outputsReady,
      isStart: inEdges.length === 0,
    };
  });

  // 判定：现在轮到谁
  //   条件：上游全就绪 且 自己产出还没全就绪
  const ready = status.filter((s) => s.upstreamReady && !s.outputsReady);
  const done = status.filter((s) => s.outputsReady);
  const blocked = status.filter((s) => !s.upstreamReady);

  return { status, ready, done, blocked };
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  管线调度 · 自测');
  console.log('='.repeat(72));
  console.log();

  const contract = loadContract();
  const pipes = loadPipelines();

  console.log('【一】数据可读');
  chk('契约表可读', !!contract.artifacts);
  chk('管线可读', pipes.length > 0, pipes.length + ' 条');
  chk('契约表非空', Object.keys(contract.artifacts).length > 0, Object.keys(contract.artifacts).length + ' 个 artifact');

  console.log();
  console.log('【二】artifactStatus 判据');
  {
    const a = Object.keys(contract.artifacts)[0];
    const entry = contract.artifacts[a];
    const st = artifactStatus(contract, a, entry.scene);
    chk('能算 artifact 状态', typeof st.ready === 'number' && typeof st.total === 'number',
      st.ready + '/' + st.total);
    chk('已填 files 的 artifact total > 0', st.total > 0, String(st.total));

    // 反例：不存在的 artifact 必须报告 unmapped
    const st2 = artifactStatus(contract, '__nonexistent_artifact__', 'research');
    chk('反例：不存在的 artifact 标记 unmapped', st2.unmapped === true,
      st2.unmapped ? '正确' : '没标记');
  }

  console.log();
  console.log('【三】pipelineStatus 判据');
  {
    const p = pipes[0];
    const ps = pipelineStatus(p, contract);
    chk('能算出节点状态', ps.status.length === (p.nodes || []).length,
      ps.status.length + ' 个节点');
    chk('ready+done+blocked 覆盖全部节点',
      ps.ready.length + ps.done.length + ps.blocked.length === ps.status.length,
      ps.ready.length + '+' + ps.done.length + '+' + ps.blocked.length + ' = ' + ps.status.length);

    // 反例：如果某节点上游没就绪，它必须在 blocked 或不在 ready
    const blockedNodes = ps.blocked.map((x) => x.scene);
    for (const b of blockedNodes) {
      chk('反例：' + b + ' 上游未就绪，不能出现在 ready',
        !ps.ready.some((r) => r.scene === b), '正确');
    }
  }

  console.log();
  console.log('【四】反例：空管线必须返回空状态');
  {
    const empty = { nodes: [], edges: [] };
    const ps = pipelineStatus(empty, contract);
    chk('空管线 status 为空', ps.status.length === 0);
    chk('空管线 ready 为空', ps.ready.length === 0);
  }

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('='.repeat(72));
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { selftest(); return; }

  const only = val('pipeline', null);
  const justNext = has('next');

  const contract = loadContract();
  let pipes = loadPipelines();
  if (only) pipes = pipes.filter((p) => p.id === only || p.name === only);

  if (!pipes.length) { console.log('没有管线'); process.exit(2); }

  console.log('='.repeat(78));
  console.log('  管线调度 —— 现在轮到谁了');
  console.log('='.repeat(78));
  console.log();

  const allNext = [];

  for (const p of pipes) {
    const ps = pipelineStatus(p, contract);

    if (!justNext) {
      console.log('  ── ' + (p.name || p.id) + ' ──');
      console.log();
      for (const s of ps.status) {
        let mark = '·';
        let state = '';
        if (s.outputsReady) { mark = '✓'; state = '已完成'; }
        else if (!s.upstreamReady) { mark = '⏸'; state = '等上游'; }
        else { mark = '▶'; state = '轮到它'; }

        console.log('    ' + mark + ' ' + s.sceneCn.padEnd(10) + state);
        if (!s.upstreamReady) {
          for (const u of s.upstream.filter((x) => !x.isReady)) {
            console.log('        等 ' + (SCENE_NAME[u.from] || u.from) + ' 的 ' + u.artifact +
              ' (' + (u.unmapped ? '契约未定义' : u.ready + '/' + u.total) + ')');
          }
        }
        if (s.outputs.length) {
          for (const o of s.outputs) {
            console.log('        产出 ' + o.artifact + ': ' +
              (o.unmapped ? '⚠ 契约未定义' : (o.ready + '/' + o.total +
                (o.readyFiles && o.readyFiles.length ? ' (' + o.readyFiles.slice(0, 2).join(',') + (o.readyFiles.length > 2 ? '…' : '') + ')' : ''))));
          }
        }
      }
      console.log();
    }

    for (const r of ps.ready) allNext.push({ pipeline: p.name || p.id, ...r });
  }

  console.log('-'.repeat(78));
  if (allNext.length) {
    console.log('  ▶ 现在该派:');
    for (const n of allNext) {
      console.log('    · ' + n.sceneCn + '（' + n.scene + '）  —— 管线「' + n.pipeline + '」');
      for (const o of n.outputs) {
        console.log('        它该产出: ' + o.artifact + (o.unmapped ? '（⚠ 契约未定义）' : ''));
      }
    }
  } else {
    console.log('  ✓ 所有节点都已完成，或都在等上游');
  }
  console.log('='.repeat(78));
}

main();
