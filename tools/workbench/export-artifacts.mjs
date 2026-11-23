#!/usr/bin/env node
/**
 * 导出「工作台画布」数据 —— 画布上的每张卡都必须来自真实文件/真实运行
 *
 * 原则（沿用既有约束）：
 *   · 不许塞假数据。拿不到就标 UNKNOWN，不许用推测填空
 *   · 每张卡带 at（生成时间）与 source（来源路径），供界面显示新鲜度
 *   · verify-goal 的结果不在文件里，必须**真跑**一次并解析
 *     （它可能因未提交文件而非零退出 —— 那也要解析 stdout，不能当成"没跑"）
 *
 * 输出：apps/vouch-web/src/web-ui/src/app/scenes/workbench/data/artifacts.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(REPO, 'apps/vouch-web/src/web-ui/src/app/scenes/workbench/data/artifacts.json');

const readJson = (rel) => {
  const p = path.join(REPO, rel);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};

const now = new Date().toISOString();
const artifacts = [];
const notes = [];

// ── ① 四态贯通审计 ──
{
  const d = readJson('evidence/evolve/four-state-layers.json');
  if (!d) {
    artifacts.push({ id: 'four-state', kind: 'state', title: '四态贯通', verdict: 'UNKNOWN', at: null,
      source: 'evidence/evolve/four-state-layers.json', summary: '文件不存在 —— 判不了', metrics: [] });
    notes.push('four-state: 文件缺失');
  } else {
    const layers = Array.isArray(d.layers) ? d.layers : [];
    const passed = Number(d.layersOk ?? layers.filter((l) => l.ok).length);
    const totalL = Number(d.totalLayers ?? layers.length);
    const casesOk = Number(d.passedCases ?? 0);
    const casesAll = Number(d.totalCases ?? 0);
    // 状态以审计自己报的 state 为准（它是四态的权威），缺失才退回推算
    const declared = typeof d.state === 'string' ? d.state.toUpperCase() : null;
    const verdict = declared && ['PASS', 'WARN', 'FAIL', 'UNKNOWN'].includes(declared)
      ? declared
      : (totalL === 0 ? 'UNKNOWN' : passed === totalL ? 'PASS' : 'WARN');
    artifacts.push({
      id: 'four-state',
      kind: 'state',
      title: '四态贯通',
      verdict,
      at: d.at || null,
      source: 'evidence/evolve/four-state-layers.json',
      summary: '观测→验证→记忆→改进→证明 五层，UNKNOWN 不并入通过',
      metrics: [
        { label: '层', value: passed + '/' + totalL },
        { label: '案例', value: casesOk + '/' + casesAll },
      ],
    });
  }
}

// ── ② 矩阵可比度 ──
{
  const d = readJson('evidence/evolve/matrix-confidence.json');
  if (!d) {
    artifacts.push({ id: 'matrix', kind: 'matrix', title: '31 维矩阵', verdict: 'UNKNOWN', at: null,
      source: 'evidence/evolve/matrix-confidence.json', summary: '文件不存在 —— 判不了', metrics: [] });
    notes.push('matrix: 文件缺失');
  } else {
    const both = (d.both || []).length;
    const total = Number(d.total || 31);
    const pct = d.pct && typeof d.pct === 'object' ? d.pct : {};
    artifacts.push({
      id: 'matrix',
      kind: 'matrix',
      title: '31 维矩阵',
      verdict: both >= total ? 'PASS' : both > 0 ? 'WARN' : 'UNKNOWN',
      at: d.at || null,
      source: 'evidence/evolve/matrix-confidence.json',
      summary: '双方证据同类才可比；其余如实标注不可比',
      metrics: [
        { label: '可比', value: both + '/' + total + '（' + (pct.both ?? '?') + '%）' },
        { label: '证据异类', value: String(pct.mixed ?? (d.mixed || []).length) },
        { label: '仅我方', value: String(pct.ours ?? (d.ours || []).length) },
        { label: '都不可核验', value: String(pct.none ?? (d.none || []).length) },
      ],
    });
  }
}

// ── ③ 改进台账 ──
{
  const d = readJson('research/改进台账.json');
  const entries = Array.isArray(d) ? d : (d && (d.entries || d.rounds)) || null;
  if (!entries) {
    artifacts.push({ id: 'ledger', kind: 'ledger', title: '改进台账', verdict: 'UNKNOWN', at: null,
      source: 'research/改进台账.json', summary: '文件不存在或结构不认识 —— 判不了', metrics: [] });
    notes.push('ledger: 缺失或结构不明');
  } else {
    const by = {};
    for (const e of entries) by[e.status || '?'] = (by[e.status || '?'] || 0) + 1;
    const closed = by.closed || 0;
    artifacts.push({
      id: 'ledger',
      kind: 'ledger',
      title: '改进台账',
      verdict: closed >= 10 ? 'PASS' : closed > 0 ? 'WARN' : 'UNKNOWN',
      at: (d && d.at) || null,
      source: 'research/改进台账.json',
      summary: 'T1 要求 ≥10 轮已结案 + 每轮有基线/前后度量/样本量',
      metrics: [
        { label: '条目', value: String(entries.length) },
        { label: 'closed', value: String(closed) },
        { label: 'partial', value: String(by.partial || 0) },
        { label: 'refuted', value: String(by.refuted || 0) },
        { label: 'unknown', value: String(by.unknown || 0) },
      ],
    });
  }
}

// ── ④ verify-goal（必须真跑）──
{
  let verdict = 'UNKNOWN';
  let metrics = [];
  let summary = '未运行 —— 判不了（不是通过）';
  // 用 spawnSync：verify-goal 在有未提交文件时会非零退出，
  // 但 stdout 仍然完整 —— 不能用 execFileSync（它一非零就丢输出）
  const r = spawnSync('node', ['prototype/hermes-agents/verify-goal.mjs'], {
    cwd: REPO, encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = /通过 (\d+)\s+待补 (\d+)\s+失败 (\d+)\s+无法判断 (\d+)/.exec(out);
  if (m) {
    verdict = Number(m[3]) > 0 ? 'FAIL' : (Number(m[2]) > 0 || Number(m[4]) > 0) ? 'WARN' : 'PASS';
    metrics = [
      { label: '通过', value: m[1] },
      { label: '待补', value: m[2] },
      { label: '失败', value: m[3] },
      { label: '判不了', value: m[4] },
    ];
    summary = '硬要求逐条验收；「判不了」永远单列，不并入通过';
    if (r.status !== 0) notes.push('verify-goal: 非零退出(' + r.status + ')，但 stdout 完整并已解析');
  } else {
    summary = '跑完了但没解析到统计行 —— 判不了';
    notes.push('verify-goal: 输出格式没匹配上（status=' + r.status + '）');
  }
  artifacts.push({
    id: 'verify-goal',
    kind: 'verify',
    title: '目标验收 verify-goal',
    verdict,
    at: now,
    source: 'prototype/hermes-agents/verify-goal.mjs',
    summary,
    metrics,
  });
}

// ── ⑤ 派单账本（在浏览器 localStorage，导出阶段读不到）──
{
  artifacts.push({
    id: 'dispatch',
    kind: 'dispatch',
    title: '派单与回执',
    verdict: 'UNKNOWN',
    at: null,
    source: 'localStorage（任务分派账本）',
    summary: '账本在浏览器本地，导出时读不到 —— 界面上会实时读',
    metrics: [],
  });
  notes.push('dispatch: 数据在 localStorage，导出阶段不可读（界面侧直接读）');
}

const summary = {
  at: now,
  count: artifacts.length,
  verdicts: artifacts.reduce((a, x) => { a[x.verdict] = (a[x.verdict] || 0) + 1; return a; }, {}),
  notes,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ summary, artifacts }, null, 2) + '\n', 'utf8');

console.log('  工作台画布数据已导出 → ' + path.relative(REPO, OUT));
console.log('  卡片 ' + artifacts.length + ' 张 · 四态 ' + JSON.stringify(summary.verdicts));
for (const a of artifacts) {
  console.log('    ' + a.verdict.padEnd(7) + ' ' + a.title + '  [' + a.metrics.map((m) => m.label + ' ' + m.value).join(' · ') + ']');
}
if (notes.length) {
  console.log('  说明（如实记录）：');
  for (const n of notes) console.log('    · ' + n);
}
