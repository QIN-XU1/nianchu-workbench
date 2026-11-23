#!/usr/bin/env node
/**
 * 场景自检：数据核对
 * 两份数据记录集合与金额是否一致
 * 契约：exit 0 = 通过；非 0 = 失败，且必须输出「差异集合」与具体项。
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const HERE = import.meta.dirname;
const DATA = process.env.SEA_DATA_DIR || join(HERE, 'data');

const FILES = {
  'sourceA.json': JSON.parse(readFileSync(join(DATA, 'sourceA.json'), 'utf8')),
  'sourceB.json': JSON.parse(readFileSync(join(DATA, 'sourceB.json'), 'utf8')),
};

const read = f => FILES[f];
const readJson = f => FILES[f];

function score() {
  const problems = [];
  // ------- 场景逻辑 -------

  const a = readJson('sourceA.json');
  const b = readJson('sourceB.json');
  const aIds = a.map(r => r.id), bIds = b.map(r => r.id);
  const missing = aIds.filter(x => !bIds.includes(x));
  const extra = bIds.filter(x => !aIds.includes(x));
  if (missing.length) problems.push(`记录 id 缺失 ${missing.length}(${missing.join(', ')})`);
  if (extra.length) problems.push(`记录 id 多出 ${extra.length}(${extra.join(', ')})`);
  // 唯一性：每个集合内部 id 不得重复
  const dupA = [...new Set(aIds.filter((id, i) => aIds.indexOf(id) !== i))];
  const dupB = [...new Set(bIds.filter((id, i) => bIds.indexOf(id) !== i))];
  if (dupA.length) problems.push(`A 源 id 重复 ${dupA.length}(${dupA.join(', ')})`);
  if (dupB.length) problems.push(`B 源 id 重复 ${dupB.length}(${dupB.join(', ')})`);

  const byId = new Map(b.map(r => [r.id, r]));
  const diffs = a.filter(r => byId.has(r.id) && byId.get(r.id).amount !== r.amount)
    .map(r => `${r.id}:${r.amount}≠${byId.get(r.id).amount}`);
  if (diffs.length) problems.push(`金额不一致 ${diffs.length}(${diffs.join(', ')})`);

  return problems;
}

const problems = score();
if (problems.length === 0) {
  console.log(`PASS data-reconcile: 差异集合 = 0`);
  process.exit(0);
}
console.log(`FAIL data-reconcile: 差异集合 = ${problems.length} 项`);
for (const p of problems) console.log(`  - ${p}`);
process.exit(1);
