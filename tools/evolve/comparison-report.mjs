#!/usr/bin/env node
/**
 * 整体对比报告生成器 —— 把散在各工具里的结论汇成**一份可读的报告**。
 *
 * 起因（第 73 轮）：68-72 连续五轮做实证复核，都是「修数据」，
 * 但没有人把「现在到底什么处境」讲清楚。本工具产出 evidence/evolve/对比报告.md：
 *   ① 判定总览  ② 逐项目表  ③ 31 维 REAL 覆盖  ④ 复核期净变化  ⑤ 诚实声明
 *
 * 数据来源：project-verdict.json（判定）+ matrix-data.json（覆盖率，用 classifyEvidence 实算）+ git（净变化）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyEvidence, hasSource } from './lib/evidence-provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MATRIX = path.join(ROOT, 'prototype/hermes-agents/matrix-data.json');
const OUT = path.join(ROOT, 'evidence/evolve/对比报告.md');

const mx = JSON.parse(readFileSync(MATRIX, 'utf8'));
const pvPath = path.join(ROOT, 'evidence/evolve/project-verdict.json');
const pv = existsSync(pvPath) ? JSON.parse(readFileSync(pvPath, 'utf8')) : null;

// 覆盖率实算
const allDims = []; for (const g of mx.dimensions) for (const it of g.items) allDims.push(it);
const nonGoal = new Set(((mx._deliberateGaps && mx._deliberateGaps.items) || []).map((x) => String(x.dim)));
const nonImpl = new Set(((mx._nonImplementation && mx._nonImplementation.ids) || []).map(String));
let real = 0, total = 0;
const dimReal = {};
for (const it of allDims) {
  let r = 0, t = 0;
  for (const [k, v] of Object.entries(it)) {
    if (k === 'id' || k === 'name' || k === 'desc' || k === 'us' || k.startsWith('_')) continue;
    if (!Array.isArray(v) || v.length < 2) continue;
    total++;
    const st = classifyEvidence(k, v[1]);
    if (st === 'REAL') real++; // 全局 REAL：与 audit-evidence-provenance 的 /682 一致（含 cl4r1t4s）
    if (hasSource(k) && !nonImpl.has(k)) { t++; if (st === 'REAL') r++; } // 每维：分母分子同口径（排除非实现）
  }
  dimReal[it.id] = r + '/' + t;
}

// 复核期净变化（相对给定基线）
const FROM = process.argv[2] || null;
let deltaText = '';
if (FROM) {
  try {
    const oldMx = JSON.parse(execSync(`git show ${FROM}:prototype/hermes-agents/matrix-data.json`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    const oi = {}; for (const g of oldMx.dimensions) for (const it of g.items) oi[it.id] = it;
    const rank = { '有': 3, '部分': 2, '无': 1, '判不了': 0 };
    let up = 0, down = 0, usUp = 0, usDown = 0; const who = {};
    const subjects = mx.subjects.filter((s) => s.id !== 'us').map((s) => s.id);
    for (const it of allDims) for (const s of ['us', ...subjects]) {
      const ov = Array.isArray(oi[it.id] && oi[it.id][s]) ? oi[it.id][s][0] : '?';
      const nv = Array.isArray(it[s]) ? it[s][0] : '?';
      if (ov === nv) continue;
      const dir = (rank[nv] || 0) - (rank[ov] || 0);
      if (s === 'us') { if (dir > 0) usUp++; else if (dir < 0) usDown++; }
      else { if (dir > 0) { up++; (who[s] = who[s] || []).push(it.id + ':' + ov + '→' + nv); } else if (dir < 0) down++; }
    }
    deltaText = `复核期（${FROM} → HEAD）：对手判定上调 **${up}** 处、下调 ${down} 处；我方上调 ${usUp}、下调 ${usDown}。` +
      (up > down ? ' → **主要是把对手从低估补正，我方相对变弱**（打回真实，不是变强）。' : '') +
      (Object.keys(who).length ? '\n\n' + Object.entries(who).map(([k, v]) => `- ${k}：${v.join('、')}`).join('\n') : '');
  } catch (e) { deltaText = '（无法读取基线 ' + FROM + '：' + e.message + '）'; }
}

const L = [];
L.push('# 念初 · 参照项目对比报告');
L.push('');
L.push('> 自动生成于 ' + new Date().toISOString() + ' · 数据源：matrix-data + project-verdict');
L.push('> 重新生成：`node tools/evolve/project-verdict.mjs --json && node tools/evolve/comparison-report.mjs' + (FROM ? ' ' + FROM : '') + '`');
L.push('');
L.push('## 一、一句话结论');
L.push('');
if (pv) {
  const t = pv.tally;
  L.push(`22 个参照项目中：**实质超越 ${t['实质超越'] || 0}** · 基本超越 ${t['基本超越'] || 0} · 可比不足 ${t['可比不足'] || 0} · 不及 ${t['不及'] || 0} · 不可比（无源码/非实现）${(t['不可比-无源码'] || 0) + (t['不可比-非实现'] || 0)}。`);
}
L.push(`REAL 证据覆盖：**${real}/${total} = ${(real / total * 100).toFixed(1)}%**（其余是我方分析文档，非对手源码可复算）。`);
L.push('');
if (deltaText) { L.push('## 二、复核期净变化（最重要）'); L.push(''); L.push(deltaText); L.push(''); }

L.push('## 三、逐项目判定');
L.push('');
L.push('| 对手 | 判定 | 可比维 | 覆盖 | 净胜 | 落后维 |');
L.push('|---|---|---|---|---|---|');
if (pv) for (const r of pv.rows) {
  if (r.verdict.startsWith('不可比')) { L.push(`| ${r.name} | ${r.verdict} | — | — | — | ${r.why} |`); continue; }
  L.push(`| ${r.name} | **${r.verdict}** | ${r.commonDims} | ${r.coverage}% | ${r.net} | ${(r.lag && r.lag.length) ? r.lag.join(' ') : '0'} |`);
}
L.push('');
L.push('## 四、31 维 REAL 覆盖（可复算家数 / 有源码家数）');
L.push('');
const rows = [];
for (let i = 0; i < allDims.length; i += 6) rows.push(allDims.slice(i, i + 6).map((it) => `${it.id}:${dimReal[it.id]}`).join('  '));
for (const r of rows) L.push('- ' + r);
L.push('');
L.push('## 五、诚实声明（必读）');
L.push('');
L.push('- **「实质超越」只在已核 REAL 的维度上成立**，不是所有维度、不是全面碾压。');
L.push('- 不可比 8 家（7 纯 SaaS 无源码 + cl4r1t4s 非实现）**无法声称超越**。');
L.push('- 判断类结论（有 vs 部分）仍是人复核，工具只保证「证据能指向真实文件」。');
L.push('- 模型真跑段（网关不可用）仍是 UNKNOWN，未计入。');
L.push('- 每一格结论都可点开 `prototype/hermes-agents/matrix-data.json` 看路径:行号证据，用 `audit-evidence-provenance.mjs` 复算。');
L.push('');

// ── 自检：数字必须自洽，否则报告不可信 ──
{
  const ep = mx._evidenceProvenance;
  if (ep && (ep.real !== real || ep.totalCells !== total)) {
    console.error('  ✗ 自检失败：本工具 REAL=' + real + '/' + total + ' 与 _evidenceProvenance real=' + ep.real + '/' + ep.totalCells + ' 不一致 → 报告不可信');
    process.exit(2);
  }
  for (const [id, s] of Object.entries(dimReal)) {
    const [r, tt] = s.split('/').map(Number);
    if (r > tt) { console.error('  ✗ 自检失败：维度 ' + id + ' REAL ' + s + ' 分子大于分母'); process.exit(2); }
  }
  if (total !== 682) { console.error('  ⚠ 总格数 ' + total + ' ≠ 682（矩阵被改动？）'); }
  console.log('  ✓ 自检通过：REAL=' + real + '/' + total + ' 与 _evidenceProvenance 一致，各维 r≤t');
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, L.join('\n'), 'utf8');
console.log('  已生成：' + OUT);
console.log('  判定：' + (pv ? JSON.stringify(pv.tally) : '(缺 project-verdict.json)'));
console.log('  REAL：' + real + '/' + total + ' (' + (real / total * 100).toFixed(1) + '%)');
if (deltaText) console.log('  净变化：' + deltaText.split('\n')[0]);