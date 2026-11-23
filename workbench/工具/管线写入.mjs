// 把管线关系写进各场景记忆（让每个场景知道自己该等谁、该给谁）
import fs from 'node:fs';
import path from 'node:path';

const WB = 'D:/file/AI Temp/DeepSeek/Agent自研/workbench';
const DATA = path.join(WB, '数据', '.dsh');
const MEM = path.join(DATA, '场景记忆');

// ══════════════════════════════════════════════════════════════════════
//  ★ 2026-11-12 新增：产物契约表
//
//  为什么需要：
//    pipeline 的 edges 里写的是抽象契约名（competitor-list / feature-matrix），
//    但下游真正要找的是具体文件（项目功能矩阵.md / 机制体系索引.md）。
//
//    实测：修复前生成的下游记忆只有
//      | 调研 | `reference-index` | 造一个软件 |
//    ——「reference-index」是个抽象名，下游不知道去哪里找，
//      所以 9 条边里「下游真的引用了上游产出」的 = 0 条。
//
//  修法：读 数据/.dsh/产物契约.json，把抽象名解析成实际文件清单，
//        并在下游记忆里写明「具体文件 + 是否就绪」。
// ══════════════════════════════════════════════════════════════════════
const CONTRACT_FILE = path.join(DATA, '产物契约.json');
let CONTRACT = { artifacts: {} };
try {
  if (fs.existsSync(CONTRACT_FILE)) {
    const raw = JSON.parse(fs.readFileSync(CONTRACT_FILE, 'utf8').replace(/^\uFEFF/, ''));
    CONTRACT = { artifacts: raw.artifacts || raw };
  }
} catch (e) { /* ignore */ }

/** 把 artifact 抽象名解析成 { files: [], ready: n, total: n } */
function resolveArtifact(artifact, fromSceneId) {
  const entry = CONTRACT.artifacts[artifact];
  if (!entry) return { files: [], ready: 0, total: 0, unmapped: true };
  const sceneCn = NAME[fromSceneId] || fromSceneId;
  const dir = path.join(MEM, sceneCn);
  const files = Array.isArray(entry.files) ? entry.files : [];
  const ready = files.filter((f) => { try { return fs.existsSync(path.join(dir, f)); } catch { return false; } });
  return { files, ready: ready.length, total: files.length, unmapped: false };
}

const PIPE_DIR = path.join(WB, 'sceneboard', 'pipelines');

// scene id → 中文场景名
const NAME = {
  research: '调研',
  'competitor-analyze': '竞品拆解',
  'reverse-eng': '逆向分析',
  'arch-review': '架构梳理',
  'build-plan': '实施计划',
  'pc-cleanup': '本地电脑',
  'incident-analysis': '故障分析',
  'self-review': '自我复盘',
  hub: '中枢',
};

// ① 从所有管线里收集「每个场景的上游/下游」
const upstream = {};   // scene → [{from, artifact, pipeline}]
const downstream = {}; // scene → [{to, artifact, pipeline}]

for (const f of fs.readdirSync(PIPE_DIR).filter((x) => x.endsWith('.json'))) {
  const p = JSON.parse(fs.readFileSync(path.join(PIPE_DIR, f), 'utf8'));
  const pname = p.name || p.id;
  for (const e of p.edges || []) {
    if (!upstream[e.to]) upstream[e.to] = [];
    upstream[e.to].push({ from: e.from, artifact: e.artifact, pipeline: pname });
    if (!downstream[e.from]) downstream[e.from] = [];
    downstream[e.from].push({ to: e.to, artifact: e.artifact, pipeline: pname });
  }
}

console.log('=== 收集到的管线关系 ===');
for (const sc of Object.keys(upstream)) {
  console.log('  ' + (NAME[sc] || sc));
  for (const u of upstream[sc]) {
    console.log('      上游 ← ' + (NAME[u.from] || u.from) + '  产物: ' + u.artifact + '  (' + u.pipeline + ')');
  }
}
console.log();
for (const sc of Object.keys(downstream)) {
  console.log('  ' + (NAME[sc] || sc));
  for (const d of downstream[sc]) {
    console.log('      下游 → ' + (NAME[d.to] || d.to) + '  产物: ' + d.artifact + '  (' + d.pipeline + ')');
  }
}

