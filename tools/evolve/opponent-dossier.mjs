#!/usr/bin/env node
/**
 * 单对手结项档案 —— 逐维度把「我们 vs 它」的判定、证据可复算性、胜负摊开成一张表。
 *
 * 目的（第 82 轮）：把「实质超越 / 不及」从一句话变成可逐格复核的档案，尤其对 3 个「不及」对手
 * （openclaw/hermes/ECC），钉死「到底差在哪一维、其余各维是否真的领先或打平」。
 *
 * 数据：matrix-data.json + classifyEvidence（对手证据是否可复算）。
 * 用法：node tools/evolve/opponent-dossier.mjs [opponentId...]   （默认输出 project-verdict 里所有「不及」对手）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyEvidence } from './lib/evidence-provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mx = JSON.parse(readFileSync(path.join(ROOT, 'prototype/hermes-agents/matrix-data.json'), 'utf8'));
const pv = JSON.parse(readFileSync(path.join(ROOT, 'evidence/evolve/project-verdict.json'), 'utf8'));

const allDims = []; for (const g of mx.dimensions) for (const it of g.items) allDims.push(it);
const nonGoal = new Set(((mx._deliberateGaps && mx._deliberateGaps.items) || []).map((x) => String(x.dim)));
const v = (it, s) => (Array.isArray(it[s]) ? it[s][0] : '?');
const score = (x) => (x === '有' ? 1 : x === '部分' ? 0.5 : x === '无' ? 0 : null);

const args = process.argv.slice(2);
const targets = args.length ? args : pv.rows.filter((r) => r.verdict === '不及').map((r) => r.opponent);

mkdirSync(path.join(ROOT, 'evidence/evolve'), { recursive: true });
for (const oid of targets) {
  const name = (mx.subjects.find((s) => s.id === oid) || {}).name || oid;
  const rows = [];
  let lead = 0, tie = 0, lag = 0, realN = 0;
  let rLead = 0, rTie = 0, rLag = 0;
  const lags = [];
  for (const it of allDims) {
    const us = v(it, 'us'); const them = v(it, oid);
    if (us === '判不了' || them === '判不了') { rows.push({ dim: it.id, name: it.name || '', us, them, status: '判不了', mark: '·' }); continue; }
    if (nonGoal.has(it.id)) { rows.push({ dim: it.id, name: it.name || '', us, them, status: '非目标', mark: '-' }); continue; }
    const raw = it[oid]; const ev = Array.isArray(raw) && raw.length > 1 ? raw[1] : '';
    const prov = classifyEvidence(oid, ev) === 'REAL' ? 'REAL' : 'OWN';
    if (prov === 'REAL') realN++;
    const a = score(us), b = score(them);
    let mark, status;
    if (a > b) { lead++; mark = '领先'; } else if (a < b) { lag++; mark = '落后'; lags.push(`${it.id}(${us}<${them})`); } else { tie++; mark = '平'; }
    if (prov === 'REAL') { if (a > b) rLead++; else if (a < b) rLag++; else rTie++; }
    status = mark;
    rows.push({ dim: it.id, name: it.name || '', us, them, prov, status: mark });
  }

  const L = [];
  L.push(`# 结项档案 · ${name}（${oid}）`);
  L.push('');
  L.push(`> 自动生成 · 数据源 matrix-data + project-verdict · 「证据」列 REAL=对手源码可复算 / OWN=我方分析文档 / 判不了 / 非目标`);
  L.push('');
  L.push(`## 净结果（全可比，含二手）：领先 ${lead} · 平 ${tie} · 落后 ${lag}`);
  L.push(``);
  L.push(`## 净结果（**仅 REAL**，对手证据可复算）：领先 ${rLead} · 平 ${rTie} · 落后 ${rLag} · REAL ${realN} 维`);
  L.push('');
  if (lag === 0) L.push('**结论：每一可比维度都不落后（领先或平）。**');
  else L.push(`**落后仅 ${lag} 维：${lags.join('、')}**`);
  L.push('');
  L.push('## 逐维度');
  L.push('');
  L.push('| 维度 | 名称 | 我们 | 对手 | 证据 | 结果 |');
  L.push('|---|---|---|---|---|---|');
  for (const r of rows) L.push(`| ${r.dim} | ${r.name} | ${r.us} | ${r.them} | ${r.prov || ''} | ${r.status} |`);
  L.push('');
  const out = path.join(ROOT, 'evidence/evolve', `dossier-${oid}.md`);
  writeFileSync(out, L.join('\n'), 'utf8');

  console.log(`\n  ${name}（${oid}）：全可比 领先${lead}/平${tie}/落后${lag}；仅REAL 领先${rLead}/平${rTie}/落后${rLag}（REAL ${realN}）`);
  if (lag) console.log('    落后：' + lags.join('、'));
  console.log('    → ' + path.relative(ROOT, out));
}