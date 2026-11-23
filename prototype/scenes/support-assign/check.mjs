#!/usr/bin/env node
/**
 * 场景自检：客服分派
 * 每单有 owner、owner 在值班表、无重复单
 * 契约：exit 0 = 通过；非 0 = 失败，且必须输出「差异集合」与具体项。
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const HERE = import.meta.dirname;
const DATA = process.env.SEA_DATA_DIR || join(HERE, 'data');

const FILES = {
  'tickets.json': JSON.parse(readFileSync(join(DATA, 'tickets.json'), 'utf8')),
  'roster.json': JSON.parse(readFileSync(join(DATA, 'roster.json'), 'utf8')),
};

const read = f => FILES[f];
const readJson = f => FILES[f];

function score() {
  const problems = [];
  // ------- 场景逻辑 -------

  const tickets = readJson('tickets.json');
  const roster = readJson('roster.json');
  const unassigned = tickets.filter(t => !t.assignee).map(t => t.id);
  if (unassigned.length) problems.push(`未分派 ${unassigned.length}(${unassigned.join(', ')})`);
  const notInRoster = tickets.filter(t => t.assignee && !roster.includes(t.assignee))
    .map(t => `${t.id}->${t.assignee}`);
  if (notInRoster.length) problems.push(`负责人不在值班表 ${notInRoster.length}(${notInRoster.join(', ')})`);
  const ids = tickets.map(t => t.id);
  const dups = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (dups.length) problems.push(`工单重复 ${dups.length}(${dups.join(', ')})`);

  return problems;
}

const problems = score();
if (problems.length === 0) {
  console.log(`PASS support-assign: 差异集合 = 0`);
  process.exit(0);
}
console.log(`FAIL support-assign: 差异集合 = ${problems.length} 项`);
for (const p of problems) console.log(`  - ${p}`);
process.exit(1);
