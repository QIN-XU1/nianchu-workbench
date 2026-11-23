#!/usr/bin/env node
/**
 * 把 22 个参照项目的抽取结果合并进矩阵。
 *
 * 规则：
 *   · 新增 15 个主体（矩阵原来只有 7 个参照）
 *   · 已存在的 7 个主体**不动**（它们的判定是既有结论，改它要单独走一轮）
 *   · f-*.json（确证补篇）覆盖 e-*.json（推测版）的 cursor/trae/codebuddy
 *   · 缺格必须报出来，不许静默补空
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const EXTRACT_DIR = join(ROOT, 'evidence/evolve/extract');
const MX = join(ROOT, 'prototype/hermes-agents/matrix-data.json');

const mx = JSON.parse(readFileSync(MX, 'utf8'));

// ── 收集抽取结果 ──
const files = readdirSync(EXTRACT_DIR).filter((f) => f.endsWith('.json')).sort();
const cells = new Map(); // subjectId -> Map(dimId -> {verdict, evidence})
const sourceOf = new Map(); // subjectId -> 来自哪个文件

// 先 e 后 f，f 覆盖 e
const ordered = [...files.filter((f) => !f.startsWith('f-')), ...files.filter((f) => f.startsWith('f-'))];

for (const f of ordered) {
  const data = JSON.parse(readFileSync(join(EXTRACT_DIR, f), 'utf8'));
  for (const r of data.results || []) {
    if (!cells.has(r.subjectId)) cells.set(r.subjectId, new Map());
    const m = cells.get(r.subjectId);
    for (const c of r.cells || []) m.set(c.dimId, { verdict: c.verdict, evidence: c.evidence });
    sourceOf.set(r.subjectId, f);
  }
}
console.log('  抽取文件 ' + files.length + ' 个，主体 ' + cells.size + ' 个');

// ── 主体元信息（来自 spec） ──
const spec = JSON.parse(readFileSync(join(ROOT, 'evidence/evolve/extract-22-spec.json'), 'utf8'));
const specById = new Map(spec.subjects.map((s) => [s.id, s]));

// ── 现有主体 ──
const existing = new Set(mx.subjects.map((s) => s.id));
console.log('  矩阵现有主体 ' + existing.size + ' 个: ' + [...existing].join(', '));

// ── 追加新主体 ──
const added = [];
for (const [sid, m] of cells) {
  if (existing.has(sid)) continue;
  const meta = specById.get(sid);
  mx.subjects.push({ id: sid, name: meta ? meta.name : sid, kind: meta ? meta.kind : '未知' });
  added.push(sid);
}
console.log('  新增主体 ' + added.length + ' 个: ' + added.join(', '));

// ── 写格子 ──
const allDims = [];
for (const g of mx.dimensions) for (const it of g.items) allDims.push(it);

let written = 0;
const missing = [];
for (const sid of added) {
  const m = cells.get(sid);
  for (const it of allDims) {
    const c = m.get(it.id);
    if (!c) { missing.push(sid + '.' + it.id); continue; }
    it[sid] = [c.verdict, c.evidence];
    written++;
  }
}
console.log('  写入格子 ' + written + ' 个');
if (missing.length) {
  console.log('  ❌ 缺格 ' + missing.length + ' 个: ' + missing.slice(0, 20).join(', '));
} else {
  console.log('  ✅ 无缺格（每个新主体 × 每个维度都有判定）');
}

// ── 覆盖统计 ──
const stat = {};
for (const s of mx.subjects) {
  const by = { 有: 0, 部分: 0, 无: 0, 判不了: 0, 缺失: 0 };
  for (const it of allDims) {
    const v = Array.isArray(it[s.id]) ? it[s.id][0] : null;
    if (!v) by.缺失++;
    else if (by[v] !== undefined) by[v]++;
  }
  stat[s.id] = by;
}

mx._coverageNote =
  '2026-11-17：按 research/拆解/ 的 9 份报告 + 3 份确证补篇，把矩阵从 7 个参照扩到 ' +
  (mx.subjects.length - 1) +
  ' 个参照（新增 ' + added.length + ' 个）。抽取由独立 agent 逐份报告完成，' +
  '规则：只从报告读、报告没写判「判不了」、不因包名/产品名拔高。' +
  '确证补篇（补-cursor/补-trae/补-codebuddy）覆盖 closed.md 的推测版。';

writeFileSync(MX, JSON.stringify(mx, null, 2) + '\n', 'utf8');

console.log('');
console.log('  主体覆盖统计（31 维）：');
const sorted = Object.entries(stat).sort((a, b) => b[1].有 - a[1].有);
for (const [sid, by] of sorted) {
  const name = (mx.subjects.find((s) => s.id === sid) || {}).name || sid;
  console.log('    ' + sid.padEnd(20) + '有' + String(by.有).padStart(2) + ' 部分' + String(by.部分).padStart(2) + ' 无' + String(by.无).padStart(2) + ' 判不了' + String(by.判不了).padStart(2) + '   ' + name);
}
console.log('');
console.log('  矩阵主体总数: ' + mx.subjects.length + '（含我们）');
