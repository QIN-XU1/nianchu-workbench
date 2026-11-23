#!/usr/bin/env node
/**
 * 领先幅度分解 —— 把 R11 的「加权 29.0」拆成可核验 / 自评两部分
 *
 * 问题（R11 自己的 detail 就承认）：29.0 分里其他 7 方的分数是**我们打的**，
 * 所以「领先 1.5 分」不是客观事实。但到底有多少可信？之前只有定性说法。
 *
 * 做法：按「这一格的对比能否下结论」把 31 维分成三类，分别算加权分：
 *   · 双方可核验且同类（both）  —— 这一维的对比能下结论
 *   · 只有我们能核验（ours）    —— 只能证明「我们有」，不能证明「他们没有」
 *   · 双方都不可核验（none）    —— 这一维什么都不能说
 *
 * 然后给出两个领先幅度：
 *   · 自评领先 = 全部维度加权差（就是 audit-lead 那个 1.5）
 *   · 可信领先 = **只在 both 维度上**算加权差（能下结论的部分）
 *
 * 为什么这个区分重要：如果可信领先 ≤0 而自评领先 >0，说明"领先"完全
 * 建立在不可核验的格子上 —— 那就是假绿，必须如实说出来。
 *
 * 四态：PASS 可信领先 > 0 / WARN 可信领先 ≤0 但自评领先 >0（领先不可信）/ FAIL 自评也落后
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const MATRIX = path.join(REPO, 'prototype/hermes-agents/matrix-data.json');
const GRADE = path.join(REPO, 'evidence/evolve/evidence-grade.json');
const CONF = path.join(REPO, 'evidence/evolve/matrix-confidence.json');

const SUBJECTS = ['chatgpt', 'claude', 'codex', 'cursor', 'trae', 'workbuddy', 'codebuddy', 'qoder',
  'dsh', 'openclaw', 'hermes', 'ecc', 'luanyujia', 'omp-studio', 'orca', 'aionui', 'pi-main',
  'WeKnora', 'open-design', 'CLR1T4S', 'craft-anything', 'solo-to-team-skills'];

/** 状态 → 分值（与 audit-lead 同口径：有=1 部分/借力=0.5 无=0） */
export function score(state) {
  if (state === '有') return 1;
  if (state === '部分') return 0.5;
  return 0;
}

/**
 * 给一维分类：both / mixed / ours / none
 *
 * 【2026-11-17 修·口径分裂】本文件原先自己实现了一套分类（按 verified+kind），
 * 结果与 tools/benchmark/matrix-confidence.mjs 不一致（22/6/3 vs 20/3/5/3）。
 * 同一个问题两个答案 = 迟早互相打脸。现在**只读 matrix-confidence.json**，
 * 它是唯一数据源（其判据写在 matrix-confidence.mjs:44-51）。
 */
export function classify(id, conf) {
  if (!conf) return 'none';
  const has = (arr) => Array.isArray(arr) && arr.some((x) => (typeof x === 'string' ? x : x && x.id) === id);
  if (has(conf.both)) return 'both';
  if (has(conf.mixed)) return 'mixed';
  if (has(conf.ours)) return 'ours';
  return 'none';
}

/**
 * 纯函数：给定矩阵维度与证据分级，算出分解结果
 * @param dims [{id,name,us,...refs}]
 * @param rows evidence-grade.rows（含 cells）
 */
export function decompose(dims, conf) {
  const buckets = { both: [], mixed: [], ours: [], none: [] };
  for (const d of dims) {
    const cls = classify(d.id, conf);
    (buckets[cls] || buckets.none).push(d);
  }

  const sumFor = (list, subject) => list.reduce((a, d) => {
    const c = d[subject];
    return a + (Array.isArray(c) ? score(c[0]) : 0);
  }, 0);

  const build = (list) => {
    const us = sumFor(list, 'us');
    const refs = {};
    for (const s of SUBJECTS) {
      const v = sumFor(list, s);
      if (v > 0) refs[s] = v;
    }
    const best = Object.entries(refs).sort((a, b) => b[1] - a[1])[0] || ['(无)', 0];
    return {
      n: list.length,
      us,
      bestRef: best[0],
      bestRefScore: best[1],
      margin: us - best[1],
      refs,
    };
  };

  const all = build([...buckets.both, ...buckets.mixed, ...buckets.ours, ...buckets.none]);
  const bothOnly = build(buckets.both);
  const oursOnly = build([...buckets.mixed, ...buckets.ours]);

  return {
    counts: {
      both: buckets.both.length, mixed: buckets.mixed.length,
      ours: buckets.ours.length, none: buckets.none.length,
    },
    all,
    bothOnly,
    oursOnly,
    bothIds: buckets.both.map((d) => d.id),
    mixedIds: buckets.mixed.map((d) => d.id),
    oursIds: buckets.ours.map((d) => d.id),
    noneIds: buckets.none.map((d) => d.id),
  };
}

