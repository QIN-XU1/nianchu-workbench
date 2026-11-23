/**
 * 真实场景 1 修正版：文档索引完整性
 *
 * 关键设计变化（来自一次真实的架构冲突）：
 *   门禁要求「基线数据必须通过」（否则无法证明 check 不是恒定失败）
 *   但真实场景的价值恰恰在于「实际数据可能有问题」
 *
 * 解法：**把数据分两类**
 *   data/          —— 真实数据（可以有问 题）
 *   baseline/      —— 干净基线（门禁用来验证 check 本身）
 *
 * scene.json 增加 baselineDir 字段。
 * 没有 baselineDir 的场景，门禁会从 data/ 自动找一份"干净副本"，
 * 找不到就判定"该场景不可认证"（诚实：不提供干净样本就无法证明 check 不是恒定失败）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const PROTOTYPE = join(HERE, '..');
const dir = join(PROTOTYPE, 'scenes', 'docs-index');
const data = join(dir, 'data');
const baseline = join(dir, 'baseline');
mkdirSync(data, { recursive: true });
mkdirSync(baseline, { recursive: true });

// ---- 真实数据：包含真实的遗漏（README 漏登 6 篇）----
const DOCS = [
  '00-一页读懂.md', '01-源材料深度分析.md', '02-总体架构.md', '02b-总体架构v2-host对齐版.md',
  '03-自进化机制.md', '04-工程路线与验收.md', '05-方法论与专家基线.md', '06-v1逐项复核.md',
  '07-v2落地路线与门禁验收.md', '08-权威机构与最新架构.md', '08b-二次开发可行性实测.md',
  '09-实机验证记录.md', '10-从架构正确到现象级好用.md', '11-好用原型与度量.md',
  '12-门禁元验证.md', '13-场景可扩展与不变量门禁.md', '14-三层信任链与外部目录.md',
  '附录A-DSH能力审计.md', '附录B-生态扫描与GrokBot考证.md', '附录C-组件选型矩阵.md',
  '附录D-官方仓库原始素材地图.md',
].sort();

// 真实情况：README 只索引了 15 篇（漏了 13/14 与 4 个附录）
const REAL_INDEXED = [
  '00-一页读懂.md', '01-源材料深度分析.md', '02-总体架构.md', '02b-总体架构v2-host对齐版.md',
  '03-自进化机制.md', '04-工程路线与验收.md', '05-方法论与专家基线.md', '06-v1逐项复核.md',
  '07-v2落地路线与门禁验收.md', '08-权威机构与最新架构.md', '08b-二次开发可行性实测.md',
  '09-实机验证记录.md', '10-从架构正确到现象级好用.md', '11-好用原型与度量.md',
  '12-门禁元验证.md',
].sort();

writeFileSync(join(data, 'docs.json'), JSON.stringify(DOCS, null, 2), 'utf8');
writeFileSync(join(data, 'indexed.json'), JSON.stringify(REAL_INDEXED, null, 2), 'utf8');

// ---- 干净基线：索引完整，用于证明 check 不是恒定失败 ----
writeFileSync(join(baseline, 'docs.json'), JSON.stringify(DOCS, null, 2), 'utf8');
writeFileSync(join(baseline, 'indexed.json'), JSON.stringify(DOCS, null, 2), 'utf8');

writeFileSync(join(dir, 'scene.json'), JSON.stringify({
  id: 'docs-index',
  name: '文档索引',
  desc: 'README 索引必须覆盖全部文档，且不得重复',
  check: 'check.mjs',
  baselineDir: 'baseline',
  protects: ['completeness', 'uniqueness'],
}, null, 2), 'utf8');

writeFileSync(join(dir, 'check.mjs'), [
  "import { readFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "",
  "const DATA = process.env.SEA_DATA_DIR || join(import.meta.dirname, 'data');",
  "const docs = JSON.parse(readFileSync(join(DATA, 'docs.json'), 'utf8'));",
  "const indexed = JSON.parse(readFileSync(join(DATA, 'indexed.json'), 'utf8'));",
  "",
  "const problems = [];",
  "",
  "const missing = docs.filter(d => !indexed.includes(d));",
  "if (missing.length) problems.push(`未登记文档 ${missing.length}(${missing.join(', ')})`);",
  "",
  "const ghost = indexed.filter(i => !docs.includes(i));",
  "if (ghost.length) problems.push(`索引指向不存在的文档 ${ghost.length}(${ghost.join(', ')})`);",
  "",
  "const dup = [...new Set(indexed.filter((x, i) => indexed.indexOf(x) !== i))];",
  "if (dup.length) problems.push(`索引重复 ${dup.length}(${dup.join(', ')})`);",
  "",
  "if (problems.length === 0) {",
  "  console.log('PASS docs-index: 差异集合 = 0');",
  "  process.exit(0);",
  "}",
  "console.log(`FAIL docs-index: 差异集合 = ${problems.length} 项`);",
  "for (const p of problems) console.log(`  - ${p}`);",
  "process.exit(1);",
].join('\n'), 'utf8');

console.log('rebuilt docs-index: data/ (real, has problems) + baseline/ (clean)');
