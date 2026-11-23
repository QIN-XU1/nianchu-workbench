/**
 * Sceneflow —— 场景数据管线引擎（零依赖）
 *
 * 解决的问题：
 *   现有"跨场景协作"只是往对方的记忆文件贴一行字（留言板），
 *   下游场景不知道上游产出了什么、格式是什么、能不能用。
 *
 * 本引擎把场景之间的连接变成真正的数据管线：
 *   场景产出「产物」→ 下游按契约领取 → 用完标记 → 全程可追溯
 *
 * 借鉴：
 *   · Airflow 的 DAG：任务有上游/下游，产物通过 XCom 传递
 *   · Temporal 的 Event History：存事件序列而不是当前状态，可重放
 *
 * 存储（全是文件，无数据库）：
 *   <workbench>/产物/
 *     index.json                    产物总索引（可重建）
 *     events.jsonl                  事件流（唯一真相来源）
 *     <artifact-id>.md              产物正文
 *   <workbench>/sceneboard/
 *     scenes/<scene-id>.json        场景契约（产出什么、需要什么）
 *     pipelines/<pipeline-id>.json  管线定义（DAG）
 *
 * 使用：
 *   node 工具\sceneflow.mjs publish --scene research --id competitor-list --name 竞品清单 --type competitor-list --file xxx.md
 *   node 工具\sceneflow.mjs inbox --scene competitor-analyze
 *   node 工具\sceneflow.mjs claim --scene competitor-analyze --artifact <id>
 *   node 工具\sceneflow.mjs board
 *   node 工具\sceneflow.mjs verify
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..');

const ART_DIR = path.join(WB, '产物');
const INDEX = path.join(ART_DIR, 'index.json');
const EVENTS = path.join(ART_DIR, 'events.jsonl');
const BOARD = path.join(WB, 'sceneboard');
const SCENES_DIR = path.join(BOARD, 'scenes');
const PIPE_DIR = path.join(BOARD, 'pipelines');

const now = () => new Date().toISOString();
const shortId = () => crypto.randomUUID().slice(0, 8);

function ensureDirs() {
  for (const d of [ART_DIR, SCENES_DIR, PIPE_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
  if (!fs.existsSync(INDEX)) fs.writeFileSync(INDEX, JSON.stringify({ artifacts: [] }, null, 2), 'utf8');
  if (!fs.existsSync(EVENTS)) fs.writeFileSync(EVENTS, '', 'utf8');
}

function loadIndex() {
  ensureDirs();
  try {
    return JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  } catch {
    return { artifacts: [] };
  }
}

function saveIndex(idx) {
  fs.writeFileSync(INDEX, JSON.stringify(idx, null, 2), 'utf8');
}

/** 追加一条事件（唯一真相来源，可重放） */
function emit(type, payload) {
  ensureDirs();
  const ev = { at: now(), type, ...payload };
  fs.appendFileSync(EVENTS, JSON.stringify(ev) + '\n', 'utf8');
  return ev;
}

/** 从事件流重建索引（验证用） */
export function replay() {
  ensureDirs();
  const lines = fs.readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean);
  const artifacts = new Map();
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'publish') {
      artifacts.set(ev.artifact.id, { ...ev.artifact, consumedBy: [] });
    } else if (ev.type === 'claim') {
      const a = artifacts.get(ev.artifact);
      if (a && !a.consumedBy.includes(ev.scene)) a.consumedBy.push(ev.scene);
    } else if (ev.type === 'clean') {
      // 清理事件：从重放结果里移除该产物（否则索引与回放会不一致）
      artifacts.delete(ev.artifact);
    }
  }
  return { artifacts: [...artifacts.values()], events: lines.length };
}