/** 四态判定 */
export function verdictOf(d) {
  if (d.counts.both === 0) return 'UNKNOWN';
  if (d.bothOnly.margin > 0) return 'PASS';
  if (d.all.margin > 0) return 'WARN';   // 自评领先，但可信部分不领先
  return 'FAIL';
}

function main() {
  for (const p of [MATRIX, GRADE]) {
    if (!fs.existsSync(p)) {
      console.log('  ✗ 缺文件：' + p);
      console.log('\n  四态: UNKNOWN');
      return 2;
    }
  }
  const m = JSON.parse(fs.readFileSync(MATRIX, 'utf8'));
  const conf = fs.existsSync(CONF) ? JSON.parse(fs.readFileSync(CONF, 'utf8')) : null;
  if (!conf) {
    console.log('  ✗ 缺 matrix-confidence.json（请先跑 tools/benchmark/matrix-confidence.mjs）');
    console.log('\n  四态: UNKNOWN');
    return 2;
  }
  const dims = [];
  for (const grp of m.dimensions || []) for (const it of grp.items || []) dims.push(it);

  const d = decompose(dims, conf);
  const state = verdictOf(d);

  console.log('  领先幅度分解（31 维 → 按可比性分组）');
  console.log('  分组（来自 matrix-confidence.json）：双方可核验 ' + d.counts.both
    + ' · 证据异类 ' + d.counts.mixed + ' · 只有我们能核验 ' + d.counts.ours
    + ' · 双方都不可核验 ' + d.counts.none);
  console.log('');
  console.log('  ① 自评口径（全部 31 维）：我们 ' + d.all.us.toFixed(1)
    + ' vs 最强参照 ' + d.all.bestRef + ' ' + d.all.bestRefScore.toFixed(1)
    + ' ⇒ 差 ' + (d.all.margin >= 0 ? '+' : '') + d.all.margin.toFixed(1));
  console.log('  ② 可信口径（只在 ' + d.counts.both + ' 个双方可核验维上）：我们 ' + d.bothOnly.us.toFixed(1)
    + ' vs 最强参照 ' + d.bothOnly.bestRef + ' ' + d.bothOnly.bestRefScore.toFixed(1)
    + ' ⇒ 差 ' + (d.bothOnly.margin >= 0 ? '+' : '') + d.bothOnly.margin.toFixed(1));
  console.log('  ③ 不可核验部分（' + (d.counts.mixed + d.counts.ours) + ' 个证据异类/只有我们能核验维）：我们 ' + d.oursOnly.us.toFixed(1)
    + ' vs 最强参照 ' + d.oursOnly.bestRef + ' ' + d.oursOnly.bestRefScore.toFixed(1));
  console.log('');
  if (state === 'WARN') {
    console.log('  ⚠ 自评领先 ' + d.all.margin.toFixed(1) + ' 分，但可信口径是 ' + d.bothOnly.margin.toFixed(1)
      + ' 分 —— **领先主要建立在不可核验的格子上**，不能当作客观领先。');
  } else if (state === 'PASS') {
    console.log('  ✓ 即使在双方都可核验的 ' + d.counts.both + ' 维上我们仍领先 ' + d.bothOnly.margin.toFixed(1) + ' 分。');
  }
  console.log('\n  四态: ' + state);
  return state === 'PASS' ? 0 : state === 'WARN' ? 3 : state === 'FAIL' ? 1 : 2;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) process.exit(main());
