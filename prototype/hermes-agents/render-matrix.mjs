#!/usr/bin/env node
/**
 * 对比矩阵：渲染 + 校验
 *
 * 目标里写死了「每个格子给出有/无/部分并附证据位置」。所以矩阵不能是手写文档 ——
 * 那必然漂移（ECC 的 45% 漂移、luanyujia 的 24 vs 36 面板都是这个死法）。
 * 这里做成：数据文件（matrix-data.json）→ 校验器 → 渲染器。
 *
 * 用法：
 *   node render-matrix.mjs              渲染 markdown 到 research/对比矩阵.md
 *   node render-matrix.mjs --check      只校验（CI 用），不写文件
 *   node render-matrix.mjs --stats      只出统计
 */

import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;   // 不再硬编码（可复算性要求）
const DATA = path.join(HERE, 'matrix-data.json');
// 输出路径也从文件位置推导，不用绝对路径（独立验证方 R4）
const OUT = path.join(HERE, '../../research/对比矩阵.md');

const M = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const SUBJECTS = M.subjects;
const STATUSES = Object.keys(M._legend);

let fail = 0;
const errors = [];

// ══════════════════════════════════════════════════════════
//  校验
// ══════════════════════════════════════════════════════════
const dims = [];
for (const g of M.dimensions) for (const it of g.items) dims.push({ ...it, group: g.group });

const seenIds = new Set();
for (const d of dims) {
  if (seenIds.has(d.id)) { errors.push('重复维度 id: ' + d.id); fail++; }
  seenIds.add(d.id);

  for (const s of SUBJECTS) {
    const cell = d[s.id];
    if (!cell) { errors.push(d.id + ' 缺 ' + s.id + ' 列'); fail++; continue; }
    if (!Array.isArray(cell) || cell.length < 2) {
      errors.push(d.id + '/' + s.id + ' 格式应为 [状态, 证据]'); fail++; continue;
    }
    const [status, ev] = cell;
    if (!STATUSES.includes(status)) {
      errors.push(d.id + '/' + s.id + ' 非法状态 "' + status + '"，应为 ' + STATUSES.join('/')); fail++;
    }
    if (!ev || String(ev).trim().length < 4) {
      errors.push(d.id + '/' + s.id + ' 缺证据'); fail++;
    }
    // 「有」必须有实质证据（长度门槛 + 不含模糊词）
    if (status === '有') {
      if (String(ev).length < 6) { errors.push(d.id + '/' + s.id + ' 标「有」但证据过短'); fail++; }
      if (/似乎|可能|大概|据说/.test(ev)) { errors.push(d.id + '/' + s.id + ' 标「有」但证据含模糊词'); fail++; }
    }
  }
}

// 统计
const stats = {};
for (const s of SUBJECTS) {
  stats[s.id] = { 有: 0, 部分: 0, 无: 0, 不适用: 0, 判不了: 0, total: 0 };
  for (const d of dims) {
    const st = d[s.id] ? d[s.id][0] : null;
    if (!st) continue;
    stats[s.id][st] = (stats[s.id][st] || 0) + 1;
    // 「不适用」与「判不了」都不计入分母：前者形态决定不需要，后者是我们不知道。
        if (st !== '不适用' && st !== '判不了') stats[s.id].total++;
  }
  const t = stats[s.id].total || 1;
  stats[s.id].score = ((stats[s.id].有 * 1 + stats[s.id].部分 * 0.5) / t * 100);
}

// ══════════════════════════════════════════════════════════
//  输出
// ══════════════════════════════════════════════════════════
if (process.argv.includes('--check')) {
  if (fail) {
    console.log('  ✗ 矩阵校验失败 ' + fail + ' 项：');
    for (const e of errors.slice(0, 20)) console.log('    · ' + e);
    process.exit(1);
  }
  console.log('  ✓ 矩阵校验通过：' + dims.length + ' 维 × ' + SUBJECTS.length + ' 方 = ' +
    (dims.length * SUBJECTS.length) + ' 格，全部有状态且有证据');
  process.exit(0);
}

