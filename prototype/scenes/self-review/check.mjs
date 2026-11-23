import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA = process.env.SEA_DATA_DIR || join(import.meta.dirname, 'data');
const profiles = JSON.parse(readFileSync(join(DATA, 'profiles.json'), 'utf8'));
const indexed = JSON.parse(readFileSync(join(DATA, 'indexed.json'), 'utf8'));

const problems = [];

// completeness：每份档案都必须被索引（否则 AI 找不到它）
const names = profiles.map(p => p.name);
const missing = names.filter(n => !indexed.includes(n));
if (missing.length) problems.push(`未登记的档案 ${missing.length}(${missing.join(', ')})`);

// completeness 反向：索引不得指向不存在的档案（幽灵）
const ghost = indexed.filter(i => !names.includes(i));
if (ghost.length) problems.push(`索引指向不存在的档案 ${ghost.length}(${ghost.join(', ')})`);

// required-field：档案名不得为空
const noName = profiles.filter(p => !p.name || String(p.name).trim() === '');
if (noName.length) problems.push(`档案缺名称 ${noName.length}(第 ${noName.map((_, i) => i + 1).join(', ')} 项)`);

// uniqueness：档案名不得重复
const dup = [...new Set(indexed.filter((x, i) => indexed.indexOf(x) !== i))];
if (dup.length) problems.push(`索引重复 ${dup.length}(${dup.join(', ')})`);

if (problems.length === 0) {
  console.log('PASS self-review: 差异集合 = 0');
  process.exit(0);
}
console.log(`FAIL self-review: 差异集合 = ${problems.length} 项`);
for (const p of problems) console.log(`  - ${p}`);
process.exit(1);