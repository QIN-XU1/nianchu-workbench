#!/usr/bin/env node
/**
 * matrix-data.json 结构完整性守卫
 *
 * ── 为什么需要它 ────────────────────────────────────────
 * 2026-11-16 发现工作区的 matrix-data.json 被破坏成「1 组 16 维」，
 * 而 git 里所有历史版本都是「4 组 31 维」。
 *
 * 有 10 个工具会写这个文件，其中 measure-real-recall.mjs 会为了做突变检验
 * **临时修改它再恢复** —— 任何一次中途崩溃/并发冲突都会留下残缺文件。
 *
 * 残缺后的后果很隐蔽：verify-goal 的 R2 报「只有 16 维，要求 ≥30」，
 * 看起来像「矩阵没做完」，实际是文件被写坏了。
 *
 * ── 检查什么 ────────────────────────────────────────────
 *   FAIL     结构塌陷（组数 <4 或 维度数 <31）
 *   FAIL     有 item 缺 id / name / us
 *   FAIL     us 不是 [状态, 证据] 两元组
 *   WARN     维度数 ≥31 但不是 31（多了，可能重复写入）
 *   PASS     4 组 31 维且每个 item 结构完整
 *
 * 用法：node tools/benchmark/check-matrix-integrity.mjs [--selftest] [--quiet]
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const MATRIX = path.join(REPO, 'prototype/hermes-agents/matrix-data.json');

export const EXPECT = { groups: 4, dims: 31 };

/**
 * 内容级检查 —— 与 git HEAD 基线对比
 *
 * 【2026-11-16 加】起因：独立验证方 v-h0075 指出本工具只有 4 条形状检查，
 * 「文件被写坏」与「矩阵真没做完」会给出**逐字相同的 FAIL**，缺少区分信息源。
 * 内存探针实测漏报 6/6，包括仓库真实用过的 us=['有','']。
 *
 * 这里补上信息源：**跟 git HEAD 比**。
 *   · 某维 us 从「有」被改成「无」而无任何痕迹 ⇒ 可疑降级
 *   · 某维证据变成空白（含零宽字符）⇒ 假绿
 *   · 维度从 31 掉到更少 ⇒ 结构塌陷（形状检查已覆盖，这里给差异明细）
 *
 * @param cur 当前矩阵对象
 * @param base 基线矩阵对象（通常来自 git show HEAD:...）
 */
export function checkAgainstBaseline(cur, base) {
  const problems = [];
  const warnings = [];
  const ZW = /[\u200b-\u200f\u2060-\u2064\u3164\ufeff\u115f\u1160\u180e\u2800\u00ad]/g;
  const blank = (s) => !String(s == null ? '' : s).replace(ZW, '').trim();
  const flatten = (m) => {
    const out = new Map();
    for (const g of (m && m.dimensions) || []) {
      for (const it of g.items || []) out.set(it.id, it);
    }
    return out;
  };

  const c = flatten(cur);
  const b = flatten(base);

  for (const [id, bi] of b) {
    const ci = c.get(id);
    if (!ci) { problems.push(id + ' 在基线里有、现在没了（维度被删）'); continue; }
    const bs = Array.isArray(bi.us) ? bi.us[0] : null;
    const cs = Array.isArray(ci.us) ? ci.us[0] : null;
    const be = Array.isArray(bi.us) ? bi.us[1] : '';
    const ce = Array.isArray(ci.us) ? ci.us[1] : '';

    // ① 状态降级：有 → 无（且证据也跟着空）
    if (bs === '有' && cs === '无') {
      warnings.push(id + ' 状态从「有」被改成「无」（需人工确认是否真降级）');
    }
    // ② 证据变空白：最典型的假绿
    if (!blank(be) && blank(ce) && cs === '有') {
      problems.push(id + ' 声称「有」但证据相对基线变成了空白 —— 假绿');
    }
    // ③ 证据被大幅缩短（可能是截断/写坏）
    if (String(be).length > 80 && String(ce).length > 0
        && String(ce).length < String(be).length * 0.3) {
      warnings.push(id + ' 证据长度从 ' + String(be).length + ' 骤降到 '
        + String(ce).length + '（可能被截断）');
    }
  }
  for (const id of c.keys()) {
    if (!b.has(id)) warnings.push(id + ' 是新维度（基线里没有）');
  }

  const state = problems.length ? 'FAIL' : (warnings.length ? 'WARN' : 'PASS');
  return { state, problems, warnings, baselineDims: b.size, currentDims: c.size };
}

