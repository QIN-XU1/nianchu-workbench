#!/usr/bin/env node
/**
 * 自评证据审计 —— 用「量对手的同一把尺子」量我们自己。
 *
 * 为什么需要（2026-11-21，第 60 轮发现）：
 *   我们要求对手每一个「有」都必须指到**对方仓库里真实存在的文件**（REAL），
 *   但我们自己的 `us` 列 29 个「有」从来没被同样检验过 ——
 *   `classifyEvidence('us', ...)` 因为 'us' 不在 SOURCE_ROOTS 里，永远返回 OWN。
 *   结果是：**净胜主要由自我评分驱动**，不是客观差距。
 *
 * 本工具做两件事：
 *   1. 对我们自己判「有/部分」的维，抽出证据里的路径，检查它在**本仓库**是否真实存在
 *   2. 列出「自评有、但没有可核验自证」的维 —— 这些是最该先自查的
 *
 * 退出码：0 全部可核验 · 3 有未核实的自评 · 2 工具本身坏了
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPaths } from './lib/evidence-provenance.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const mx = JSON.parse(readFileSync(join(ROOT, 'prototype/hermes-agents/matrix-data.json'), 'utf8'));

/** 自检：确保抽取器对本仓库路径也能工作 */
{
  const probe = extractPaths('见 `tools/agent/toolkit.mjs` 与 `tools/evolve/fair-compare.mjs`');
  const want = 'tools/agent/toolkit.mjs';
  if (!probe.includes(want)) {
    console.error('  ✗ 自检失败：抽取器抽不出本仓库路径 → 判定不可信');
    process.exit(2);
  }
}

const allDims = [];
for (const g of mx.dimensions) for (const it of g.items) allDims.push(it);

const unverified = [];
let ok = 0;
for (const it of allDims) {
  const raw = it.us;
  if (!Array.isArray(raw) || raw.length < 2) continue;
  const verdict = raw[0];
  if (verdict !== '有' && verdict !== '部分') continue;
  const paths = extractPaths(raw[1]);
  const hit = paths.find((p) => existsSync(join(ROOT, p)));
  if (hit) { ok++; continue; }
  unverified.push({ dim: it.id, verdict, paths, ev: String(raw[1]).replace(/\s+/g, ' ').slice(0, 80) });
}

console.log('');
console.log('  自评证据审计（我方「有/部分」是否能在本仓库找到真实文件）');
console.log('  ' + '─'.repeat(78));
console.log('  可核验: ' + ok + ' 维 · 未核实: ' + unverified.length + ' 维');
if (unverified.length) {
  console.log('');
  console.log('  ✗ 自评「有/部分」但证据里找不到本仓库真实文件的维：');
  for (const u of unverified) {
    console.log('    · ' + u.dim.padEnd(4) + u.verdict + '  抽出路径=' + JSON.stringify(u.paths).slice(0, 60));
    console.log('        ' + u.ev);
  }
}
console.log('');
console.log('  四态: ' + (unverified.length === 0 ? 'PASS' : 'WARN') +
  ' —— ' + (unverified.length === 0 ? '我方所有自评均可核验到本仓库文件' : '有 ' + unverified.length + ' 维自评缺自证，需补路径或如实降级'));
console.log('');
process.exitCode = unverified.length === 0 ? 0 : 3;
