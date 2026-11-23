/**
 * 给 12 个场景加「领域」，并让 NEURON.json 带上它。
 *
 * 为什么现在加：hermes 的星图按 category 聚类成球。我们之前缺领域层，
 * 星图会糊成一团。有了 domain，12 场景自动分成 6 个球。
 *
 * 单一权威源原则：domain 只写进 外壳/scenarios/<id>.json（场景身份所在），
 * NEURON.json 由 integrate-neuron.mjs 从源重新生成，不许两边手写。
 *
 * 用法：node assign-domains.mjs [--check]
 */

import fs from 'node:fs';
import path from 'node:path';

const SCENES = 'D:/file/AI Temp/DeepSeek/Agent自研/workbench/外壳/scenarios';

// 领域划分依据：场景在「输入→加工→产出」链上的职责位置，不是字面分类。
const DOMAINS = {
  hub: '中枢',
  research: '调研',
  'competitor-analyze': '调研',
  'reverse-eng': '调研',
  'arch-review': '设计',
  'build-plan': '设计',
  'backend-craft': '实现',
  'frontend-craft': '实现',
  'tool-forge': '实现',
  'self-review': '质量',
  'incident-analysis': '运维',
  'pc-cleanup': '运维',
};

const check = process.argv.includes('--check');
const files = fs.readdirSync(SCENES).filter((f) => f.endsWith('.json'));
let changed = 0;
const problems = [];

for (const f of files) {
  const id = f.replace(/\.json$/, '');
  const p = path.join(SCENES, f);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));

  if (!DOMAINS[id]) { problems.push('场景 ' + id + ' 没有分配领域'); continue; }
  if (j.id !== id) problems.push(f + ' 的 id 字段是 ' + j.id + '，与文件名不符');

  if (j.domain === DOMAINS[id]) continue;
  if (check) { problems.push(id + ' 缺 domain（应为 ' + DOMAINS[id] + '）'); continue; }

  // domain 放在 role 之后，保持文件可读顺序
  const out = {};
  for (const k of Object.keys(j)) {
    out[k] = j[k];
    if (k === 'role') out.domain = DOMAINS[id];
  }
  if (!out.domain) out.domain = DOMAINS[id];
  fs.writeFileSync(p, JSON.stringify(out, null, 2) + '\n', 'utf8');
  changed++;
}

if (check) {
  if (problems.length) {
    console.log('  ✗ 领域检查失败：');
    for (const p of problems) console.log('    · ' + p);
    process.exit(1);
  }
  const dist = {};
  for (const id of Object.keys(DOMAINS)) dist[DOMAINS[id]] = (dist[DOMAINS[id]] || 0) + 1;
  console.log('  ✓ 领域齐备：' + files.length + ' 个场景 → ' + Object.keys(dist).length + ' 个领域');
  for (const [k, v] of Object.entries(dist)) console.log('    ' + k.padEnd(8) + v + ' 个场景');
  process.exit(0);
}

console.log('  ✓ 写入完成：改动 ' + changed + ' 个场景文件');
const dist = {};
for (const id of Object.keys(DOMAINS)) dist[DOMAINS[id]] = (dist[DOMAINS[id]] || 0) + 1;
for (const [k, v] of Object.entries(dist)) console.log('    ' + k.padEnd(8) + v);
