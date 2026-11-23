#!/usr/bin/env node
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
if (dup.length) problems.push(`物料 id 重复 ${dup.length}(${dup.join(', ')})`);

// ---- 引用完整性：物料号必须在主数据里 ----
const notInMaster = items.filter(i => !master.includes(i.id)).map(i => i.id);
if (notInMaster.length) problems.push(`物料不在主数据 ${notInMaster.length}(${notInMaster.join(', ')})`);

// ---- 必填字段：名称不得为空 ----
const noName = items.filter(i => !i.name || i.name.trim() === '').map(i => i.id);
if (noName.length) problems.push(`物料缺名称 ${noName.length}(${noName.join(', ')})`);

// ---- 完整性：账面量与仓库记录一致 ----
const whById = new Map(warehouse.map(w => [w.sku, w]));
const missingInWh = items.filter(i => !whById.has(i.id)).map(i => i.id);
if (missingInWh.length) problems.push(`仓库缺记录 ${missingInWh.length}(${missingInWh.join(', ')})`);

const qtyDiff = items
  .filter(i => whById.has(i.id) && whById.get(i.id).qty !== i.qty)
  .map(i => `${i.id}:账面 ${i.qty} ≠ 仓库 ${whById.get(i.id).qty}`);
if (qtyDiff.length) problems.push(`数量不一致 ${qtyDiff.length}(${qtyDiff.join(', ')})`);

// ---- 完整性对称：仓库里有、账面没有的记录 ----
const whOnly = warehouse.filter(w => !items.some(i => i.id === w.sku)).map(w => w.sku);
if (whOnly.length) problems.push(`仓库多出记录 ${whOnly.length}(${whOnly.join(', ')})`);

// ---- 唯一性（仓库侧）----
const whIds = warehouse.map(w => w.id);
const whDup = [...new Set(whIds.filter((id, i) => whIds.indexOf(id) !== i))];
if (whDup.length) problems.push(`仓库记录重复 ${whDup.length}(${whDup.join(', ')})`);

if (problems.length === 0) {
  console.log('PASS inventory-ledger: 差异集合 = 0');
  process.exit(0);
}
console.log(`FAIL inventory-ledger: 差异集合 = ${problems.length} 项`);
for (const p of problems) console.log(`  - ${p}`);
process.exit(1);
