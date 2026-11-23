#!/usr/bin/env node
/**
 * 场景自检：文档一致性
 * 术语是否出现、有无未登记缩写
 * 契约：exit 0 = 通过；非 0 = 失败，且必须输出「差异集合」与具体项。
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const HERE = import.meta.dirname;
const DATA = process.env.SEA_DATA_DIR || join(HERE, 'data');

const FILES = {
  'glossary.json': JSON.parse(readFileSync(join(DATA, 'glossary.json'), 'utf8')),
  'doc.txt': readFileSync(join(DATA, 'doc.txt'), 'utf8'),
};

const read = f => FILES[f];
const readJson = f => FILES[f];

function score() {
  const problems = [];
  // ------- 场景逻辑 -------

  const glossary = readJson('glossary.json');
  const doc = read('doc.txt');
  const missing = glossary.filter(t => !doc.includes(t));
  if (missing.length) problems.push(`术语未在正文出现 ${missing.length}(${missing.join(', ')})`);
  const caps = [...new Set(doc.match(/\b[A-Z]{2,5}\b/g) || [])];
  const unreg = caps.filter(w => !glossary.includes(w));
  if (unreg.length) problems.push(`未登记缩写 ${unreg.length}(${unreg.join(', ')})`);

  return problems;
}

const problems = score();
if (problems.length === 0) {
  console.log(`PASS doc-consistency: 差异集合 = 0`);
  process.exit(0);
}
console.log(`FAIL doc-consistency: 差异集合 = ${problems.length} 项`);
for (const p of problems) console.log(`  - ${p}`);
process.exit(1);
