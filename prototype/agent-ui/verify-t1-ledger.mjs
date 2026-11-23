#!/usr/bin/env node
/**
 * T1 改进闭环台账 · 常驻验收器（含反例）
 *
 * 判据（照终点的 T1）：
 *  ① ≥10 轮已结案（status === 'closed'）
 *  ② 其中 ≥3 轮由**非实现方**独立验证（independent === true）
 *  ③ 每轮有基线值 + 前后度量 + 样本量
 *
 * 【2026-11-17 修·根因】上一版临时脚本用错字段名（查 before/verifiedBy），
 * 而台账真实字段是 baseline / expect / after / samples / verifier / independent，
 * 导致把 25 条达标记录误报成 0（假红）。本版按真实字段核对，并配反例。
 *
 * 四态：PASS 三条件全满足 / WARN 有结案但某条件不足 / FAIL 台账损坏 / UNKNOWN 台账不存在
 */
import fs from 'node:fs';
import path from 'node:path';

export const REQUIRED = { closed: 10, independent: 3 };

/** 单条是否四要素齐（基线 + 前后度量 + 样本量） */
export function hasFourElements(e) {
  const hasBaseline = e.baseline !== undefined && e.baseline !== null && e.baseline !== '';
  const hasAfter = e.after !== undefined && e.after !== null;
  const hasMetric = typeof e.metric === 'string' && e.metric.trim() !== '';
  const hasSamples = typeof e.samples === 'number' && e.samples > 0;
  return { hasBaseline, hasAfter, hasMetric, hasSamples, ok: hasBaseline && hasAfter && hasMetric && hasSamples };
}

/** 统计台账（纯函数，可单测） */
export function auditLedger(entries) {
  const all = Array.isArray(entries) ? entries : [];
  const closed = all.filter((e) => e && e.status === 'closed');
  const closedComplete = closed.filter((e) => hasFourElements(e).ok);
  const independent = closed.filter((e) => e && e.independent === true);
  const independentComplete = independent.filter((e) => hasFourElements(e).ok);

  const c1 = closedComplete.length >= REQUIRED.closed;
  const c2 = independentComplete.length >= REQUIRED.independent;
  const c3 = closedComplete.length > 0 && closedComplete.length === closed.length;

  const state = (c1 && c2) ? 'PASS' : (closed.length > 0 ? 'WARN' : 'WARN');
  return {
    state,
    total: all.length,
    closed: closed.length,
    closedComplete: closedComplete.length,
    independent: independent.length,
    independentComplete: independentComplete.length,
    conditions: {
      atLeast10Closed: { ok: c1, got: closedComplete.length, need: REQUIRED.closed },
      atLeast3Independent: { ok: c2, got: independentComplete.length, need: REQUIRED.independent },
      allClosedHaveFourElements: { ok: c3, got: closedComplete.length, of: closed.length },
    },
  };
}

// ── 反例自检 + CLI ──
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const REPO = path.resolve(import.meta.dirname, '../..');
  const LEDGER = path.join(REPO, 'research/改进台账.json');

  // 自检（反例必须能红）
  let pass = 0, total = 0;
  const lines = [];
  const T = (n, ok, w) => { total++; if (ok) pass++; lines.push('  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)); };

  const mk = (o) => ({ id: 'x', status: 'closed', baseline: 1, after: 2, metric: 'm', samples: 5, independent: true, ...o });

  T('正例 · 10 条四要素齐 + 3 条独立 ⇒ PASS',
    auditLedger(Array.from({ length: 10 }, (_, i) => mk({ id: 'a' + i }))).state === 'PASS', 'not PASS');

  T('反例 · 只有 9 条 ⇒ 不达 ≥10', auditLedger(Array.from({ length: 9 }, (_, i) => mk({ id: 'a' + i }))).conditions.atLeast10Closed.ok === false, '不该达标');

  T('反例 · 缺 baseline 的条目不计数',
    auditLedger([...Array.from({ length: 10 }, (_, i) => mk({ id: 'a' + i })), mk({ id: 'bad', baseline: undefined })]).closedComplete === 10, '不该计入');

  T('反例 · 缺 samples 的条目不计数',
    auditLedger([...Array.from({ length: 10 }, (_, i) => mk({ id: 'a' + i })), mk({ id: 'bad', samples: 0 })]).closedComplete === 10, '不该计入');

  T('反例 · samples=0 视为无样本量', hasFourElements({ baseline: 1, after: 2, metric: 'm', samples: 0 }).ok === false, '不该通过');

  T('反例 · 独立验证 <3 条 ⇒ 不达标',
    auditLedger(Array.from({ length: 10 }, (_, i) => mk({ id: 'a' + i, independent: i < 2 }))).conditions.atLeast3Independent.ok === false, '不该达标');

  T('反例 · independent=false 不算独立验证',
    auditLedger(Array.from({ length: 3 }, (_, i) => mk({ id: 'n' + i, independent: false }))).independent === 0, '不该计入');

  T('反例 · 非 closed 状态不计入结案',
    auditLedger([mk({ status: 'partial' }), mk({ status: 'refuted' })]).closed === 0, '不该计入');

  T('正例 · 空台账 ⇒ WARN（不是 PASS）', auditLedger([]).state === 'WARN', '空台账不该 PASS');

  // 真实台账
  if (!fs.existsSync(LEDGER)) {
    console.log(lines.join('\n'));
    console.log('\n  台账不存在 ⇒ 四态: UNKNOWN');
    process.exit(2);
  }
  let j;
  try { j = JSON.parse(fs.readFileSync(LEDGER, 'utf8')); }
  catch (e) {
    console.log(lines.join('\n'));
    console.log('\n  台账损坏：' + e.message + ' ⇒ 四态: FAIL');
    process.exit(1);
  }
  const r = auditLedger(j.entries || []);
  T('正例 · 真实台账可解析', r.total > 0, 'total=' + r.total);

  const ok = pass === total;
  console.log('  T1 改进闭环台账验收（含反例自检）');
  console.log(lines.join('\n'));
  console.log('\n  真实台账：' + r.total + ' 条 · closed ' + r.closed + ' · 四要素齐 ' + r.closedComplete + ' · 独立验证 ' + r.independentComplete);
  console.log('  ① ≥10 结案：' + r.conditions.atLeast10Closed.got + '/' + r.conditions.atLeast10Closed.need + (r.conditions.atLeast10Closed.ok ? ' ✓' : ' ✗'));
  console.log('  ② ≥3 独立验证：' + r.conditions.atLeast3Independent.got + '/' + r.conditions.atLeast3Independent.need + (r.conditions.atLeast3Independent.ok ? ' ✓' : ' ✗'));
  console.log('  ③ 结案均四要素齐：' + r.conditions.allClosedHaveFourElements.got + '/' + r.conditions.allClosedHaveFourElements.of + (r.conditions.allClosedHaveFourElements.ok ? ' ✓' : ' ✗'));
  const finalState = ok ? r.state : 'FAIL';
  console.log('\n  验收 ' + pass + '/' + total + ' · T1 四态: ' + finalState);
  process.exit(finalState === 'PASS' ? 0 : finalState === 'FAIL' ? 1 : 3);
}
