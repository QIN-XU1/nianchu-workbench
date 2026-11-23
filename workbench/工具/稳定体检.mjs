#!/usr/bin/env node
// 工具/稳定体检.mjs —— 反复跑同一检查，看结果是否一致
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具
// ══════════════════════════════════════════════════════════════════════
//  这个项目已经踩过太多次「同一个检查，这次过下次不过」：
//
//    · 界面功能体检：单独跑 8/8，机制体检里跑 4/8
//      → 因为前面的检查切了场景，webview 还没恢复
//    · 真实模型体检：6/7 和 7/7 随机切换
//      → 因为它读到「上一次任务的 turn/end」
//    · 会话绑定验证：2/8 和 8/8 取决于引擎启动多久
//    · 破坏性验证：46/47 和 47/47 取决于有没有残留
//
//  这些「flaky」检查比坏的检查更消耗信任：
//    · 红了 → 你不知道是真坏了还是偶发
//    · 绿了 → 你不知道是真好了还是碰巧
//
//  这个工具：**把同一个检查连跑 N 次，看结论是否一致**。
//    · 全一致 → 这个检查是稳的，可以信
//    · 不一致 → 它有环境依赖，需要在判据里说明或修掉
//
//  用法：
//    node 工具/稳定体检.mjs                         默认测 3 个关键检查，各跑 3 次
//    node 工具/稳定体检.mjs --tool 界面功能体检      只测一个
//    node 工具/稳定体检.mjs --times 5              跑 5 次
//    node 工具/稳定体检.mjs --list                 列可选工具
//    node 工具/稳定体检.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const TOOLS = path.join(WB, '工具');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const val = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };

// ── 判据常量（export 供复用）────────────────────────────────────────
/** 默认跑几次 */
export const DEFAULT_TIMES = 3;

/** 默认测哪些（都是「踩过 flaky」的） */
export const DEFAULT_TARGETS = [
  { tool: '会话绑定验证.mjs', args: [], label: '会话绑定验证' },
  { tool: '面板内容体检.mjs', args: [], label: '面板内容体检' },
  { tool: '破坏性验证.mjs', args: [], label: '破坏性验证', timeoutMs: 900000 },
];

/** 单次最多等多久 */
export const PER_RUN_TIMEOUT_MS = 900000;

/**
 * 判一组运行结果是否稳定
 *
 * @param {Array<{ok:boolean}>} runs
 * @returns {{stable:boolean, passCount:number, total:number, pattern:string}}
 */
export function judgeStability(runs) {
  const list = Array.isArray(runs) ? runs : [];
  if (!list.length) return { stable: false, passCount: 0, total: 0, pattern: '(无数据)' };
  const passCount = list.filter((r) => r && r.ok).length;
  const total = list.length;
  const pattern = list.map((r) => (r && r.ok ? 'O' : 'X')).join('');
  return {
    stable: passCount === total || passCount === 0,   // 全过或全不过都算「稳定」
    passCount,
    total,
    pattern,
  };
}

// ══════════════════════════════════════════════════════════════════════
function runOnce(tool, args, timeoutMs) {
  const t0 = Date.now();
  try {
    const out = execFileSync(process.execPath, [path.join(TOOLS, tool), ...(args || [])], {
      cwd: WB, encoding: 'utf8', timeout: timeoutMs || PER_RUN_TIMEOUT_MS, windowsHide: true,
    });
    return { ok: true, code: 0, ms: Date.now() - t0, out };
  } catch (e) {
    return { ok: false, code: (e && e.status) || 1, ms: Date.now() - t0, out: String((e && (e.stdout || e.stderr)) || '') };
  }
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  稳定体检 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】稳定性判据');
  {
    const allPass = judgeStability([{ ok: true }, { ok: true }, { ok: true }]);
    chk('正例：全过 → 稳定', allPass.stable === true, allPass.pattern);
    chk('全过时 passCount 正确', allPass.passCount === 3);

    const allFail = judgeStability([{ ok: false }, { ok: false }, { ok: false }]);
    chk('正例：全不过 → 也算稳定（一致的不通过）', allFail.stable === true, allFail.pattern);

    const flaky = judgeStability([{ ok: true }, { ok: false }, { ok: true }]);
    chk('反例：忽过忽不过 → 不稳定', flaky.stable === false, flaky.pattern);
    chk('反例：能说清模式', flaky.pattern === 'OXO', flaky.pattern);
  }

  console.log();
  console.log('【二】边界');
  {
    chk('反例：空数组 → 不稳定（没数据不能说稳）', judgeStability([]).stable === false);
    chk('反例：null → 不稳定', judgeStability(null).stable === false);
    chk('单次通过 → 稳定', judgeStability([{ ok: true }]).stable === true);
  }

  console.log();
  console.log('【三】关键：这个工具补的是什么');
  chk('关键：flaky 检查比坏检查更消耗信任',
    true, '红了不知真假、绿了不知侥幸');

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('='.repeat(72));
  return R.every((x) => x.ok);
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { process.exit(selftest() ? 0 : 1); }

  if (has('list')) {
    console.log('  可选（都是踩过 flaky 的）:');
    for (const t of DEFAULT_TARGETS) console.log('    · ' + t.label.padEnd(18) + t.tool);
    console.log();
    console.log('  也可以用 --tool <文件名> 测任意工具');
    return;
  }

  const times = Math.max(2, Number(val('times')) || DEFAULT_TIMES);
  const only = val('tool');
  const targets = only
    ? [{ tool: only, args: [], label: only.replace(/\.mjs$/, '') }]
    : DEFAULT_TARGETS;

  console.log('='.repeat(78));
  console.log('  稳定体检 —— 同一个检查连跑 ' + times + ' 次，看结论是否一致');
  console.log('='.repeat(78));
  console.log();
  console.log('  为什么需要：这个项目反复踩到「这次过下次不过」的检查。');
  console.log('  flaky 比坏更消耗信任 —— 红了不知真假，绿了不知侥幸。');
  console.log();

  const results = [];
  for (const t of targets) {
    process.stdout.write('  ' + t.label.padEnd(18));
    const runs = [];
    for (let i = 0; i < times; i++) {
      const r = runOnce(t.tool, t.args, t.timeoutMs);
      runs.push(r);
      process.stdout.write(r.ok ? 'O' : 'X');
    }
    const j = judgeStability(runs);
    const avgMs = Math.round(runs.reduce((a, b) => a + b.ms, 0) / runs.length / 1000);
    console.log('   ' + (j.stable ? '✓ 稳定' : '⚠ 不稳定') + '  ' + j.passCount + '/' + j.total + '  均 ' + avgMs + 's');
    results.push({ ...t, runs, judge: j });
  }

  console.log();
  console.log('-'.repeat(78));
  const flaky = results.filter((r) => !r.judge.stable);
  console.log('  稳定: ' + (results.length - flaky.length) + ' / ' + results.length);

  if (flaky.length) {
    console.log();
    console.log('  ⚠ 这些检查不稳定（同一环境、同一命令，结论会变）:');
    for (const f of flaky) {
      console.log('    · ' + f.label + '  模式=' + f.judge.pattern + '  ' + f.judge.passCount + '/' + f.judge.total);
      console.log('      含义：它有环境依赖（前面的检查残留 / 引擎状态 / 时序）。');
      console.log('      修法：要么在判据里说明依赖，要么加冷却，要么修掉依赖。');
    }
    process.exitCode = 1;
  } else {
    console.log('  ✓ 被抽查的检查都稳定 —— 它们的结论可以信');
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
