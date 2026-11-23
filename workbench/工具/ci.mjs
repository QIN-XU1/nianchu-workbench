#!/usr/bin/env node
/**
 * CI 哨兵 —— 一次跑完所有检查，供计划任务/CI 使用
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么需要它（原项目判据）
 * ══════════════════════════════════════════════════════════════
 *
 *  "手动跑的检查等于没跑。"
 *
 *  机制体检现在 83 项、约 200 秒，可以每天自动跑（见 分级体检 --fast 更快）。
 *  失败项自动进 _待办.md，不需要人守着。
 *
 * ⚠ 2026-11-12 修两个过时说明：
 *   ① 原来写「742ms 跑完 9 项」—— 实测已 83 项 / 约 200 秒
 *   ② 原来写「① 机制体检（9 个哨兵）」—— 同上
 *   同时把单步默认超时从 180s 提到 600s，否则機制體檢永远被外层砍断。
 *
 * ══════════════════════════════════════════════════════════════
 *  跑什么
 * ══════════════════════════════════════════════════════════════
 *
 *  ① 机制体检（83 项）
 *  ② 全量变异测试（11 个套件）
 *  ③ 单元测试（neuron-math）
 *  ④ 基线快照
 *
 *  用法：
 *    node 工具/ci.mjs               # 跑全部
 *    node 工具/ci.mjs --quick       # 只跑机制体检
 *    node 工具/ci.mjs --json        # JSON 输出
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const ROOT = path.resolve(WB, '..');

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const jsonOut = args.includes('--json');

const results = [];
const t0 = Date.now();

function run(label, file, extraArgs, opts) {
  const o = opts || {};
  const full = path.isAbsolute(file) ? file : path.join(HERE, file);
  if (!fs.existsSync(full)) {
    results.push({ label, ok: false, note: '文件不存在: ' + file, ms: 0 });
    return;
  }
  const t = Date.now();
  const r = spawnSync(process.execPath, [full, ...(extraArgs || [])], {
    encoding: 'utf8',
    // ⚠ 2026-11-12 修（超时没跟上体检项增长 → CI 一直红）
    //
    //   原来默认 180 秒。但 机制体检 从 9 项长到 83 项，
    //   实测耗时 190~215 秒（含需要工作台的几项）——
    //   于是 ci.mjs 的「机制体检」这一项**永远超时失败**。
    //
    //   而 ci.mjs 自己的 --selftest 就是跑完整 CI，
    //   所以它也跟着红。这个红一直存在但没人知道：
    //     机制体检 83/83 通过，但 CI 报失败。
    //
    //   修法：默认提到 600 秒（10 分钟）。机制体检内部对慢的子项
    //        有自己的 timeoutMs（破坏性验证 600s / 界面 480s 等），
    //        外层超时必须比内层最长的那个更宽，否则永远被外层砍断。
    timeout: o.timeout || 600000,
    env: process.env,
    cwd: o.cwd || WB,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const ms = Date.now() - t;

  // 判断通过
  let ok = r.status === 0;
  // 变异测试的 exit code 1 可能只是"反例验证"部分，需要看输出
  if (!ok && o.passIfIncludes) {
    for (const s of o.passIfIncludes) {
      if (out.includes(s)) { ok = true; break; }
    }
  }

  // 提取结果行：多套测试时取「合计: X / Y」
  let m = out.match(/合计:\s*(\d+)\s*\/\s*(\d+)/);
  if (!m) m = out.match(/(?:自测结果|结果):\s*(\d+)\s*\/\s*(\d+)/);
  const summary = m ? (m[1] + '/' + m[2]) : (ok ? 'PASS' : 'FAIL');

  results.push({ label, ok, note: summary, ms, out: out.slice(0, 4000) });
}

// ═══ 1. 机制体检 ═══
run('机制体检（83 项）', '机制体检.mjs');

if (!quick) {
  // ═══ 2. 全量变异测试 ═══
  const SUITES = [
    ['变异测试框架', '变异测试.mjs', ['--selftest']],
    ['记忆哨兵', '记忆哨兵.selftest.mjs', []],
    ['身份哨兵', '身份哨兵.selftest.mjs', []],
    ['派单哨兵', '派单哨兵.selftest.mjs', []],
    ['越界哨兵', '越界哨兵.selftest.mjs', []],
    ['健康哨兵', '健康哨兵.selftest.mjs', []],
    ['进化哨兵', '进化哨兵.selftest.mjs', []],
    ['备份', '备份.selftest.mjs', []],
    ['场景判定', '场景判定.selftest.mjs', []],
    ['归因', '归因.selftest.mjs', []],
    ['内容哨兵', '内容哨兵.selftest.mjs', []],
  ];

  for (const [label, file, a] of SUITES) {
    run(label, file, a, {
      // 变异测试的"反例验证"部分可能让 exit=0，但正常是 0
      passIfIncludes: null,
    });
  }

  // ═══ 3. 单元测试 ═══
  run('neuron 数学单元测试',
      path.join(ROOT, 'workbench', '外壳', 'ui', 'neuron-math.selftest.mjs'),
      [], { cwd: path.join(ROOT, 'workbench', '外壳', 'ui') });

  // ═══ 4. memory-neuron 插件三套测试 ═══
  const PLUGIN_TEST = path.join(ROOT, 'prototype', 'run-all-tests.mjs');
  const PLUGIN_DIR = path.join(ROOT, 'plugins', 'memory-neuron');
  if (fs.existsSync(PLUGIN_TEST) && fs.existsSync(PLUGIN_DIR)) {
    run('memory-neuron 插件（101 项）', PLUGIN_TEST, [PLUGIN_DIR], {
      cwd: ROOT,
      timeout: 120000,
    });
  }
}

const totalMs = Date.now() - t0;
const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;

// ═══ 输出 ═══
if (jsonOut) {
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    passed, failed, total: results.length, ms: totalMs,
    checks: results.map(r => ({ label: r.label, ok: r.ok, note: r.note, ms: r.ms })),
  }, null, 2));
} else {
  console.log('╔' + '═'.repeat(72) + '╗');
  console.log('║  CI  ' + new Date().toISOString().slice(0, 19).replace('T', ' ') +
    (quick ? '  【快速模式】' : '') + ' '.repeat(quick ? 40 : 30) + '║');
  console.log('╚' + '═'.repeat(72) + '╝');
  console.log();

  for (const r of results) {
    const mark = r.ok ? '✓' : '✗';
    console.log('  ' + mark + '  ' + r.label.padEnd(26) +
      String(r.note).padEnd(10) + String(r.ms) + 'ms');
  }

  console.log();
  console.log('─'.repeat(74));
  console.log('  结果: ' + passed + ' / ' + results.length + ' 通过   （' + totalMs + 'ms）');
  console.log('─'.repeat(74));
  console.log();
}

// ═══ 失败项写待办 ═══
if (failed > 0) {
  const todoFile = path.join(WB, '数据', '.dsh', '场景记忆', '_共享记忆', '_待办.md');
  try {
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const lines = ['', '- [' + stamp + '] CI 失败：' + failed + ' 项'];
    for (const r of results.filter(x => !x.ok)) {
      lines.push('  - ' + r.label + '：' + r.note);
    }
    fs.appendFileSync(todoFile, lines.join('\n') + '\n', 'utf8');
    if (!jsonOut) {
      console.log('  已把失败项写入 _待办.md');
      console.log();
    }
  } catch (e) { /* 忽略 */ }
}

process.exit(failed > 0 ? 1 : 0);
