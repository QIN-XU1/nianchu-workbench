#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * 场景判定 —— "该不该开一个新场景"
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么需要这个判据
 * ══════════════════════════════════════════════════════════════
 *
 *  没有判据 → 每个小事都开一个场景 → 场景泛滥
 *  → 每个场景都没内容 → 系统变成空壳
 *
 *  原项目判据（直接采用，因为它来自真实教训）：
 *
 *    开：
 *      ✅ 这类活会反复回来（不是一次性）
 *      ✅ 有自己的资产目录
 *      ✅ 有自己的专业流程
 *      ✅ 有明确的边界（知道不碰什么）
 *
 *    不开：
 *      ❌ 一次性的活 → 记当次笔记
 *      ❌ 只是大项目里的一个功能 → 属于现有场景的子项
 *      ❌ 说不出"不碰什么" → 边界没想清
 *
 *    一句话判据：
 *      "半年后我还会为它单独打开一个窗口吗？"
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/场景判定.mjs --repeat yes --assets yes --process yes --boundary "..."
 *  node 工具/场景判定.mjs --interactive      # 交互式问答
 *
 *  退出码：0 = 该开；1 = 不该开（附理由）
 */

import readline from 'node:readline';

// ══════════════════════════════════════════════════════════════
//  判定逻辑（纯函数，可被测试）
// ══════════════════════════════════════════════════════════════

/**
 * @param {object} a
 *   a.repeat    'yes'|'no'   这类活会反复回来吗
 *   a.assets    'yes'|'no'   有自己的资产目录吗
 *   a.process   'yes'|'no'   有自己的专业流程吗
 *   a.boundary  string|bool  能说清"不碰什么"吗
 *   a.halfYear  'yes'|'no'   半年后还会为它单独开窗口吗（可选）
 * @returns {{should: boolean, reasons: string[], verdict: string}}
 */
export function judge(a) {
  const reasons = [];

  const yes = (v) => String(v).toLowerCase() === 'yes' || v === true;

  const repeat = yes(a.repeat);
  const assets = yes(a.assets);
  const process = yes(a.process);
  const boundary = (typeof a.boundary === 'string')
    ? a.boundary.trim().length >= 5
    : a.boundary === true;
  const halfYear = a.halfYear === undefined ? null : yes(a.halfYear);

  // ── 硬否决：一次性 ──
  if (!repeat) {
    reasons.push('❌ 一次性的活 —— 记进当次项目笔记就好，不值得开场景');
    return { should: false, reasons, verdict: '一次性' };
  }

  // ── 硬否决：边界说不清 ──
  if (!boundary) {
    reasons.push('❌ 说不清"不碰什么" —— 边界没想清，先别开');
    return { should: false, reasons, verdict: '边界不清' };
  }

  // ── 硬否决：准入判据 ──
  if (halfYear === false) {
    reasons.push('❌ "半年后我还会为它单独打开一个窗口吗？" —— 答不上来就别开');
    return { should: false, reasons, verdict: '不值得单独开窗' };
  }

  // ── 加分项：缺少但可以开（提示） ──
  if (!assets) {
    reasons.push('⚠ 没有独立的资产目录 —— 建议先明确"改完写回哪里"');
  }
  if (!process) {
    reasons.push('⚠ 没有专业流程 —— 可能需要先补技能，否则会用通用办法硬干');
  }

  // ── 全过 ──
  const hardPass = repeat && assets && process && boundary;
  if (hardPass) {
    reasons.push('✓ 会反复回来 / 有资产目录 / 有专业流程 / 边界清晰');
    reasons.push('✓ 建议开场景');
  } else {
    reasons.push('△ 核心判据通过（会反复 + 边界清晰），但缺少资产目录或专业流程');
    reasons.push('△ 可以先开一个轻量场景，等积累出资产和流程再补齐');
  }

  return { should: true, reasons, verdict: hardPass ? '该开' : '可以开（轻量）' };
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════

function argv(name) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}
function has(name) { return process.argv.includes('--' + name); }

async function interactive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  console.log('═'.repeat(66));
  console.log('  场景判定 · 该不该开一个新场景');
  console.log('═'.repeat(66));
  console.log();
  console.log('  四个问题，答不上来就别开。');
  console.log();

  const a = {};
  a.repeat = (await ask('  ① 这类活会反复回来吗？（不是一次性）  [y/N] ')).trim();
  a.assets = (await ask('  ② 它有自己的资产目录吗？（改完写回同一份）  [y/N] ')).trim();
  a.process = (await ask('  ③ 它有自己的专业流程吗？（不是通用问答能解决）  [y/N] ')).trim();
  a.boundary = (await ask('  ④ 它"不碰什么"？（一句话说清边界）  ')).trim();
  a.halfYear = (await ask('  ⑤ 半年后我还会为它单独打开一个窗口吗？  [y/N] ')).trim();

  rl.close();

  const norm = (v) => (v.toLowerCase().startsWith('y') ? 'yes' : 'no');

  const result = judge({
    repeat: norm(a.repeat),
    assets: norm(a.assets),
    process: norm(a.process),
    boundary: a.boundary,
    halfYear: norm(a.halfYear),
  });

  console.log();
  console.log('═'.repeat(66));
  console.log('  判定: ' + (result.should ? '✅ ' : '⛔ ') + result.verdict);
  console.log('═'.repeat(66));
  console.log();
  for (const r of result.reasons) console.log('  ' + r);
  console.log();

  process.exit(result.should ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (has('interactive')) {
    await interactive();
  } else {
    const a = {
      repeat: argv('repeat'),
      assets: argv('assets'),
      process: argv('process'),
      boundary: argv('boundary'),
      halfYear: argv('half-year'),
    };

    if (!a.repeat && !has('interactive')) {
      console.log('场景判定');
      console.log();
      console.log('  用法 1（交互式）:');
      console.log('    node 工具/场景判定.mjs --interactive');
      console.log();
      console.log('  用法 2（命令行）:');
      console.log('    node 工具/场景判定.mjs \\');
      console.log('      --repeat yes --assets yes --process yes \\');
      console.log('      --boundary "只碰 A 目录，不碰 B 和 C" \\');
      console.log('      [--half-year yes]');
      console.log();
      console.log('  退出码: 0 = 该开；1 = 不该开');
      process.exit(2);
    }

    const r = judge(a);
    console.log('═'.repeat(66));
    console.log('  判定: ' + (r.should ? '✅ ' : '⛔ ') + r.verdict);
    console.log('═'.repeat(66));
    console.log();
    for (const reason of r.reasons) console.log('  ' + reason);
    console.log();
    process.exit(r.should ? 0 : 1);
  }
}