// ② 写进每个场景的记忆
console.log();
console.log('=== 写入场景记忆 ===');

const MARK_BEGIN = '<!-- pipeline:begin -->';
const MARK_END = '<!-- pipeline:end -->';

for (const sc of new Set([...Object.keys(upstream), ...Object.keys(downstream)])) {
  const name = NAME[sc];
  if (!name) { console.log('  ⚠ 未知场景: ' + sc); continue; }
  const memFile = path.join(MEM, name, '场景私有记忆.md');
  if (!fs.existsSync(memFile)) { console.log('  ✗ ' + name + ' 无记忆文件'); continue; }

  let content = fs.readFileSync(memFile, 'utf8');

  // 造区块
  const out = ['', MARK_BEGIN, '## 管线位置（自动生成，勿手改）', ''];
  out.push('> 这一节由 `工具/管线写入.mjs` 从 `sceneboard/pipelines/*.json` 生成。');
  out.push('> 作用是让我知道自己在这个管线里的位置：该等谁、该给谁。');
  out.push('');

  const ups = upstream[sc] || [];
  const downs = downstream[sc] || [];
  if (ups.length) {
    out.push('**上游（我要等）**');
    out.push('');
    out.push('| 来自 | 产物契约 | 具体文件 | 就绪 | 管线 |');
    out.push('|---|---|---|---|---|');
    for (const u of ups) {
      const r = resolveArtifact(u.artifact, u.from);
      const fileCell = r.unmapped
        ? '⚠ 契约表未定义'
        : (r.files.length ? r.files.map((f) => '`' + f + '`').join('<br>') : '（未填）');
      const readyCell = r.unmapped ? '?' : (r.total === 0 ? '?' : (r.ready + '/' + r.total));
      out.push('| ' + (NAME[u.from] || u.from) + ' | `' + u.artifact + '` | ' + fileCell + ' | ' + readyCell + ' | ' + u.pipeline + ' |');
    }
    out.push('');
    // 就绪提示
    const notReady = ups.filter((u) => { const r = resolveArtifact(u.artifact, u.from); return !r.unmapped && r.total > 0 && r.ready < r.total; });
    if (notReady.length) {
      out.push('> ⚠ **上游还没全部就绪**：' + notReady.map((u) => (NAME[u.from] || u.from) + ' 的 `' + u.artifact + '`').join('、') + ' 尚未产出。');
      out.push('> 拿不到产物就说明还没轮到我 —— 不要硬做。');
      out.push('');
    } else {
      out.push('> ✓ **上游已就绪** —— 可以直接开始。');
      out.push('');
    }
  }
  if (downs.length) {
    out.push('**下游（我该给）**');
    out.push('');
    out.push('| 给谁 | 产物契约 | 该交的文件 | 管线 |');
    out.push('|---|---|---|---|');
    for (const d of downs) {
      const r = resolveArtifact(d.artifact, sc);
      const fileCell = r.unmapped
        ? '⚠ 契约表未定义'
        : (r.files.length ? r.files.map((f) => '`' + f + '`').join('<br>') : '（未填）');
      out.push('| ' + (NAME[d.to] || d.to) + ' | `' + d.artifact + '` | ' + fileCell + ' | ' + d.pipeline + ' |');
    }
    out.push('');
  }
  out.push('**注意**：上游没就绪时不要硬做 —— 拿不到产物就说明还没轮到我。');
  out.push('');
  out.push(MARK_END, '');

  const block = out.join('\n');

  // 替换已有区块，或在末尾追加
  if (content.includes(MARK_BEGIN) && content.includes(MARK_END)) {
    const re = new RegExp(MARK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + MARK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    content = content.replace(re, block.trim());
    console.log('  ✓ ' + name + '  已更新管线区块');
  } else {
    content = content.trimEnd() + '\n' + block;
    console.log('  ✓ ' + name + '  已追加管线区块');
  }

  fs.writeFileSync(memFile, content, 'utf8');
}