if (process.argv.includes('--stats')) {
  console.log('  维度数: ' + dims.length + '   主体数: ' + SUBJECTS.length);
  console.log('');
  console.log('  ' + '主体'.padEnd(20) + '有  部分   无  不适用  覆盖率');
  for (const s of SUBJECTS) {
    const x = stats[s.id];
    console.log('  ' + s.name.padEnd(20) + String(x.有).padStart(3) + String(x.部分).padStart(5) +
      String(x.无).padStart(4) + String(x.不适用).padStart(7) + '   ' + x.score.toFixed(1) + '%');
  }
  process.exit(0);
}

// 渲染 markdown
const L = [];
L.push('# 31 维对比矩阵：我们 vs 7 个参照系统');
L.push('');
L.push('> 机器生成，勿手改。数据源 `prototype/hermes-agents/matrix-data.json`，');
L.push('> 校验：`node prototype/hermes-agents/render-matrix.mjs --check`（每个格子必须有状态+证据）。');
L.push('> 生成时间：' + M._at + '　维度 ' + dims.length + ' × 主体 ' + SUBJECTS.length + ' = ' + (dims.length * SUBJECTS.length) + ' 格');
L.push('');
L.push('## 图例');
L.push('');
for (const [k, v] of Object.entries(M._legend)) L.push('- **' + k + '**：' + v);
L.push('');
L.push('## 总览（覆盖率 = 有×1 + 部分×0.5，除以非「不适用」维度数）');
L.push('');
L.push('| 主体 | 形态 | 有 | 部分 | 无 | 不适用 | 覆盖率 |');
L.push('|---|---|---|---|---|---|---|');
for (const s of SUBJECTS) {
  const x = stats[s.id];
  L.push('| ' + s.name + ' | ' + s.kind + ' | ' + x.有 + ' | ' + x.部分 + ' | ' + x.无 + ' | ' + x.不适用 + ' | **' + x.score.toFixed(1) + '%** |');
}
L.push('');

let curGroup = null;
for (const d of dims) {
  if (d.group !== curGroup) {
    curGroup = d.group;
    L.push('## ' + curGroup);
    L.push('');
    L.push('| # | 维度 | ' + SUBJECTS.map((s) => s.name).join(' | ') + ' |');
    L.push('|---|' + '---|'.repeat(SUBJECTS.length + 1));
  }
  const cells = SUBJECTS.map((s) => {
    const [st, ev] = d[s.id];
    const mark = st === '有' ? '✅' : st === '部分' ? '🟡' : st === '无' ? '❌' : '➖';
    return mark + ' ' + String(ev).replace(/\|/g, '\\|');
  });
  L.push('| ' + d.id + ' | ' + d.name + ' | ' + cells.join(' | ') + ' |');
}
L.push('');
L.push('---');
L.push('');
L.push('## 统计口径说明');
L.push('');
L.push('- 「有」= 完整实现且默认生效；「部分」= 有实现但残缺/默认关/只在某端生效；「无」= 没有；「不适用」= 形态决定不需要');
L.push('- 证据优先级：本地源码 > 官方发行物 > 官方文档 > 业界共识。每格证据见 JSON 源文件。');
L.push('- 覆盖率只用于横向对比，不代表产品好坏（一个表格软件在「代码编辑」上是「无」，但它不需要）。');
L.push('');

fs.writeFileSync(OUT, L.join('\n'), 'utf8');
console.log('  ✓ 已渲染 ' + OUT);
console.log('    ' + dims.length + ' 维 × ' + SUBJECTS.length + ' 方 = ' + (dims.length * SUBJECTS.length) + ' 格');
console.log('');
console.log('  ' + '主体'.padEnd(20) + '有  部分   无  不适用  覆盖率');
for (const s of SUBJECTS) {
  const x = stats[s.id];
  console.log('  ' + s.name.padEnd(20) + String(x.有).padStart(3) + String(x.部分).padStart(5) +
    String(x.无).padStart(4) + String(x.不适用).padStart(7) + '   ' + x.score.toFixed(1) + '%');
}
