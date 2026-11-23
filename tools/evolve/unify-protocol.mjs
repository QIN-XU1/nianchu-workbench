#!/usr/bin/env node
/**
 * 统一口径：把老 7 个参照的格子也用严格抽取结果覆盖。
 *
 * 为什么必须做：老格子是早期填的，openclaw 25 个「有」/ 0 个「判不了」——
 * 同一份 dsh-openclaw.md 交给严格抽取 agent，它判 openclaw 有 8 个「判不了」。
 * 不统一口径，横向比较就是拿严格尺子量自己、拿宽松尺子量别人 = 自欺。
 *
 * 原矩阵先备份到 evidence/evolve/matrix-before-22.json，可回溯。
 */
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const EXTRACT_DIR = join(ROOT, 'evidence/evolve/extract');
const MX = join(ROOT, 'prototype/hermes-agents/matrix-data.json');
const BACKUP = join(ROOT, 'evidence/evolve/matrix-before-22.json');

if (!existsSync(BACKUP)) {
  copyFileSync(MX, BACKUP);
  console.log('  ✓ 原矩阵已备份 → evidence/evolve/matrix-before-22.json');
} else {
  console.log('  备份已存在，不覆盖');
}

const mx = JSON.parse(readFileSync(MX, 'utf8'));

// 收集抽取结果（f 覆盖 e）
const files = readdirSync(EXTRACT_DIR).filter((f) => f.endsWith('.json')).sort();
const ordered = [...files.filter((f) => !f.startsWith('f-')), ...files.filter((f) => f.startsWith('f-'))];
const cells = new Map();
for (const f of ordered) {
  const data = JSON.parse(readFileSync(join(EXTRACT_DIR, f), 'utf8'));
  for (const r of data.results || []) {
    if (!cells.has(r.subjectId)) cells.set(r.subjectId, new Map());
    const m = cells.get(r.subjectId);
    for (const c of r.cells || []) m.set(c.dimId, { verdict: c.verdict, evidence: c.evidence });
  }
}

const allDims = [];
for (const g of mx.dimensions) for (const it of g.items) allDims.push(it);

// 对每个非 us 主体，用抽取结果覆盖（保留旧值到 _prev）
let overwritten = 0;
const changed = [];
for (const s of mx.subjects) {
  if (s.id === 'us') continue;
  const m = cells.get(s.id);
  if (!m) { console.log('  ⚠ ' + s.id + ' 没有抽取结果，跳过'); continue; }
  for (const it of allDims) {
    const c = m.get(it.id);
    if (!c) continue;
    const old = Array.isArray(it[s.id]) ? it[s.id] : null;
    if (old && old[0] !== c.verdict) {
      changed.push(s.id + '.' + it.id + ' ' + old[0] + '→' + c.verdict);
    }
    it[s.id] = [c.verdict, c.evidence];
    overwritten++;
  }
}
console.log('  ✓ 覆盖 ' + overwritten + ' 格（22 个参照全部统一为严格抽取口径）');
console.log('  判定发生变化的格子 ' + changed.length + ' 个');

mx._protocolNote =
  '2026-11-17 口径统一：22 个参照全部由独立 agent 按同一份拆解报告、同一套口径' +
  '（有=完整实现且默认生效；报告没写判「判不了」；不因包名/产品名拔高）重判。' +
  '老矩阵（宽松口径）备份在 evidence/evolve/matrix-before-22.json。';

writeFileSync(MX, JSON.stringify(mx, null, 2) + '\n', 'utf8');

// 统计
const stat = {};
for (const s of mx.subjects) {
  const by = { 有: 0, 部分: 0, 无: 0, 判不了: 0 };
  for (const it of allDims) {
    const v = Array.isArray(it[s.id]) ? it[s.id][0] : null;
    if (v && by[v] !== undefined) by[v]++;
  }
  stat[s.id] = by;
}
console.log('');
console.log('  统一口径后（按「有」排序）：');
const rows = Object.entries(stat).sort((a, b) => b[1].有 - a[1].有 || a[1].判不了 - b[1].判不了);
let rank = 0;
for (const [sid, by] of rows) {
  rank++;
  const name = (mx.subjects.find((s) => s.id === sid) || {}).name || sid;
  const mark = sid === 'us' ? ' ← 我们' : '';
  console.log('    #' + String(rank).padStart(2) + ' ' + sid.padEnd(20) + '有' + String(by.有).padStart(2) + ' 部分' + String(by.部分).padStart(2) + ' 无' + String(by.无).padStart(2) + ' 判不了' + String(by.判不了).padStart(2) + '   ' + name + mark);
}
