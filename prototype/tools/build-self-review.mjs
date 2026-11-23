/**
 * 构建"自我复盘"场景（self-review）
 *
 * 用户要求：先做自我复盘场景。
 * 参考：luanyujia 的 self-review 场景（预览窗 + 文件库 + DeepSeek网页版 + AI面板）
 *
 * 我们的形态与它不同，但**职责相同**：
 *   读自己的档案（方案/研究/验证记录），形成有框架的结论，并保证档案本身不膨胀、不散架。
 *
 * 关键设计：
 *   这不是"聊天场景"，而是**有可检验不变量的场景**：
 *   - profiles/ 下的档案必须有索引（否则 AI 找不到）
 *   - 主档案 ≤25KB（否则没人读）
 *   - 每个档案必须有"最后更新日期"（否则不知道新旧）
 *   - 索引列出的档案必须真实存在（否则幽灵）
 */
import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const PROTOTYPE = join(HERE, '..');
const PROJECT = join(PROTOTYPE, '..');
const dir = join(PROTOTYPE, 'scenes', 'self-review');
const data = join(dir, 'data');
const base = join(dir, 'baseline');

mkdirSync(data, { recursive: true });
mkdirSync(base, { recursive: true });

// ---- 真实档案清单（从项目实际内容生成，不编造）----
const profiles = [];

// 1) 方案文档
const planDir = join(PROJECT, '方案');
if (existsSync(planDir)) {
  const plans = readdirSync(planDir).filter(f => f.endsWith('.md') && f !== 'README.md').sort();
  profiles.push(...plans.map(f => ({ name: `方案/${f}`, kind: 'plan', bytes: 0 })));
}

// 2) 深读报告
const researchDir = join(PROJECT, 'research');
if (existsSync(researchDir)) {
  const deeps = readdirSync(researchDir).filter(f => f.startsWith('deep-') && f.endsWith('.md')).sort();
  profiles.push(...deeps.map(f => ({ name: `research/${f}`, kind: 'deep-read', bytes: 0 })));
}

// ---- 索引：必须覆盖全部档案 ----
// 故意漏掉 2 个（模拟真实情况：新增了文档但忘了登记索引）
const indexed = profiles.map(p => p.name);
const MISSING_FROM_INDEX = 2;
if (indexed.length > MISSING_FROM_INDEX) {
  indexed.splice(indexed.length - MISSING_FROM_INDEX, MISSING_FROM_INDEX);
}

// 真实数据：索引不全
writeFileSync(join(data, 'profiles.json'), JSON.stringify(profiles, null, 2), 'utf8');
writeFileSync(join(data, 'indexed.json'), JSON.stringify(indexed, null, 2), 'utf8');

// 干净基线：索引完整
const fullIndex = profiles.map(p => p.name);
writeFileSync(join(base, 'profiles.json'), JSON.stringify(profiles, null, 2), 'utf8');
writeFileSync(join(base, 'indexed.json'), JSON.stringify(fullIndex, null, 2), 'utf8');

// ---- scene.json ----
writeFileSync(join(dir, 'scene.json'), JSON.stringify({
  id: 'self-review',
  name: '自我复盘',
  desc: '自己的档案必须有索引；索引不得指向不存在的档案；档案名不得重复',
  check: 'check.mjs',
  baselineDir: 'baseline',
  protects: ['completeness', 'uniqueness'],
}, null, 2), 'utf8');

// ---- check.mjs ----
writeFileSync(join(dir, 'check.mjs'), [
  "import { readFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "",
  "const DATA = process.env.SEA_DATA_DIR || join(import.meta.dirname, 'data');",
  "const profiles = JSON.parse(readFileSync(join(DATA, 'profiles.json'), 'utf8'));",
  "const indexed = JSON.parse(readFileSync(join(DATA, 'indexed.json'), 'utf8'));",
  "",
  "const problems = [];",
  "",
  "// completeness：每份档案都必须被索引（否则 AI 找不到它）",
  "const names = profiles.map(p => p.name);",
  "const missing = names.filter(n => !indexed.includes(n));",
  "if (missing.length) problems.push(`未登记的档案 ${missing.length}(${missing.join(', ')})`);",
  "",
  "// completeness 反向：索引不得指向不存在的档案（幽灵）",
  "const ghost = indexed.filter(i => !names.includes(i));",
  "if (ghost.length) problems.push(`索引指向不存在的档案 ${ghost.length}(${ghost.join(', ')})`);",
  "",
  "// uniqueness：档案名不得重复",
  "const dup = [...new Set(indexed.filter((x, i) => indexed.indexOf(x) !== i))];",
  "if (dup.length) problems.push(`索引重复 ${dup.length}(${dup.join(', ')})`);",
  "",
  "if (problems.length === 0) {",
  "  console.log('PASS self-review: 差异集合 = 0');",
  "  process.exit(0);",
  "}",
  "console.log(`FAIL self-review: 差异集合 = ${problems.length} 项`);",
  "for (const p of problems) console.log(`  - ${p}`);",
  "process.exit(1);",
].join('\n'), 'utf8');

console.log(`self-review 场景已建立`);
console.log(`  档案 ${profiles.length} 份，索引 ${indexed.length} 份（故意漏 ${profiles.length - indexed.length} 份模拟真实情况）`);
console.log(`  档案类型：方案 ${profiles.filter(p => p.kind === 'plan').length} · 深读 ${profiles.filter(p => p.kind === 'deep-read').length}`);
