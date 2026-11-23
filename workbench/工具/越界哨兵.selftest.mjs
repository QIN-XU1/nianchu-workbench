#!/usr/bin/env node
/**
 * 越界哨兵的变异测试
 *
 * 四个不变量：
 *   INV-1 未定义归属的路径必须报
 *   INV-3 A 档（宪法）被修改必须报
 *   E 档越界（当前场景写了别人的地盘）必须报
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runSuite } from './变异测试.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, '越界哨兵.mjs');

// 固定时间：2026-11-09T12:00:00Z
const NOW_MS = Date.parse('2026-11-09T12:00:00Z');
const HOUR = 3600000;

// ══════════════════════════════════════════════════════════════
//  造基线：一个迷你的完整 workbench 结构
//
//  注意：越界哨兵用 path.relative(ROOT, wbRoot) 计算相对路径，
//       而 ROOT = path.resolve(WB, '../..') —— 依赖真实目录位置。
//       为了让测试可控，这里造一个"假 ROOT + 假 wb"。
// ══════════════════════════════════════════════════════════════

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'bguard-base-'));

// 假 root 结构：BASE/root/workbench
const FAKE_ROOT = path.join(BASE, 'root');
const FAKE_WB = path.join(FAKE_ROOT, 'workbench');

function writeFileAt(rel, content, mtimeMs) {
  const full = path.join(FAKE_ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  if (mtimeMs) fs.utimesSync(full, mtimeMs / 1000, mtimeMs / 1000);
}

function makeBaseline() {
  fs.rmSync(FAKE_ROOT, { recursive: true, force: true });

  // AGENTS.md（A 档）
  writeFileAt('workbench/数据/.dsh/AGENTS.md', '# 全局须知\n', NOW_MS - 100 * HOUR);

  // 共享台账
  writeFileAt('workbench/数据/.dsh/场景记忆/_共享记忆/索引.json',
    JSON.stringify({ areas: [
      { id: 'demo', name: '演示' },
      { id: 'other', name: '其它' },
    ] }), NOW_MS - 100 * HOUR);

  // 场地地图（必须显式提供，否则会调 collectMap 读真实项目）
  const rules = [
    { tier: 'A', pattern: 'workbench/数据/.dsh/AGENTS.md', owner: '宿主', desc: '宪法' },
    { tier: 'B', pattern: 'workbench/数据/.dsh/场景记忆/_共享记忆/**', owner: '各场景', desc: '共享台账' },
    { tier: 'C', pattern: 'workbench/工具/**', owner: '管理员场景', desc: '工具' },
    { tier: 'D', scene: 'demo', pattern: 'workbench/外壳/scenarios/demo.json', owner: 'demo', desc: '演示配置' },
    { tier: 'D', scene: 'demo', pattern: 'workbench/数据/.dsh/场景记忆/演示/**', owner: 'demo', desc: '演示记忆' },
    { tier: 'D', scene: 'other', pattern: 'workbench/外壳/scenarios/other.json', owner: 'other', desc: '其它配置' },
    { tier: 'D', scene: 'other', pattern: 'workbench/数据/.dsh/场景记忆/其它/**', owner: 'other', desc: '其它记忆' },
  ];
  writeFileAt('workbench/数据/.dsh/场景记忆/_共享记忆/场地地图.json',
    JSON.stringify({ rules }), NOW_MS - 100 * HOUR);

  // 场景配置（D 档，24h 前修改 = 不在窗口内）
  writeFileAt('workbench/外壳/scenarios/demo.json', '{"id":"demo"}', NOW_MS - 100 * HOUR);
  writeFileAt('workbench/外壳/scenarios/other.json', '{"id":"other"}', NOW_MS - 100 * HOUR);

  // 场景记忆
  writeFileAt('workbench/数据/.dsh/场景记忆/演示/场景私有记忆.md', '# 演示\n', NOW_MS - 100 * HOUR);
  writeFileAt('workbench/数据/.dsh/场景记忆/其它/场景私有记忆.md', '# 其它\n', NOW_MS - 100 * HOUR);

  // 工具目录（C 档）
  writeFileAt('workbench/工具/dummy.mjs', '// dummy\n', NOW_MS - 100 * HOUR);
}

makeBaseline();

// ══════════════════════════════════════════════════════════════
//  用例
// ══════════════════════════════════════════════════════════════

function mkCheck() {
  return {
    file: CHECK,
    env: {
      SEA_WB_ROOT: '{{DIR}}/root/workbench',
      SEA_NOW: String(NOW_MS),
    },
    args: ['--since', '24h'],
  };
}

const cases = [
  {
    name: '原始基线应 PASS（24h 内无改动）',
    baseline: BASE,
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS boundary-guard: 差异集合 = 0'] },
  },

  // ── INV-1 未定义归属 ──
  {
    name: 'INV-1 变异: 场景目录下出现未定义归属的新文件 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => {
      // 注意：d 是临时目录的 root 副本
      const p = path.join(d, 'root', 'workbench', '外壳', 'scenarios', 'orphan.json');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '{}', 'utf8');
    },
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '未在场地地图里定义归属'] },
  },

  // ── INV-3 A 档被修改 ──
  {
    name: 'INV-3 变异: AGENTS.md 在窗口内被修改 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => {
      const p = path.join(d, 'root', 'workbench', '数据', '.dsh', 'AGENTS.md');
      fs.writeFileSync(p, '# 全局须知\n改了\n', 'utf8');
      // 强制 mtime = NOW - 1h（在窗口内）
      const t = (NOW_MS - 1 * HOUR) / 1000;
      fs.utimesSync(p, t, t);
    },
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', 'A 档（宪法）在窗口内被修改'] },
  },

  // ── E 档越界 ──
  {
    name: 'E 档变异: 当前场景=demo，但 other 的地盘被改 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => {
      // 写"当前场景"标记
      const cur = path.join(d, 'root', 'workbench', '数据', '.dsh', '当前场景');
      fs.mkdirSync(path.dirname(cur), { recursive: true });
      fs.writeFileSync(cur, 'demo', 'utf8');

      // 改 other 的场景配置（在窗口内）
      const p = path.join(d, 'root', 'workbench', '外壳', 'scenarios', 'other.json');
      fs.writeFileSync(p, '{"id":"other","changed":true}', 'utf8');
      const t = (NOW_MS - 1 * HOUR) / 1000;
      fs.utimesSync(p, t, t);
    },
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', 'E 档越界', 'other'] },
  },

  // ── 边界：窗口外的修改不该报 ──
  {
    name: '边界: A 档在 48 小时前被改 → 必须 PASS（窗口外）',
    baseline: BASE,
    mutate: (d) => {
      const p = path.join(d, 'root', 'workbench', '数据', '.dsh', 'AGENTS.md');
      fs.writeFileSync(p, '# 改了\n', 'utf8');
      const t = (NOW_MS - 48 * HOUR) / 1000;
      fs.utimesSync(p, t, t);
    },
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS'] },
  },

  // ── 边界：自己的地盘被改，不该报 ──
  {
    name: '边界: 当前场景 demo 改自己的地盘 → 必须 PASS',
    baseline: BASE,
    mutate: (d) => {
      const cur = path.join(d, 'root', 'workbench', '数据', '.dsh', '当前场景');
      fs.mkdirSync(path.dirname(cur), { recursive: true });
      fs.writeFileSync(cur, 'demo', 'utf8');

      const p = path.join(d, 'root', 'workbench', '外壳', 'scenarios', 'demo.json');
      fs.writeFileSync(p, '{"id":"demo","changed":true}', 'utf8');
      const t = (NOW_MS - 1 * HOUR) / 1000;
      fs.utimesSync(p, t, t);
    },
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS'] },
  },

  // ── 反例验证 ──
  {
    name: '【反例验证】期望"应通过"但实际会失败 → 框架必须识别',
    baseline: BASE,
    mutate: (d) => {
      const p = path.join(d, 'root', 'workbench', '外壳', 'scenarios', 'orphan2.json');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '{}', 'utf8');
    },
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

runSuite('越界哨兵 · 变异测试', normalCases);

console.log('═'.repeat(66));
console.log('  反例验证');
console.log('═'.repeat(66));
console.log();

const { runCase } = await import('./变异测试.mjs');
const nr = runCase(negCase);
if (nr.ok === false) {
  console.log('  OK   框架正确识别了错误的期望');
} else {
  console.log('  XX   框架没能识别错误期望（危险）');
  process.exitCode = 1;
}
console.log();

try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
