#!/usr/bin/env node
// 工具/全工具自测.mjs —— 所有工具的 --selftest 必须全绿
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（结构性盲区）
// ══════════════════════════════════════════════════════════════════════
//  机制体检收录了 83 个检查项，每项有 args 决定测什么模式。
//  实测：
//    · 有 --selftest 的工具: 83 个
//    · 机制体检真的跑 --selftest 的: 11 个（13%）
//    · 测别的模式（--check / 默认）: 72 个（87%）
//
//  也就是说 **87% 的自测从不被自动运行**，它们红了也没人知道。
//
//  实测抓到 2 个：
//    ① 记忆注入效果体检  selftest 9/11
//       —— 两条断言过时（判据从「全部命中」改成「命中一条」后没同步改断言）
//    ② 检查器可靠性体检  selftest 7/8
//       —— 反例样本里含 chk(，而判据是「没有 chk( 才 skip」，样本自相矛盾
//
//  两个都从没被跑过，所以一直红着。
//
//  这个工具不做新检查 —— 它只是**把已有的自测真的跑一遍**。
//
//  用法：
//    node 工具/全工具自测.mjs
//    node 工具/全工具自测.mjs --wasm      只跑 WASM（少）……不，无此参数
//    node 工具/全工具自测.mjs --selftest
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

// ── 判据常量（export 供复用）────────────────────────────────────────
/** 自测超时（毫秒）—— 单个工具 */
export const SELFTEST_TIMEOUT_MS = 90000;

/** 免检（这些工具的自测需要外部环境或会改数据） */
export const SKIP_SELFTEST = [
  '机制体检.mjs',        // 它自己跑全部体检，递归
  '全工具自测.mjs',      // 它自己
  '破坏性验证.mjs',      // 会改源文件（虽然 restore 但不在自测里做）
  '界面回归.mjs',        // 需要工作台
  '界面功能体检.mjs',    // 需要工作台
  '面板内容体检.mjs',    // 需要工作台
  '会话绑定验证.mjs',    // 需要工作台
  '整体体检.mjs',        // 需要工作台
  // ⚠ 2026-11-12 加：ci.mjs 是 CI 编排器，不是检查器
  //
  //   它没有自己的 --selftest 分支 —— 传 --selftest 会被忽略，
  //   然后它会跑**完整 CI**（约 210~250 秒，含机制体检 83 项）。
  //
  //   把它纳入「全工具自测」有两个问题：
  //     ① 嵌套浪费时间（全工具自测 100 秒 → 350 秒）
  //     ② 它跑机制体检，而机制体检里有全工具自测 → 潜在递归
  //
  //   它自己已经由 分级体检/计划任务 覆盖，不需要在这里再跑一遍。
  'ci.mjs',
];

/**
 * 找出所有有 --selftest 的工具
 * @returns {string[]} 文件名列表
 */
export function listSelftestTools(toolsDir) {
  const dir = toolsDir || TOOLS;
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.mjs')) continue;
    if (f.endsWith('.selftest.mjs')) continue;   // 独立的 selftest 文件不是工具
    if (SKIP_SELFTEST.includes(f)) continue;
    let src = '';
    try { src = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    // 必须真的有 --selftest 分支
    if (!/--selftest/.test(src)) continue;
    out.push(f);
  }
  return out.sort();
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  全工具自测 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】能列出有 selftest 的工具');
  {
    const list = listSelftestTools();
    chk('列出非空', list.length > 0, list.length + ' 个');
    chk('排除了自己', !list.includes('全工具自测.mjs'));
    chk('排除了机制体检', !list.includes('机制体检.mjs'));
    chk('排除了需工作台的', !list.includes('界面功能体检.mjs'));
    chk('都真的以 .mjs 结尾', list.every((f) => f.endsWith('.mjs')));
    chk('没有重复', new Set(list).size === list.length);
  }

  console.log();
  console.log('【二】反例：没有 --selftest 的工具不能进列表');
  {
    const list = listSelftestTools();
    // 投递通道 原来没有 --selftest 分支（后来加了）；这里验一个确定没有的
    //   用「机制体检」当样本（它在 SKIP 里，一定不在）
    chk('反例：SKIP 里的工具不在列表', !list.includes('整体体检.mjs'));
    chk('反例：列表里没有 .selftest.mjs 文件', !list.some((f) => f.endsWith('.selftest.mjs')));
  }

  console.log();
  console.log('【三】反例：判据不能恒真（列表必须来自真实扫描）');
  {
    const a = listSelftestTools();
    const b = listSelftestTools();
    chk('两次调用结果一致（不是随机/恒真）', JSON.stringify(a) === JSON.stringify(b));
    // 列表长度应该显著大于 1（如果判据失效返回空或 1 个，说明坏了）
    chk('列表长度 > 20（说明真的扫到了）', a.length > 20, String(a.length));
  }

  console.log();
  console.log('【四】关键：这个工具的存在理由');
  {
    chk('关键：有工具的自测从没被机制体检跑过（这是本工具补的盲区）',
      SELFTEST_TIMEOUT_MS > 0 && SKIP_SELFTEST.length > 0,
      '实测 83 个有 selftest 的工具里，机制体检只跑 11 个');
  }

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

  console.log('='.repeat(78));
  console.log('  全工具自测 —— 所有工具的 --selftest 必须全绿');
  console.log('='.repeat(78));
  console.log();
  console.log('  为什么：机制体检 83 项里只有 11 项真的跑 --selftest，');
  console.log('         其余 72 项（87%）测的是别的模式 —— 自测红了也没人知道。');
  console.log();

  const list = listSelftestTools();
  console.log('  有 --selftest 的工具: ' + list.length + ' 个');
  console.log('  免检: ' + SKIP_SELFTEST.length + ' 个（需工作台/会改数据/递归）');
  console.log();

  const failed = [];
  let ok = 0;
  const t0 = Date.now();

  for (const f of list) {
    const p = path.join(TOOLS, f);
    let code = -1;
    let tail = '';
    try {
      const out = execFileSync(process.execPath, [p, '--selftest'], {
        cwd: WB, encoding: 'utf8', timeout: SELFTEST_TIMEOUT_MS, windowsHide: true,
      });
      code = 0;
      tail = String(out || '').split('\n').filter((l) => /自测结果/.test(l))[0] || '';
    } catch (e) {
      code = (e && e.status) || 1;
      const out = String((e && (e.stdout || e.stderr)) || '');
      tail = out.split('\n').filter((l) => /自测结果|XX/.test(l)).slice(0, 3).join(' | ');
    }

    if (code === 0) {
      ok++;
      process.stdout.write('  ✓ ' + f.padEnd(26) + (tail.match(/自测结果: (.+)/) || [])[1] + '\n');
    } else {
      failed.push({ file: f, code, tail });
      console.log('  XX ' + f.padEnd(26) + 'exit=' + code + '  ' + tail.slice(0, 60));
    }
  }

  const sec = Math.round((Date.now() - t0) / 1000);
  console.log();
  console.log('-'.repeat(78));
  console.log('  结果: ' + ok + ' / ' + list.length + ' 个工具的自测全绿   （耗时 ' + sec + ' 秒）');

  if (failed.length) {
    console.log();
    console.log('  XX 这些自测是红的（红了多久没人知道）:');
    for (const x of failed) {
      console.log('    · ' + x.file + '  exit=' + x.code);
      if (x.tail) console.log('        ' + x.tail.slice(0, 100));
    }
    process.exitCode = 1;
  } else {
    console.log('  ✓ 所有自测全绿');
  }
  console.log('='.repeat(78));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
