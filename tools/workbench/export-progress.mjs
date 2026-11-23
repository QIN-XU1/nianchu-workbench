#!/usr/bin/env node
/**
 * 导出「进度」面板要的数据。
 *
 * 数据全部真实：
 *   · 五条终点条件 —— 真跑 verify-goal.mjs，从输出里解析（不是抄文档）
 *   · 台账轮次     —— 读 research/改进台账.json
 *   · 矩阵诚实度   —— 读 evidence/evolve/matrix-vs-audit.json（独立审计对照）
 *
 * 为什么要真跑：上一轮刚吃过教训 —— 界面上写着「通过」，实际是抄来的旧结论。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(ROOT, 'apps/vouch-web/src/web-ui/src/app/scenes/workbench/data/progress.json');

const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

// ── 1) 真跑 verify-goal ──
const vg = spawnSync(process.execPath, ['verify-goal.mjs'], {
  cwd: join(ROOT, 'prototype/hermes-agents'),
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});
const vgOut = (vg.stdout || '') + (vg.stderr || '');

/** 从 verify-goal 输出里解析每条硬要求：✅/❌/❔ + 编号 + 标题 + 细节行 */
/**
 * 解析全部检查行。注意三种 mark：
 *   ✅ PASS / ❌ FAIL / 🟡 WARN / ❔ UNKNOWN
 * 【2026-11-17 修】原来只认 ✅❌❔，漏掉了 🟡（WARN）—— R3 就是 🟡，
 * 结果 22 条只解析到 13 条，进度面板会少显示一半。
 */
const requirements = [];
const lines = vgOut.split(/\r?\n/);
const MARK = { '✅': 'PASS', '❌': 'FAIL', '🟡': 'WARN', '❔': 'UNKNOWN' };
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\s*(✅|❌|🟡|❔)\s*([A-Z]\d+)\s+(.+?)\s*$/);
  if (!m) continue;
  const detail = (lines[i + 1] || '').trim();
  requirements.push({
    mark: m[1],
    id: m[2],
    title: m[3],
    kind: /^R\d+$/.test(m[2]) ? 'hardRequirement' : 'dimensionCheck',
    state: MARK[m[1]] || 'UNKNOWN',
    detail: /^(✅|❌|🟡|❔)/.test(detail) ? '' : detail,
  });
}

const tally = (() => {
  const m = vgOut.match(/通过\s*(\d+)\s*待补\s*(\d+)\s*失败\s*(\d+)\s*无法判断\s*(\d+)/);
  if (!m) return null;
  return { pass: +m[1], pending: +m[2], fail: +m[3], unknown: +m[4] };
})();

// ── 2) 五条终点条件（T1..T5）──
// 【2026-11-17 修】上一版我**编了一张 T→R 映射表**（把 R5 说成「四态贯通」，
// 实际 R5 是「界面截图」）。那是把推测当事实，已删。
// 现在的做法：只在验收器**自己写了** T 编号时才映射；没写的如实标「未单列」。
// 实测：verify-goal 的 22 条里只有 R11 的标题写了「T5」，其余 T1–T4 没有单列。
const T_DEFS = [
  { id: 'T1', name: '闭环在转' },
  { id: 'T2', name: '度量可信' },
  { id: 'T3', name: '四态贯通' },
  { id: 'T4', name: '六主张可验' },
  { id: 'T5', name: '横向领先' },
];
const conditions = T_DEFS.map((t) => {
  const rs = requirements.filter((r) => r.title.includes(t.id));
  const states = rs.map((r) => r.state);
  const state = rs.length === 0 ? 'UNKNOWN'
    : states.includes('FAIL') ? 'FAIL'
      : states.includes('UNKNOWN') ? 'UNKNOWN'
        : states.every((s) => s === 'PASS') ? 'PASS' : 'WARN';
  return {
    id: t.id,
    name: t.name,
    state,
    mappedBy: rs.length ? 'verify-goal 标题里写了 ' + rs.map((r) => r.id).join(',') : '验收器未单列（不是通过）',
    reqs: rs.map((r) => ({ id: r.id, title: r.title, state: r.state, detail: r.detail })),
  };
});

// ── 3) 台账 ──
const ledger = readJson('research/改进台账.json');
const entries = ledger.entries || [];
const closedIndependent = entries.filter((e) => e.status === 'closed' && e.independent === true);
const recent = [...entries].slice(-12).reverse().map((e) => ({
  id: e.id,
  at: e.at,
  status: e.status,
  independent: e.independent === true,
  obs: String(e.obs || '').slice(0, 140),
  metric: e.metric || '',
  baseline: e.baseline,
  after: e.after,
  samples: e.samples,
  verifier: e.verifier || '',
}));

// ── 4) 矩阵诚实度 ──
let matrix = null;
const cmpPath = 'evidence/evolve/matrix-vs-audit.json';
if (existsSync(join(ROOT, cmpPath))) {
  const c = readJson(cmpPath);
  matrix = {
    at: c.at,
    auditor: c.auditor,
    total: c.total,
    fakeGreen: c.summary?.fakeGreen ?? null,
    underClaimed: c.summary?.underClaimed ?? null,
    ourVerdicts: c.summary?.ourVerdicts || {},
    auditVerdicts: c.summary?.auditVerdicts || {},
    ok: c.ok === true,
    issues: c.issues || [],
  };
}

/** 工作树脏时 R8 必红、R9 会连锁红 —— 这个快照不能当基线用，必须标出来 */
const gitStatus = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
const dirty = (gitStatus.stdout || '').trim().split(/\r?\n/).filter(Boolean);

const payload = {
  at: new Date().toISOString(),
  snapshot: {
    dirtyFiles: dirty.length,
    usableAsBaseline: dirty.length === 0 && vg.status === 0,
    why: dirty.length ? '工作树有 ' + dirty.length + ' 个未提交改动 ⇒ R8 会红 ⇒ 不是有效基线' : '',
  },
  verifyGoal: {
    exitCode: vg.status,
    ranAt: new Date().toISOString(),
    tally,
    requirements,
    rawTail: vgOut.split(/\r?\n/).filter(Boolean).slice(-3),
  },
  conditions,
  ledger: {
    total: entries.length,
    closed: entries.filter((e) => e.status === 'closed').length,
    closedIndependent: closedIndependent.length,
    partial: entries.filter((e) => e.status === 'partial').length,
    refuted: entries.filter((e) => e.status === 'refuted').length,
    unknown: entries.filter((e) => e.status === 'unknown').length,
    recent,
  },
  matrix,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');

console.log('  写出 → ' + relative(ROOT, OUT).split('\\').join('/'));
console.log('  verify-goal exit=' + vg.status + '  解析到 ' + requirements.length + ' 条硬要求');
if (tally) console.log('  通过 ' + tally.pass + ' / 待补 ' + tally.pending + ' / 失败 ' + tally.fail + ' / 判不了 ' + tally.unknown);
for (const c of conditions) console.log('    ' + c.id + ' ' + c.name + ' → ' + c.state);
console.log('  台账 ' + payload.ledger.total + ' 条，closed 且独立 ' + payload.ledger.closedIndependent);
if (matrix) console.log('  矩阵假绿 ' + matrix.fakeGreen + '（审计员 ' + matrix.auditor + '）');