/** 纯函数：检查一个已解析的矩阵对象 */
export function checkMatrix(m, expect = EXPECT) {
  const problems = [];
  const warnings = [];

  if (!m || typeof m !== 'object' || !Array.isArray(m.dimensions)) {
    return { state: 'FAIL', problems: ['dimensions 不是数组'], warnings, groups: 0, dims: 0 };
  }

  const groups = m.dimensions.length;
  let dims = 0;
  const seen = new Set();

  for (const g of m.dimensions) {
    if (!g || !Array.isArray(g.items)) {
      problems.push('有一个组没有 items 数组');
      continue;
    }
    for (const it of g.items) {
      dims++;
      if (!it || typeof it !== 'object') { problems.push('item 不是对象'); continue; }
      if (!it.id) problems.push('item 缺 id: ' + JSON.stringify(it).slice(0, 40));
      else if (seen.has(it.id)) problems.push('重复 id: ' + it.id);
      else seen.add(it.id);
      if (!it.name) problems.push((it.id || '?') + ' 缺 name');
      if (!Array.isArray(it.us) || it.us.length !== 2) {
        problems.push((it.id || '?') + ' 的 us 不是 [状态, 证据] 两元组');
      }
    }
  }

  if (groups < expect.groups) problems.push('组数 ' + groups + ' < ' + expect.groups + '（结构塌陷）');
  if (dims < expect.dims) problems.push('维度数 ' + dims + ' < ' + expect.dims + '（结构塌陷）');
  if (dims > expect.dims) warnings.push('维度数 ' + dims + ' > ' + expect.dims + '（可能重复写入）');

  const state = problems.length ? 'FAIL' : (warnings.length ? 'WARN' : 'PASS');
  return { state, problems, warnings, groups, dims };
}

/** 自检 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  const good = {
    dimensions: [
      { id: 'A', items: Array.from({ length: 31 }, (_, i) => ({ id: 'D' + i, name: 'n', us: ['有', 'e'] })) },
      { id: 'B', items: [] }, { id: 'C', items: [] }, { id: 'D', items: [] },
    ],
  };
  T('正例 · 4 组 31 维结构完整 ⇒ PASS', checkMatrix(good).state === 'PASS', checkMatrix(good).state);

  const collapsed = { dimensions: [{ id: 'A', items: Array.from({ length: 16 }, (_, i) => ({ id: 'D' + i, name: 'n', us: ['有', 'e'] })) }] };
  const r2 = checkMatrix(collapsed);
  T('反例 · 1 组 16 维（真实事故形态）⇒ FAIL',
    r2.state === 'FAIL' && r2.problems.some((p) => p.includes('塌陷')), JSON.stringify(r2.problems));

  const noUs = { dimensions: Array.from({ length: 4 }, () => ({ id: 'x', items: Array.from({ length: 8 }, (_, i) => ({ id: 'Z' + i + Math.random(), name: 'n' })) })) };
  T('反例 · item 缺 us ⇒ FAIL', checkMatrix(noUs).state === 'FAIL', '');

  const dup = { dimensions: [{ id: 'A', items: Array.from({ length: 31 }, () => ({ id: 'SAME', name: 'n', us: ['有', 'e'] })) }, { id: 'B', items: [] }, { id: 'C', items: [] }, { id: 'D', items: [] }] };
  T('反例 · 重复 id ⇒ FAIL', checkMatrix(dup).state === 'FAIL', '');

  T('反例 · 空对象 ⇒ FAIL（不许当 PASS）', checkMatrix({}).state === 'FAIL', '');
  T('反例 · null ⇒ FAIL（不许崩）', checkMatrix(null).state === 'FAIL', '');

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

const isMain = /[\\/]check-matrix-integrity\.mjs$/.test(process.argv[1] || '');

if (isMain && process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  矩阵结构守卫 · 自检');
  console.log('  ' + '─'.repeat(70));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

if (isMain) {
  if (!fs.existsSync(MATRIX)) {
    console.log('  ❔ 矩阵文件不存在');
    process.exit(2);
  }
  let m;
  try { m = JSON.parse(fs.readFileSync(MATRIX, 'utf8')); }
  catch (e) { console.log('  ❌ JSON 解析失败: ' + e.message); process.exit(1); }

  const r = checkMatrix(m);
  if (!process.argv.includes('--quiet')) {
    console.log('');
    console.log('  矩阵结构守卫 —— matrix-data.json 有没有被写坏');
    console.log('  ' + '='.repeat(70));
    console.log('  组数 ' + r.groups + ' / 期望 ' + EXPECT.groups
      + ' · 维度 ' + r.dims + ' / 期望 ' + EXPECT.dims);
    console.log('  四态: ' + r.state);
    if (r.problems.length) {
      console.log('');
      console.log('  ❌ 问题:');
      for (const p of r.problems) console.log('      ' + p);
    }
    if (r.warnings.length) {
      console.log('');
      console.log('  ⚠ 警告:');
      for (const w of r.warnings) console.log('      ' + w);
    }
    console.log('');
  }
  process.exit(r.state === 'FAIL' ? 1 : (r.state === 'WARN' ? 3 : 0));
}
