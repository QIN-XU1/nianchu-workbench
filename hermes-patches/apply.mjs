#!/usr/bin/env node
/**
 * 把 hermes-patches/ 应用到一份 hermes 源码树，或校验它是否已应用。
 *
 * C:\hermes 不是 git 仓（解压的上游源码），所以我们的改动只能以补丁形式存在。
 * 这个脚本负责「上游 + 补丁」这条链可重放：
 *   node apply.mjs --check [hermes根目录]   只校验，不改
 *   node apply.mjs [hermes根目录]           应用（幂等）
 *   node apply.mjs --revert [hermes根目录]  回退（只回退 learning_graph.py）
 *
 * 幂等：已打过的补丁不会重复打；新增文件已存在且内容一致就跳过。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

// import.meta.url 的 pathname 是百分号编码的（空格→%20、中文→%E8...），
// 直接用会 ENOENT。必须过 fileURLToPath 解码。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const check = args.includes('--check');
const revert = args.includes('--revert');
const root = args.find((a) => !a.startsWith('--')) || 'C:/hermes';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
let problems = 0;

// ── 新增文件：整份部署 ──
const adds = [
  ['agent/neuron_graph.py', 'agent/neuron_graph.py'],
  // 界面：空态场景入口。**整份替换**，不是 diff —— 见 README「为什么界面是整份替换」。
  ['apps/desktop/src/components/chat/intro.tsx', 'apps/desktop/src/components/chat/intro.tsx'],
  // 审批加固（A15）：四个文件都是整份替换，同样因为上游没有 git 基线可 diff。
  // 改动点见 README「审批加固」一节，每处都有注释锚点。
  ['tools/approval_context.py', 'tools/approval_context.py'],
  ['tools/approval.py', 'tools/approval.py'],
  ['tools/approval_detection.py', 'tools/approval_detection.py'],
  ['tools/terminal_tool.py', 'tools/terminal_tool.py'],
];
for (const [src, dst] of adds) {
  const s = path.join(HERE, src);
  const d = path.join(root, dst);
  const want = fs.readFileSync(s);
  const has = fs.existsSync(d) ? fs.readFileSync(d) : null;
  if (has && sha(has) === sha(want)) {
    console.log('    = ' + dst + '（已一致 ' + sha(want) + '）');
    continue;
  }
  if (check) {
    console.log('    ✗ ' + dst + (has ? '（内容不同）' : '（缺失）') + ' —— 需要应用');
    problems++;
    continue;
  }
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.writeFileSync(d, want);
  console.log('    + ' + dst + '（已写入 ' + sha(want) + '）');
}

// ── 修改文件：unified diff ──
const patches = [['agent/learning_graph.py.patch', 'agent/learning_graph.py', 'DSH 场景神经元接入点']];
for (const [pf, target, why] of patches) {
  const d = path.join(root, target);
  if (!fs.existsSync(d)) {
    console.log('    ✗ 目标不存在：' + d);
    problems++;
    continue;
  }
  const text = fs.readFileSync(d, 'utf8');
  const applied = text.includes('from agent.neuron_graph import build_neuron_layer');
  if (revert) {
    if (!applied) { console.log('    = ' + target + '（本就没应用）'); continue; }
    // 只回退这一处：把补丁涉及的行按反向还原
    let out = text
      .replace(/\n    # DSH 场景神经元[\s\S]*?clusters\[str\(cluster\.get\("category"\)\)\] \+= int\(cluster\.get\("count"\) or 0\)\n/, '\n')
      .replace('"nodes": graph_nodes + list(neuron.get("nodes") or []),', '"nodes": graph_nodes,')
      .replace('"edges": [{"source": a, "target": b} for a, b in skill_edges + memory_edges] + list(neuron.get("edges") or []),', '"edges": [{"source": a, "target": b} for a, b in skill_edges + memory_edges],')
      .replace('\n            **dict(neuron.get("stats") or {}),', '');
    fs.writeFileSync(d, out, 'utf8');
    console.log('    - ' + target + '（已回退）');
    continue;
  }
  if (applied) {
    console.log('    = ' + target + '（已应用：' + why + '）');
    continue;
  }
  if (check) {
    console.log('    ✗ ' + target + '（未应用：' + why + '）');
    problems++;
    continue;
  }
  try {
    execFileSync('git', ['apply', '--directory=' + root.replace(/\\/g, '/'), '--unsafe-paths', path.join(HERE, pf)], { cwd: root, stdio: 'pipe' });
    console.log('    + ' + target + '（已打补丁）');
  } catch (e) {
    console.log('    ✗ ' + target + ' 打补丁失败：' + String(e.stderr || e.message).slice(0, 200));
    problems++;
  }
}

console.log('');
if (check) {
  console.log(problems ? '  结论：还有 ' + problems + ' 处未应用' : '  结论：补丁集已全部应用');
} else {
  console.log(problems ? '  结论：' + problems + ' 处失败' : '  结论：补丁集已就位');
}
process.exit(problems ? 1 : 0);
