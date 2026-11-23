#!/usr/bin/env node
/**
 * 健康哨兵的变异测试
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runSuite } from './变异测试.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, '健康哨兵.mjs');

const NOW_MS = Date.parse('2026-11-09T12:00:00Z');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'hguard-base-'));

function sharedDir(root) {
  return path.join(root, 'dsh', '场景记忆', '_共享记忆');
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function makeHealth(over) {
  return Object.assign({
    _at: new Date(NOW_MS).toISOString(),
    window: { days: 7 },
    scenes: {
      demo: {
        scene: 'demo', tasks: 10, acked: 10, sent: 0, rework: 1,
        firstPass: 8, firstPassRate: 0.8, reworkRate: 0.1,
        crossBoundary: 0, verdict: 'ok', hasEnoughSamples: true,
      },
    },
    summary: { scenes: 1, withData: 1, ok: 1, warn: 0, bad: 0, noData: 0 },
  }, over || {});
}

function makeLedger(nDispatch) {
  const dispatches = [];
  for (let i = 0; i < nDispatch; i++) {
    dispatches.push({
      id: 'd-20261109-' + String(i + 1).padStart(3, '0'),
      type: 'dispatch',
      from: 'hub', to: 'demo',
      subject: '任务' + i,
      phenomenon: '测试现象描述',
      howto: '测试照做描述',
      verify: '测试验证描述',
      createdAt: new Date(NOW_MS - 3600000).toISOString(),
      state: 'acked',
      ackedAt: new Date(NOW_MS - 1800000).toISOString(),
      receipt: '这是一段足够长的证据文字用来通过校验',
    });
  }
  return { dispatches };
}

function makeBaseline() {
  fs.rmSync(path.join(BASE, 'dsh'), { recursive: true, force: true });
  const shared = sharedDir(BASE);
  writeJson(path.join(shared, '健康度.json'), makeHealth());
  writeJson(path.join(shared, '派单台账.json'), makeLedger(10));
}
makeBaseline();

function mkCheck() {
  return {
    file: CHECK,
    env: { SEA_DATA_DIR: '{{DIR}}/dsh', SEA_NOW: String(NOW_MS) },
  };
}

function editJson(d, rel, fn) {
  const p = path.join(d, 'dsh', rel);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  fn(j);
  fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
}

const WS = path.join('场景记忆', '_共享记忆');

const cases = [
  {
    name: '原始基线应 PASS（通过率 80%）',
    baseline: BASE,
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS health-guard'] },
  },

  // ── INV-1 一次通过率太低 ──
  {
    name: 'INV-1 变异: 通过率 30%（< 40%）→ 必须 FAIL',
    baseline: BASE,
    mutate: (d) => editJson(d, path.join(WS, '健康度.json'), (j) => {
      j.scenes.demo.firstPass = 3;
      j.scenes.demo.firstPassRate = 0.3;
    }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '一次通过率 30%'] },
  },
  {
    name: 'INV-1 边界: 通过率 40%（刚好够）→ 必须 PASS',
    baseline: BASE,
    mutate: (d) => editJson(d, path.join(WS, '健康度.json'), (j) => {
      j.scenes.demo.firstPass = 4;
      j.scenes.demo.firstPassRate = 0.4;
    }),
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS'] },
  },

  // ── INV-2 越界 ──
  {
    name: 'INV-2 变异: 越界 1 次 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => editJson(d, path.join(WS, '健康度.json'), (j) => {
      j.scenes.demo.crossBoundary = 1;
    }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '越界 1 次'] },
  },

  // ── 样本不足不该判 ──
  {
    name: '边界: 样本不足（tasks=2）→ 必须 PASS（不评估）',
    baseline: BASE,
    mutate: (d) => {
      editJson(d, path.join(WS, '健康度.json'), (j) => {
        j.scenes.demo.tasks = 2;
        j.scenes.demo.firstPass = 0;
        j.scenes.demo.firstPassRate = 0;
        j.scenes.demo.hasEnoughSamples = false;
      });
      // 同时把台账缩到 2 条，避免 INV-4 误报
      editJson(d, path.join(WS, '派单台账.json'), (j) => {
        j.dispatches = j.dispatches.slice(0, 2);
      });
    },
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS'] },
  },

  // ── INV-4 可追溯性 ──
  {
    name: 'INV-4 变异: 健康度声称 10 任务但台账 0 条 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => editJson(d, path.join(WS, '派单台账.json'), (j) => {
      j.dispatches = [];
    }),
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '无法追溯'] },
  },
  {
    name: 'INV-4 变异: 健康度任务数超过台账 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => {
      editJson(d, path.join(WS, '派单台账.json'), (j) => {
        j.dispatches = j.dispatches.slice(0, 5);   // 只剩 5 条
      });
    },
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '超过派单台账'] },
  },

  // ── 健康度文件不存在 ──
  {
    name: '边界: 健康度.json 不存在 → 必须 PASS（还没采集）',
    baseline: BASE,
    mutate: (d) => {
      fs.rmSync(path.join(d, 'dsh', '场景记忆', '_共享记忆', '健康度.json'), { force: true });
    },
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS'] },
  },

  // ── 反例验证 ──
  {
    name: '【反例验证】期望"应通过"但实际会失败 → 框架必须识别',
    baseline: BASE,
    mutate: (d) => editJson(d, path.join(WS, '健康度.json'), (j) => {
      j.scenes.demo.firstPassRate = 0.1;
    }),
    check: mkCheck(),
    expect: { exitNonZero: false },   // 故意写错
  },
];

console.log();
const normalCases = cases.slice(0, -1);
const negCase = cases[cases.length - 1];

runSuite('健康哨兵 · 变异测试', normalCases);

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
