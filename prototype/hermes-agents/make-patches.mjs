/**
 * 生成 hermes 侧改动的补丁集，存进我们的仓库。
 *
 * 为什么这样做：C:\hermes 不是 git 仓（是解压的上游源码），所以「全部改动进 git」
 * 只能以**补丁**形式落在我们自己的仓里。这也正是「在 hermes 上衍生」的正确形态：
 * 上游保持原样，我们的东西是一层可审查、可重放、可回退的补丁。
 *
 * 产出：
 *   hermes-patches/agent/neuron_graph.py            新增文件（完整）
 *   hermes-patches/agent/learning_graph.py.patch    对上游的 unified diff
 *   hermes-patches/apply.mjs                        应用/校验
 *   hermes-patches/README.md                        说明
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// 外部仓库位置（不是 git 仓，是解压的上游源码）—— 可覆盖，别写死
const HERMES = process.env.HERMES_SRC || 'C:/hermes';
const REPO = path.resolve(import.meta.dirname, '../..');
const PATCHES = path.join(REPO, 'hermes-patches');
const TMP = path.join(REPO, '.tmp-patch');

fs.mkdirSync(path.join(PATCHES, 'agent'), { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

// ── 1) 新增文件：直接整份复制 ──
const neuronSrc = path.join(HERMES, 'agent/neuron_graph.py');
fs.copyFileSync(neuronSrc, path.join(PATCHES, 'agent/neuron_graph.py'));
console.log('  ✓ neuron_graph.py（新增，整份）');

// ── 2) 修改文件：还原出「改前」版本，产 unified diff ──
const lgPath = path.join(HERMES, 'agent/learning_graph.py');
const after = fs.readFileSync(lgPath, 'utf8');

// 这两处是我加的全部内容，按相反方向替换即可还原上游原文。
const edits = [
  {
    // 加入口 + clusters 合并
    added: `
    # DSH 场景神经元：12 个场景 + 契约边 + 领域，与技能节点同构，直接并进同一张图。
    # 只读、失败即空层 —— 星图不能因为我们这边的数据问题而白屏。
    try:
        from agent.neuron_graph import build_neuron_layer

        neuron = build_neuron_layer()
    except Exception:
        neuron = {"nodes": [], "edges": [], "clusters": [], "stats": {}}
    for cluster in neuron.get("clusters") or []:
        clusters[str(cluster.get("category"))] += int(cluster.get("count") or 0)
`,
    original: '',
  },
  {
    // 合并输出
    added: `        "nodes": graph_nodes + list(neuron.get("nodes") or []),
        "edges": [{"source": a, "target": b} for a, b in skill_edges + memory_edges] + list(neuron.get("edges") or []),`,
    original: `        "nodes": graph_nodes,
        "edges": [{"source": a, "target": b} for a, b in skill_edges + memory_edges],`,
  },
  {
    // stats 合并
    added: `            "memory_nodes": len(memory_cards), "memory_skill_edges": len(memory_edges), "learned_skills": len(learned_skills),
            **dict(neuron.get("stats") or {}),`,
    original: `            "memory_nodes": len(memory_cards), "memory_skill_edges": len(memory_edges), "learned_skills": len(learned_skills),`,
  },
];

let before = after;
for (const e of edits) {
  if (!before.includes(e.added)) {
    console.log('  ⚠ 找不到待还原片段，补丁可能不完整：' + e.added.slice(0, 50).replace(/\n/g, ' '));
    continue;
  }
  before = before.replace(e.added, e.original);
}

const beforeF = path.join(TMP, 'learning_graph.before.py');
const afterF = path.join(TMP, 'learning_graph.after.py');
fs.writeFileSync(beforeF, before, 'utf8');
fs.writeFileSync(afterF, after, 'utf8');

let diff = '';
try {
  diff = execFileSync('git', ['diff', '--no-index', '--no-color', '-U4', beforeF, afterF], { encoding: 'utf8' });
} catch (e) {
  diff = e.stdout || '';  // git diff --no-index 有差异时退出码 1
}
// 把临时路径换成 upstream 语义路径
diff = diff
  .replace(/a\/[^\s]*learning_graph\.before\.py/g, 'a/agent/learning_graph.py')
  .replace(/b\/[^\s]*learning_graph\.after\.py/g, 'b/agent/learning_graph.py')
  .replace(/^--- .*$/m, '--- a/agent/learning_graph.py')
  .replace(/^\+\+\+ .*$/m, '+++ b/agent/learning_graph.py');

fs.writeFileSync(path.join(PATCHES, 'agent/learning_graph.py.patch'), diff, 'utf8');
const diffLines = diff.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-')).length;
console.log('  ✓ learning_graph.py.patch（' + diffLines + ' 行增删）');

fs.rmSync(TMP, { recursive: true, force: true });
console.log('');
console.log('  补丁集在 ' + PATCHES);
