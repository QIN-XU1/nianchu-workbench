#!/usr/bin/env node
/**
 * 派单哨兵的变异测试 —— 证明它真的会失败
 *
 * 八个不变量，每个至少一个变异用例，外加真实场景（超时未回执）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runSuite } from './变异测试.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, '派单哨兵.mjs');

// ══════════════════════════════════════════════════════════════
//  基线：一个完全合规的台账
// ══════════════════════════════════════════════════════════════

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'dguard-base-'));

// 固定的"现在"：2026-11-09T12:00:00Z，让超时判定可复现
const NOW_MS = Date.parse('2026-11-09T12:00:00Z');

function ts(hoursAgo) {
  return new Date(NOW_MS - hoursAgo * 3600000).toISOString();
}

function goodDispatch(over) {
  return Object.assign({
    id: 'd-20261109-001',
    type: 'dispatch',
    from: 'hub',
    to: 'research',
    subject: '搜集同类项目架构',
    phenomenon: '需要 3 个同类项目的架构资料，目前没有',
    howto: '按 challenges/c3 的 BRIEF 格式整理',
    verify: '产物有 3 个 md 文件且每个含不变量清单',
    createdAt: ts(2),
    state: 'delivered',
    deliveredAt: ts(1.5),
    deadlineHours: 24,
    ackedAt: null,
    receipt: null,
  }, over || {});
}

function makeBaseline() {
  fs.rmSync(BASE, { recursive: true, force: true });
  const shared = path.join(BASE, 'dsh', '场景记忆', '_共享记忆');
  fs.mkdirSync(shared, { recursive: true });

  const ledger = {
    _note: '派单台账（测试基线）',
    dispatches: [goodDispatch()],
  };
  // 注意：写 JSON 时不能带 BOM（fs.writeFileSync 默认不带）
  fs.writeFileSync(path.join(shared, '派单台账.json'), JSON.stringify(ledger, null, 2), 'utf8');
}

makeBaseline();

// ══════════════════════════════════════════════════════════════
//  辅助
// ══════════════════════════════════════════════════════════════

function editLedger(d, fn) {
  const f = path.join(d, 'dsh', '场景记忆', '_共享记忆', '派单台账.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  fn(j);
  fs.writeFileSync(f, JSON.stringify(j, null, 2), 'utf8');
}

function mkCheck() {
  return {
    file: CHECK,
    env: {
      SEA_DATA_DIR: '{{DIR}}/dsh',
      // ★ 固定"当前时间"，让超时判定可复现
      SEA_NOW: String(NOW_MS),
    },
  };
}

// ══════════════════════════════════════════════════════════════
//  用例
// ══════════════════════════════════════════════════════════════

const cases = [
  {
    name: '原始基线应 PASS',
    baseline: BASE,
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS dispatch-guard: 差异集合 = 0'] },
  },

  // ── INV-1 四件套 ──
  {
    name: 'INV-1 变异: dispatch 缺"现象" → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => editLedger(d, (j) => { j.dispatches[0].phenomenon = ''; }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '缺四件套', '现象'] },
  },
  {
    name: 'INV-1 变异: dispatch 缺"怎么验" → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => editLedger(d, (j) => { j.dispatches[0].verify = ''; }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '缺四件套', '怎么验'] },
  },

  // ── INV-2 公告不该有回执 ──
  {
    name: 'INV-2 变异: 公告却带了回执 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => editLedger(d, (j) => {
      j.dispatches.push({
        id: 'd-20261109-002', type: 'announce', from: 'hub', to: 'all',
        subject: '通知', createdAt: ts(1), state: 'created',
        receipt: '我收到并回了（公告不该有回执）',
      });
    }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '公告', '不该有回执'] },
  },

  // ── INV-3 回执必须有证据 ──
  {
    name: 'INV-3 变异: acked 但 receipt 为空 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => editLedger(d, (j) => {
      Object.assign(j.dispatches[0], { state: 'acked', ackedAt: ts(0.5), receipt: '' });
    }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '没有证据'] },
  },
  {
    name: 'INV-3 变异: 回执只说"好了"（太短）→ 必须 FAIL',
    baseline: BASE,
    mutate: (d) => editLedger(d, (j) => {
      Object.assign(j.dispatches[0], { state: 'acked', ackedAt: ts(0.5), receipt: '好了' });
    }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '证据太短'] },
  },
  {
    name: 'INV-3 边界: 回执刚好 20 字符 → 必须 PASS',
    baseline: BASE,
    mutate: (d) => editLedger(d, (j) => {
      Object.assign(j.dispatches[0], {
        state: 'acked', ackedAt: ts(0.5),
        receipt: 'a'.repeat(20),   // 恰好 20
      });
    }),
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS'] },
  },

  // ── INV-4 超时未回执（最重要）──
  {
    name: 'INV-4 变异: 派单 30 小时未回执 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => editLedger(d, (j) => {
      j.dispatches[0].createdAt = ts(30);   // 超过 24h 默认线
      j.dispatches[0].state = 'delivered';
    }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '未回执', '30.0 小时'] },
  },
  {
    name: 'INV-4 边界: 派单 23 小时未回执 → 必须 PASS（没超线）',
    baseline: BASE,
    mutate: (d) => editLedger(d, (j) => {
      j.dispatches[0].createdAt = ts(23);
      j.dispatches[0].state = 'delivered';
    }),
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS'] },
  },
  {
    name: 'INV-4 变异: 刚创建还没投递就已超时 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => editLedger(d, (j) => {
      j.dispatches[0].createdAt = ts(50);
      j.dispatches[0].state = 'created';
      j.dispatches[0].deliveredAt = null;
    }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '未回执'] },
  },

  // ── INV-5 没投递却回执 ──
  {
    name: 'INV-5 变异: acked 但 deliveredAt 为空 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => editLedger(d, (j) => {
      Object.assign(j.dispatches[0], {
        state: 'acked', ackedAt: ts(0.5),
        receipt: '这是一段足够长的证据文字，证明我完成了任务',
        deliveredAt: null,
      });
    }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '从未标记投递'] },
  },

  // ── INV-6 id 格式 ──
  {
    name: 'INV-6 变异: id 格式不合法 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => editLedger(d, (j) => { j.dispatches[0].id = 'bad-id'; }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', 'id 格式不合法'] },
  },
  {
    name: 'INV-6 变异: id 重复 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => editLedger(d, (j) => {
      j.dispatches.push(Object.assign({}, j.dispatches[0]));
    }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', 'id 重复'] },
  },

  // ── INV-7 状态合法 ──
  {
    name: 'INV-7 变异: 状态值不合法 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => editLedger(d, (j) => { j.dispatches[0].state = 'weird-state'; }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '状态不合法'] },
  },

  // ── INV-8 closed 必须有 ackedAt ──
  {
    name: 'INV-8 变异: closed 但从未回执 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => editLedger(d, (j) => {
      Object.assign(j.dispatches[0], {
        state: 'closed', closedAt: ts(0.1),
        ackedAt: null, receipt: null,
      });
    }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '从未回执'] },
  },

  // ── 空台账应 PASS ──
  {
    name: '边界: 空台账（还没派过单）→ 必须 PASS',
    baseline: BASE,
    mutate: (d) => editLedger(d, (j) => { j.dispatches = []; }),
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS'] },
  },

  // ── 台账文件不存在应 PASS ──
  {
    name: '边界: 台账文件不存在 → 必须 PASS（还没开始用）',
    baseline: BASE,
    mutate: (d) => {
      fs.rmSync(path.join(d, 'dsh', '场景记忆', '_共享记忆', '派单台账.json'), { force: true });
    },
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS'] },
  },

  // ── 反例验证：故意写错期望 ──
  {
    name: '【反例验证】期望"应通过"但实际会失败 → 框架必须识别',
    baseline: BASE,
    mutate: (d) => editLedger(d, (j) => { j.dispatches[0].phenomenon = ''; }),
    check: mkCheck(),
    expect: { exitNonZero: false },   // 故意写错
  },
];

// ══════════════════════════════════════════════════════════════
//  运行
// ══════════════════════════════════════════════════════════════

console.log();

const normalCases = cases.slice(0, -1);
const negCase = cases[cases.length - 1];

const result = runSuite('派单哨兵 · 变异测试（证明检查真的会失败）', normalCases);

// 单独验反例
console.log('═'.repeat(66));
console.log('  反例验证（框架自身可信度）');
console.log('═'.repeat(66));
console.log();

const { runCase } = await import('./变异测试.mjs');
const nr = runCase(negCase);
if (nr.ok === false) {
  console.log('  OK   框架正确识别了错误的期望');
  console.log('       → 不会盲信自己的断言');
} else {
  console.log('  XX   框架没能识别错误期望（危险）');
  process.exitCode = 1;
}
console.log();

try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
