#!/usr/bin/env node
/**
 * 进化哨兵的变异测试
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runSuite } from './变异测试.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, '进化哨兵.mjs');

const NOW_MS = Date.parse('2026-11-09T12:00:00Z');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'eguard-base-'));

const SHARED_REL = path.join('dsh', '场景记忆', '_共享记忆');

function goodL1() {
  return {
    id: 'ev-20261109-001', scene: 'demo', level: 'L1', type: 'memory',
    target: '数据/.dsh/场景记忆/演示/场景私有记忆.md',
    change: '追加了一条坑与决策',
    trigger: '同类问题出现 3 次',
    at: new Date(NOW_MS - 86400000).toISOString(),
    observeUntil: '2026-12-31',
    result: 'improved',
    rolledBack: false,
    humanConfirmed: false,
    backtest: null,
  };
}

function goodL2() {
  return {
    id: 'ev-20261109-002', scene: 'demo', level: 'L2', type: 'skill',
    target: '数据/.dsh/skills/demo.md',
    change: '新增功能矩阵拆法一节',
    trigger: '竞品功能矩阵类任务失败 3 次',
    backtest: { cases: 3, passed: 3 },
    at: new Date(NOW_MS - 86400000).toISOString(),
    observeUntil: '2026-12-31',
    result: 'improved',
    rolledBack: false,
    humanConfirmed: false,
  };
}

function writeLedger(root, dispatches) {
  const p = path.join(root, SHARED_REL, '进化台账.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(dispatches, null, 2), 'utf8');
}

function makeBaseline() {
  fs.rmSync(path.join(BASE, 'dsh'), { recursive: true, force: true });
  writeLedger(BASE, {
    evolutions: [goodL1(), goodL2()],
    frozen: {},
  });
}
makeBaseline();

function mkCheck() {
  return {
    file: CHECK,
    env: { SEA_DATA_DIR: '{{DIR}}/dsh', SEA_NOW: String(NOW_MS) },
  };
}

function edit(d, fn) {
  const p = path.join(d, SHARED_REL, '进化台账.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  fn(j);
  fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
}

const cases = [
  {
    name: '原始基线应 PASS（L1 + L2 都合规）',
    baseline: BASE,
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS evolution-guard'] },
  },

  // ── INV-1 级别 ──
  {
    name: 'INV-1 变异: 级别 L9 不合法 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => edit(d, (j) => { j.evolutions[0].level = 'L9'; }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '级别不合法'] },
  },

  // ── INV-2 L1 只能改记忆 ──
  {
    name: 'INV-2 变异: L1 却改技能文件 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => edit(d, (j) => {
      j.evolutions[0].type = 'skill';
      j.evolutions[0].target = '数据/.dsh/skills/demo.md';
    }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', 'L1 只能追加记忆'] },
  },

  // ── INV-3 L2 必须回测 ──
  {
    name: 'INV-3 变异: L2 缺 backtest → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => edit(d, (j) => { j.evolutions[1].backtest = null; }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '缺 backtest'] },
  },
  {
    name: 'INV-3 变异: L2 回测只过 2/3 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => edit(d, (j) => { j.evolutions[1].backtest = { cases: 3, passed: 2 }; }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '回测未全通过'] },
  },
  {
    name: 'INV-3 边界: L2 回测 3/3 → 必须 PASS',
    baseline: BASE,
    mutate: (d) => edit(d, (j) => { j.evolutions[1].backtest = { cases: 3, passed: 3 }; }),
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS'] },
  },

  // ── INV-4 L3 必须人工确认 ──
  {
    name: 'INV-4 变异: L3 没人工确认 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => edit(d, (j) => {
      j.evolutions.push({
        id: 'ev-20261109-003', scene: 'demo', level: 'L3', type: 'identity',
        target: '数据/.dsh/场景记忆/演示/身份卡.md',
        change: '修订职责边界',
        trigger: '同类判断被纠正 2 次',
        at: new Date(NOW_MS).toISOString(),
        observeUntil: '2026-12-31',
        result: 'pending',
        humanConfirmed: false,
        confirmedBy: null,
      });
    }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '没有人工确认'] },
  },
  {
    name: 'INV-4 边界: L3 已人工确认 → 必须 PASS',
    baseline: BASE,
    mutate: (d) => edit(d, (j) => {
      j.evolutions.push({
        id: 'ev-20261109-004', scene: 'demo', level: 'L3', type: 'identity',
        target: '数据/.dsh/场景记忆/演示/身份卡.md',
        change: '修订职责边界',
        trigger: '同类判断被纠正 2 次',
        at: new Date(NOW_MS).toISOString(),
        observeUntil: '2026-12-31',
        result: 'pending',
        humanConfirmed: true,
        confirmedBy: '宿主',
      });
    }),
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS'] },
  },

  // ── INV-5 可追溯 ──
  {
    name: 'INV-5 变异: 缺 change → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => edit(d, (j) => { j.evolutions[0].change = ''; }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '缺 change'] },
  },

  // ── INV-6 观察期结束但未回填 ──
  {
    name: 'INV-6 变异: 观察期已过但仍 pending → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => edit(d, (j) => {
      j.evolutions[0].result = 'pending';
      j.evolutions[0].observeUntil = '2026-11-01';   // 已过期
    }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '观察期已结束'] },
  },
  {
    name: 'INV-6 边界: 观察期未过且 pending → 必须 PASS',
    baseline: BASE,
    mutate: (d) => edit(d, (j) => {
      j.evolutions[0].result = 'pending';
      j.evolutions[0].observeUntil = '2026-12-31';
    }),
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS'] },
  },

  // ── INV-7 冻结场景不该有新进化 ──
  {
    name: 'INV-7 变异: 冻结后仍有新 L2 进化 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => edit(d, (j) => {
      j.frozen = { demo: { at: new Date(NOW_MS - 3600000).toISOString(), reason: '连续退化' } };
      // L2 在冻结之后
      j.evolutions[1].at = new Date(NOW_MS).toISOString();
    }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '被冻结之后'] },
  },

  // ── INV-8 退化必须回滚 ──
  {
    name: 'INV-8 变异: degraded 但未回滚且无理由 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => edit(d, (j) => {
      j.evolutions[1].result = 'degraded';
      j.evolutions[1].rolledBack = false;
    }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '但未回滚'] },
  },
  {
    name: 'INV-8 边界: degraded 但已回滚 → 必须 PASS',
    baseline: BASE,
    mutate: (d) => edit(d, (j) => {
      j.evolutions[1].result = 'degraded';
      j.evolutions[1].rolledBack = true;
    }),
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS'] },
  },

  // ── 空台账 ──
  {
    name: '边界: 空台账 → 必须 PASS',
    baseline: BASE,
    mutate: (d) => edit(d, (j) => { j.evolutions = []; }),
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS'] },
  },
  {
    name: '边界: 台账文件不存在 → 必须 PASS',
    baseline: BASE,
    mutate: (d) => {
      fs.rmSync(path.join(d, SHARED_REL, '进化台账.json'), { force: true });
    },
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS'] },
  },

  // ── 反例验证 ──
  {
    name: '【反例验证】期望"应通过"但实际会失败 → 框架必须识别',
    baseline: BASE,
    mutate: (d) => edit(d, (j) => { j.evolutions[1].backtest = null; }),
    check: mkCheck(),
    expect: { exitNonZero: false },   // 故意写错
  },
];

console.log();
const normalCases = cases.slice(0, -1);
const negCase = cases[cases.length - 1];

runSuite('进化哨兵 · 变异测试', normalCases);

console.log('═'.repeat(66));
console.log('  反例验证');
console.log('═'.repeat(66));
console.log();
const { runCase } = await import('./变异测试.mjs');
const nr = runCase(negCase);
if (nr.ok === false) console.log('  OK   框架正确识别了错误的期望');
else { console.log('  XX   框架没能识别错误期望'); process.exitCode = 1; }
console.log();

try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