/** 读场景契约 */
export function loadScene(sceneId) {
  const f = path.join(SCENES_DIR, sceneId + '.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

export function listScenes() {
  ensureDirs();
  return fs.readdirSync(SCENES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(SCENES_DIR, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

export function loadPipeline(pipeId) {
  const f = path.join(PIPE_DIR, pipeId + '.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

export function listPipelines() {
  ensureDirs();
  return fs.readdirSync(PIPE_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(PIPE_DIR, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

/**
 * 发布产物。
 * @param {object} opts
 *   scene     发布者场景 id（必填）
 *   id        产物逻辑 id（必填，如 competitor-list）
 *   name      人类可读名
 *   type      产物类型
 *   content   正文（字符串）或 file（源文件路径）
 *   to        目标场景数组（可选，默认按场景契约推导）
 */
export function publish(opts) {
  ensureDirs();
  const { scene, id, name, type, content, file, to } = opts || {};
  if (!scene) throw new Error('publish 需要 scene');
  if (!id) throw new Error('publish 需要 id');

  const artId = id + '-' + shortId();
  const body = (() => {
    if (typeof content === 'string') return content;
    if (file && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    return '';
  })();

  // 写产物正文
  const safeName = String(name || id).replace(/[\\/:*?"<>|]/g, '_');
  const fname = safeName + '-' + new Date().toISOString().slice(0, 10) + '-' + shortId() + '.md';
  const fpath = path.join(ART_DIR, fname);
  const header = [
    '# ' + (name || id),
    '',
    '- 产物 id：`' + artId + '`',
    '- 类型：`' + (type || 'generic') + '`',
    '- 来自场景：`' + scene + '`',
    '- 发布时间：' + now(),
    '',
    '---',
    '',
    ''
  ].join('\n');
  fs.writeFileSync(fpath, header + body, 'utf8');

  // 推导接收方：显式指定 > 场景契约 outputs > 全部场景
  let targets = to;
  if (!targets) {
    const sc = loadScene(scene);
    const out = (sc && sc.outputs || []).find(o => o.id === id);
    targets = (out && out.to) || [];
  }

  const artifact = {
    id: artId,
    logicalId: id,
    name: name || id,
    type: type || 'generic',
    fromScene: scene,
    toScenes: targets,
    path: path.relative(WB, fpath).replace(/\\/g, '/'),
    summary: (opts.summary || '').slice(0, 500),
    createdAt: now(),
    status: 'ready',
    consumedBy: [],
  };

  const idx = loadIndex();
  idx.artifacts.push(artifact);
  saveIndex(idx);
  emit('publish', { artifact, scene });

  return artifact;
}

/** 某场景的收件箱：所有发给它且未被它领取的产物 */
export function inbox(sceneId) {
  const idx = loadIndex();
  return idx.artifacts.filter(a =>
    a.status === 'ready' &&
    (a.toScenes || []).includes(sceneId) &&
    !(a.consumedBy || []).includes(sceneId)
  );
}

/** 某场景已拿到的全部产物（含已领取） */
export function received(sceneId) {
  const idx = loadIndex();
  return idx.artifacts.filter(a => (a.toScenes || []).includes(sceneId));
}

/** 领取产物 */
export function claim(sceneId, artifactId) {
  const idx = loadIndex();
  const a = idx.artifacts.find(x => x.id === artifactId || x.logicalId === artifactId);
  if (!a) throw new Error('找不到产物：' + artifactId);
  if (!(a.toScenes || []).includes(sceneId)) throw new Error('该产物没发给场景 ' + sceneId);
  if (!a.consumedBy.includes(sceneId)) a.consumedBy.push(sceneId);
  saveIndex(idx);
  emit('claim', { artifact: a.id, scene: sceneId });
  return a;
}

/** 读产物正文 */
export function readArtifact(artifactId) {
  const idx = loadIndex();
  const a = idx.artifacts.find(x => x.id === artifactId || x.logicalId === artifactId);
  if (!a) throw new Error('找不到产物：' + artifactId);
  const f = path.join(WB, a.path);
  if (!fs.existsSync(f)) throw new Error('产物文件不存在：' + a.path);
  return { artifact: a, content: fs.readFileSync(f, 'utf8') };
}

/**
 * 管线进度：按 DAG 算每个节点能不能开始
 */
export function pipelineStatus(pipeId) {
  const pipe = loadPipeline(pipeId);
  if (!pipe) throw new Error('找不到管线：' + pipeId);
  const idx = loadIndex();

  const nodes = {};
  for (const n of pipe.nodes || []) {
    nodes[n.scene] = { ...n, inputs: [], ready: false, done: false };
  }

  for (const e of pipe.edges || []) {
    const arts = idx.artifacts.filter(a => a.fromScene === e.from && a.logicalId === e.artifact);
    if (nodes[e.to]) {
      nodes[e.to].inputs.push({
        from: e.from,
        artifact: e.artifact,
        satisfied: arts.length > 0,
        count: arts.length,
      });
    }
  }

  // 入边全部满足 => ready
  for (const s of Object.keys(nodes)) {
    const n = nodes[s];
    n.ready = n.inputs.every(i => i.satisfied);
    const upstairsDone = n.inputs.every(i => {
      // 上游是否已被本场景领取（视为"已消费"）
      const arts = idx.artifacts.filter(a => a.fromScene === i.from && a.logicalId === i.artifact);
      return arts.some(a => a.consumedBy.includes(s));
    });
    n.done = n.inputs.length > 0 && upstairsDone;
  }

  // 拓扑：BFS 从入度为 0 的节点
  const order = [];
  const indeg = {};
  for (const s of Object.keys(nodes)) indeg[s] = 0;
  for (const e of pipe.edges || []) if (nodes[e.to]) indeg[e.to] = (indeg[e.to] || 0) + 1;
  const q = Object.keys(nodes).filter(s => indeg[s] === 0);
  const seen = new Set();
  while (q.length) {
    const s = q.shift();
    if (seen.has(s)) continue;
    seen.add(s);
    order.push(s);
    for (const e of pipe.edges || []) {
      if (e.from === s && nodes[e.to]) {
        indeg[e.to]--;
        if (indeg[e.to] === 0) q.push(e.to);
      }
    }
  }
  const cycle = Object.keys(nodes).length !== order.length;

  return { pipeline: pipe, nodes, order, cycle };
}

// ---------------- CLI ----------------
const isMain = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch { return false; }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'help';
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || '') : ''; };
  const has = (k) => argv.includes(k);

  const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

  try {
    if (cmd === 'publish') {
      const a = publish({
        scene: val('--scene'),
        id: val('--id'),
        name: val('--name') || val('--id'),
        type: val('--type') || 'generic',
        content: val('--body') || undefined,
        file: val('--file') || undefined,
        summary: val('--summary') || '',
        to: val('--to') ? val('--to').split(',').map(s => s.trim()) : undefined,
      });
      console.log(C.green + 'OK' + C.reset + ' 已发布 ' + a.id);
      console.log('   ' + a.path);
      if (a.toScenes.length) console.log('   -> ' + a.toScenes.join(', '));
      else console.log('   ' + C.yellow + '!( 没有已知接收方：请在场景契约里定义 outputs.to，或用 --to 指定' + C.reset);
      process.exit(0);
    }

    if (cmd === 'inbox') {
      const scene = val('--scene');
      const list = inbox(scene);
      if (!list.length) { console.log('（收件箱为空）'); process.exit(0); }
      console.log(C.bold + scene + ' 的收件箱（' + list.length + '）' + C.reset);
      for (const a of list) {
        console.log('  - ' + a.id);
        console.log('    ' + a.name + '  [' + a.type + ']  来自 ' + a.fromScene + '  ' + C.dim + a.path + C.reset);
      }
      process.exit(0);
    }

    if (cmd === 'received') {
      const scene = val('--scene');
      const list = received(scene);
      if (!list.length) { console.log('（还没有收到任何产物）'); process.exit(0); }
      for (const a of list) {
        const claimed = (a.consumedBy || []).includes(scene);
        console.log('  ' + (claimed ? C.green + '[已领]' + C.reset : C.yellow + '[未领]' + C.reset) + ' ' + a.id + '  ' + a.name);
      }
      process.exit(0);
    }

    if (cmd === 'claim') {
      const a = claim(val('--scene'), val('--artifact'));
      console.log(C.green + 'OK' + C.reset + ' ' + val('--scene') + ' 已领取 ' + a.id);
      process.exit(0);
    }

    if (cmd === 'read') {
      const r = readArtifact(val('--artifact'));
      console.log(r.content);
      process.exit(0);
    }

    if (cmd === 'board') {
      const idx = loadIndex();
      const scenes = listScenes();
      const pipes = listPipelines();
      console.log(C.bold + '场景数据管线总览' + C.reset + C.dim + '  ' + now() + C.reset);
      console.log();
      console.log('场景 ' + scenes.length + ' 个：');
      for (const s of scenes) {
        const inb = inbox(s.id).length;
        const rec = received(s.id).length;
        const outs = (s.outputs || []).length;
        console.log('  ' + s.id.padEnd(22) + ' 产出 ' + String(outs).padStart(2) + ' 项  收件箱 ' +
          (inb > 0 ? C.yellow + inb + C.reset : '0') + '  已收 ' + rec);
      }
      console.log();
      console.log('产物 ' + idx.artifacts.length + ' 个：');
      for (const a of idx.artifacts.slice(-8)) {
        const n = (a.consumedBy || []).length;
        console.log('  ' + a.id.padEnd(28) + ' ' + a.name.padEnd(18) + ' -> ' + (a.toScenes.join(',') || '(无)').padEnd(24) + ' 已领 ' + n);
      }
      if (pipes.length) {
        console.log();
        console.log('管线 ' + pipes.length + ' 条：');
        for (const p of pipes) {
          const st = pipelineStatus(p.id);
          console.log('  ' + p.id.padEnd(22) + ' ' + p.name + '  ' + p.nodes.length + ' 节点  就绪 ' +
            Object.values(st.nodes).filter(n => n.ready).length + '  完成 ' +
            Object.values(st.nodes).filter(n => n.done).length);
        }
      }
      process.exit(0);
    }

    if (cmd === 'pipe') {
      const st = pipelineStatus(val('--id'));
      console.log(C.bold + st.pipeline.name + C.reset + '  (' + st.pipeline.id + ')');
      if (st.cycle) console.log(C.red + '! 管线有环（DAG 不允许）' + C.reset);
      console.log();
      console.log('执行顺序：' + st.order.join(' -> '));
      console.log();
      for (const s of st.order) {
        const n = st.nodes[s];
        const mark = n.done ? C.green + 'DONE' + C.reset : (n.ready ? C.yellow + 'READY' + C.reset : C.dim + 'WAIT' + C.reset);
        console.log('  [' + mark + '] ' + s.padEnd(24) + (n.role || ''));
        for (const i of n.inputs) {
          console.log('        <- ' + i.from + '.' + i.artifact + '  ' + (i.satisfied ? C.green + 'ok' + C.reset : C.red + '缺少' + C.reset));
        }
      }
      process.exit(0);
    }

    if (cmd === 'verify') {
      const idx = loadIndex();
      const rebuilt = replay();
      let bad = 0;
      const problems = [];

      // 1 索引 vs 事件重放一致
      const idxIds = idx.artifacts.map(a => a.id).sort().join(',');
      const repIds = rebuilt.artifacts.map(a => a.id).sort().join(',');
      if (idxIds !== repIds) {
        problems.push('索引与事件流不一致（索引 ' + idx.artifacts.length + ' 条，重放 ' + rebuilt.artifacts.length + ' 条）');
        bad++;
      }

      // 2 每个产物文件存在
      for (const a of idx.artifacts) {
        const f = path.join(WB, a.path);
        if (!fs.existsSync(f)) {
          problems.push('产物文件缺失：' + a.id + ' -> ' + a.path);
          bad++;
        }
      }

      // 3 每条管线是 DAG
      for (const p of listPipelines()) {
        const st = pipelineStatus(p.id);
        if (st.cycle) {
          problems.push('管线有环：' + p.id);
          bad++;
        }
        // 4 边的两端场景必须存在
        for (const e of p.edges || []) {
          if (!loadScene(e.from)) { problems.push('管线 ' + p.id + ' 引用未知场景 from=' + e.from); bad++; }
          if (!loadScene(e.to)) { problems.push('管线 ' + p.id + ' 引用未知场景 to=' + e.to); bad++; }
        }
      }

      // 5 场景契约的 outputs.to 必须指向已注册场景
      for (const s of listScenes()) {
        for (const o of s.outputs || []) {
          for (const t of o.to || []) {
            if (!loadScene(t)) { problems.push('场景 ' + s.id + ' 的产物 ' + o.id + ' 指向未知场景 ' + t); bad++; }
          }
        }
      }

      if (bad === 0) {
        console.log(C.green + 'OK 校验通过' + C.reset + '  （产物 ' + idx.artifacts.length + '，事件 ' + rebuilt.events + '，场景 ' + listScenes().length + '，管线 ' + listPipelines().length + '）');
        process.exit(0);
      } else {
        console.log(C.red + 'X 校验失败：' + bad + ' 项问题' + C.reset);
        for (const p of problems) console.log('  · ' + p);
        process.exit(2);
      }
    }

    // help
    console.log('Sceneflow —— 场景数据管线');
    console.log();
    console.log('  publish  --scene <id> --id <逻辑id> --name <名> [--type T] [--file F|--body B] [--to a,b]');
    console.log('  inbox    --scene <id>');
    console.log('  received --scene <id>');
    console.log('  claim    --scene <id> --artifact <id>');
    console.log('  read     --artifact <id>');
    console.log('  board');
    console.log('  pipe     --id <pipeline-id>');
    console.log('  verify');
    process.exit(0);
  } catch (e) {
    console.error(C.red + 'ERROR ' + C.reset + (e && e.message));
    process.exit(1);
  }
}
