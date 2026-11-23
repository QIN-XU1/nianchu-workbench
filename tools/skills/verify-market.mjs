#!/usr/bin/env node
/**
 * 技能市场（检索层）验收 —— A12 第三条线
 *
 * 要证明的：
 *   1. 能检索：按 name / description / category / tags 命中，多词是 AND
 *   2. 能区分「已装」与「可装」——这是市场的核心语义
 *   3. 索引缺失/损坏时如实降级（不假装有数据）
 *   4. 索引与技能池不一致时，**以池为准**（池是事实）
 *   5. 默认不联网（只读本地）
 *
 * 反例重点：
 *   · 索引里有但池里没有 → 必须标 installed=false（不是「已装」）
 *   · 索引损坏 → 必须标 corrupt，而不是静默返回空
 *   · 空 query → 返回全部，不是返回空
 *
 * 四态：0 全通过 · 1 有失败 · 2 工具自检失败
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let pass = 0, fail = 0;
const t = (name, cond, info = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

const SKILL = (name, desc, cat) => `---
name: ${name}
category: ${cat}
description: ${desc}
---

# ${name}

正文。
`;

async function main() {
  const { search, readIndex, scanPool, buildIndex, INDEX_NAME } =
    await import('../skills/market.mjs');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nianchu-market-'));
  const pool = path.join(tmpRoot, 'scenes');
  fs.mkdirSync(pool, { recursive: true });

  const put = (name, desc, cat) => {
    const d = path.join(pool, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), SKILL(name, desc, cat), 'utf8');
  };

  console.log('\n  0. 空池：不能崩，也不能假装有数据');
  const r0 = search({ target: pool });
  t('空池返回 0 条', r0.total === 0, 'total=' + r0.total);
  t('空池标记 indexMissing', r0.indexMissing === true);
  t('scanPool 返回空数组', Array.isArray(scanPool(pool)) && scanPool(pool).length === 0);

  console.log('\n  1. 扫描技能池');
  put('alpha-skill', '处理 alpha 相关的任务', '工程');
  put('beta-skill', '处理 beta 相关的任务', '写作');
  put('gamma-skill', '完全不同的东西 gamma', '数据');
  const poolRows = scanPool(pool);
  t('扫到 3 个技能', poolRows.length === 3, '实际 ' + poolRows.length);
  t('解析出 description', poolRows.find((x) => x.name === 'alpha-skill')?.description === '处理 alpha 相关的任务');
  t('解析出 category', poolRows.find((x) => x.name === 'beta-skill')?.category === '写作');
  t('按名字排序', poolRows.map((x) => x.name).join(',') === 'alpha-skill,beta-skill,gamma-skill');

  console.log('\n  2. 检索：name / description / category');
  const rA = search({ target: pool, query: 'alpha' });
  t('按 name 命中 alpha-skill', rA.total === 1 && rA.rows[0].name === 'alpha-skill', JSON.stringify(rA.rows.map((x) => x.name)));
  const rD = search({ target: pool, query: '完全不同的东西' });
  t('按 description 命中 gamma-skill', rD.total === 1 && rD.rows[0].name === 'gamma-skill');
  const rC = search({ target: pool, query: '写作' });
  t('按 category 命中 beta-skill', rC.total === 1 && rC.rows[0].name === 'beta-skill');
  const rEmpty = search({ target: pool, query: '' });
  t('空 query 返回全部（不是空）', rEmpty.total === 3, 'total=' + rEmpty.total);
  const rNo = search({ target: pool, query: 'zzz不存在zzz' });
  t('无命中返回 0（不是全部）', rNo.total === 0);

  console.log('\n  3. 多词检索是 AND');
  const rAnd = search({ target: pool, query: '处理 alpha' });
  t('"处理 alpha" 命中 alpha-skill', rAnd.total === 1 && rAnd.rows[0].name === 'alpha-skill', JSON.stringify(rAnd.rows.map((x) => x.name)));
  const rAnd2 = search({ target: pool, query: '处理 zzz' });
  t('"处理 zzz" 无命中（AND 语义）', rAnd2.total === 0, 'total=' + rAnd2.total);

  console.log('\n  4. category 过滤');
  const rCat = search({ target: pool, category: '工程' });
  t('category=工程 只命中 alpha-skill', rCat.total === 1 && rCat.rows[0].name === 'alpha-skill');
  const rCatNone = search({ target: pool, category: '不存在的分类' });
  t('不存在的分类 → 0 条', rCatNone.total === 0);

  console.log('\n  5. 已装 / 可装 的区分（市场核心语义）');
  // 造一个「索引里有、池里没有」的条目 → 必须是「可装」
  buildIndex(pool, [
    { name: 'remote-one', description: '远程可装技能', category: '工程', version: '2.1.0', origin: 'remote:test', tags: ['remote'] },
  ]);
  const idx = readIndex(pool);
  t('索引含 4 条（3 池 + 1 远程）', idx.entries.length === 4, '实际 ' + idx.entries.length);
  const rAll = search({ target: pool });
  const remote = rAll.rows.find((x) => x.name === 'remote-one');
  t('远程条目出现在市场里', !!remote);
  t('远程条目 installed=false（可装）', remote && remote.installed === false, JSON.stringify(remote));
  const local = rAll.rows.find((x) => x.name === 'alpha-skill');
  t('池里的 installed=true', local && local.installed === true);
  t('可装的排在已装前面', rAll.rows[0].installed === false, '第一行: ' + rAll.rows[0].name + ' installed=' + rAll.rows[0].installed);

  console.log('\n  6. 索引与池不一致时以池为准');
  // 索引说有 alpha-skill（版本 1.0.0），池里也有 → source 应为 index+pool
  const alpha = rAll.rows.find((x) => x.name === 'alpha-skill');
  t('索引与池都有 → source=index+pool', alpha && alpha.source === 'index+pool', JSON.stringify(alpha));
  // 索引里有 remote-one 但池里没有 → source=index
  t('只在索引 → source=index', remote && remote.source === 'index');

  console.log('\n  7. 索引损坏：必须如实标记（不静默返回空）');
  fs.writeFileSync(path.join(pool, INDEX_NAME), '{ 坏掉的 JSON', 'utf8');
  const rBad = readIndex(pool);
  t('readIndex 报 corrupt', rBad.corrupt === true);
  t('损坏时 entries 为空', Array.isArray(rBad.entries) && rBad.entries.length === 0);
  const rBadSearch = search({ target: pool });
  t('损坏时仍能列出池里的技能（不整体失败）', rBadSearch.total === 3, 'total=' + rBadSearch.total);
  t('损坏时标记 indexCorrupt', rBadSearch.indexCorrupt === true);

  console.log('\n  8. 索引缺失：如实降级');
  fs.rmSync(path.join(pool, INDEX_NAME));
  const rNoIdx = search({ target: pool });
  t('缺失时标记 indexMissing', rNoIdx.indexMissing === true);
  t('缺失时仍列出池里的技能', rNoIdx.total === 3, 'total=' + rNoIdx.total);

  console.log('\n  9. limit 生效');
  const rLim = search({ target: pool, limit: 2 });
  t('limit=2 → 只返回 2 条', rLim.shown === 2 && rLim.rows.length === 2, 'shown=' + rLim.shown);
  t('total 仍是全量（不被 limit 影响）', rLim.total === 3, 'total=' + rLim.total);

  console.log('\n  10. 真实技能池可用（反假绿）');
  const realPool = path.join(ROOT, 'prototype/scenes');
  const real = search({ target: realPool, query: 'debug' });
  t('真实池里能搜到 debug-repro', real.rows.some((x) => x.name === 'debug-repro'), JSON.stringify(real.rows.map((x) => x.name)));
  const realAll = search({ target: realPool });
  t('真实池技能数 ≥ 25', realAll.total >= 25, 'total=' + realAll.total);
  t('真实池分类 ≥ 3 个', realAll.categories.length >= 3, JSON.stringify(realAll.categories));

  // 清理
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 尽力 */ }

  console.log('\n  ──────────────────────────────────────────');
  console.log('  通过 ' + pass + ' · 失败 ' + fail);
  const state = fail > 0 ? 'FAIL' : (pass > 0 ? 'PASS' : 'UNKNOWN');
  console.log('  四态: ' + state);
  process.exit(state === 'FAIL' ? 1 : state === 'UNKNOWN' ? 2 : 0);
}

main().catch((e) => {
  console.error('  ✗ 工具自检失败：' + (e && e.stack || e));
  process.exit(2);
});
