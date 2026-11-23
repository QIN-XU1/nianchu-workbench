/**
 * 第 4 个场景：库存台账（demo：验证"放文件即新增"）
 * 不修改任何现有代码，只创建目录 + 3 个文件。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const dir = join(HERE, 'scenes', 'inventory-ledger');
const data = join(dir, 'data');
mkdirSync(data, { recursive: true });

// 1) scene.json —— 声明保护哪些不变量
writeFileSync(join(dir, 'scene.json'), JSON.stringify({
  id: 'inventory-ledger',
  name: '库存台账',
  desc: '每种物料的账面量与仓库记录一致，且物料号在物料主数据里',
  check: 'check.mjs',
  protects: ['completeness', 'referential-integrity', 'required-field', 'uniqueness'],
}, null, 2), 'utf8');

// 2) data/
writeFileSync(join(data, 'items.json'), JSON.stringify([
  { id: 'SKU-1', name: '螺丝', qty: 100 },
  { id: 'SKU-2', name: '螺母', qty: 250 },
  { id: 'SKU-3', name: '垫片', qty: 75 },
], null, 2), 'utf8');

writeFileSync(join(data, 'master.json'), JSON.stringify([
  'SKU-1', 'SKU-2', 'SKU-3',
], null, 2), 'utf8');

writeFileSync(join(data, 'warehouse.json'), JSON.stringify([
  { id: 'SKU-1', sku: 'SKU-1', qty: 100 },
  { id: 'SKU-2', sku: 'SKU-2', qty: 250 },
  { id: 'SKU-3', sku: 'SKU-3', qty: 78 },
], null, 2), 'utf8');

// 3) check.mjs
writeFileSync(join(dir, 'check.mjs'), `#!/usr/bin/env node
/**
 * 库存台账自检：账面量 vs 仓库记录一致；物料号在物料主数据；名称必填；id 唯一
 * exit 0 = 通过；非 0 = 失败且输出差异集合
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA = process.env.SEA_DATA_DIR || join(import.meta.dirname, 'data');
const read = f => JSON.parse(readFileSync(join(DATA, f), 'utf8'));

const items = read('items.json');
const master = read('master.json');
const warehouse = read('warehouse.json');

const problems = [];

// ---- 唯一性 ----
const ids = items.map(i => i.id);
const dup = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
if (dup.length) problems.push(\`物料 id 重复 \${dup.length}(\${dup.join(', ')})\`);

// ---- 引用完整性：物料号必须在主数据里 ----
const notInMaster = items.filter(i => !master.includes(i.id)).map(i => i.id);
if (notInMaster.length) problems.push(\`物料不在主数据 \${notInMaster.length}(\${notInMaster.join(', ')})\`);

// ---- 必填字段：名称不得为空 ----
const noName = items.filter(i => !i.name || i.name.trim() === '').map(i => i.id);
if (noName.length) problems.push(\`物料缺名称 \${noName.length}(\${noName.join(', ')})\`);

// ---- 完整性：账面量与仓库记录一致 ----
const whById = new Map(warehouse.map(w => [w.sku, w]));
const missingInWh = items.filter(i => !whById.has(i.id)).map(i => i.id);
if (missingInWh.length) problems.push(\`仓库缺记录 \${missingInWh.length}(\${missingInWh.join(', ')})\`);

const qtyDiff = items
  .filter(i => whById.has(i.id) && whById.get(i.id).qty !== i.qty)
  .map(i => \`\${i.id}:账面 \${i.qty} ≠ 仓库 \${whById.get(i.id).qty}\`);
if (qtyDiff.length) problems.push(\`数量不一致 \${qtyDiff.length}(\${qtyDiff.join(', ')})\`);

// ---- 唯一性（仓库侧）----
const whIds = warehouse.map(w => w.id);
const whDup = [...new Set(whIds.filter((id, i) => whIds.indexOf(id) !== i))];
if (whDup.length) problems.push(\`仓库记录重复 \${whDup.length}(\${whDup.join(', ')})\`);

if (problems.length === 0) {
  console.log('PASS inventory-ledger: 差异集合 = 0');
  process.exit(0);
}
console.log(\`FAIL inventory-ledger: 差异集合 = \${problems.length} 项\`);
for (const p of problems) console.log(\`  - \${p}\`);
process.exit(1);
`, 'utf8');

console.log('created scene: inventory-ledger (3 files, 0 existing code changed)');
