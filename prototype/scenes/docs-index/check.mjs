import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA = process.env.SEA_DATA_DIR || join(import.meta.dirname, 'data');
const docs = JSON.parse(readFileSync(join(DATA, 'docs.json'), 'utf8'));
const indexed = JSON.parse(readFileSync(join(DATA, 'indexed.json'), 'utf8'));

const problems = [];

const missing = docs.filter(d => !indexed.includes(d));
if (missing.length) problems.push(`未登记文档 ${missing.length}(${missing.join(', ')})`);

const ghost = indexed.filter(i => !docs.includes(i));
if (ghost.length) problems.push(`索引指向不存在的文档 ${ghost.length}(${ghost.join(', ')})`);

const dup = [...new Set(indexed.filter((x, i) => indexed.indexOf(x) !== i))];
if (dup.length) problems.push(`索引重复 ${dup.length}(${dup.join(', ')})`);

if (problems.length === 0) {
  console.log('PASS docs-index: 差异集合 = 0');
  process.exit(0);
}
console.log(`FAIL docs-index: 差异集合 = ${problems.length} 项`);
for (const p of problems) console.log(`  - ${p}`);
process.exit(1);