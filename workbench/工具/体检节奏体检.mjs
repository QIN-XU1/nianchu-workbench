#!/usr/bin/env node
// 工具/体检节奏体检.mjs —— 「挂到节奏上」是不是真的挂了
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具
// ══════════════════════════════════════════════════════════════════════
//  机制审计第⑤步叫「挂到节奏上（手动跑 = 没跑）」，
//  但它的判据只是「文件里有没有 --selftest 字样」。
//
//  实测：77 项检查全部要手动跑；Windows 计划任务里没有任何一条；
//        备份间隔 0.1h / 34.2h / 28.8h / 1.8h —— 完全不规律。
//
//  也就是说：**「挂到节奏上」这一步从来没被真的验证过。**
//
//  这个工具验证三件事：
//    ① 有没有真的注册到系统计划任务（不是「有脚本文件」）
//    ② 体检历史里有没有真实的周期记录（不是「跑过一次」）
//    ③ 最近一次记录是否在预期间隔内（不是「很久没跑」）
//
//  用法：
//    node 工具/体检节奏体检.mjs
//    node 工具/体检节奏体检.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const HIST = path.join(WB, '数据', '.dsh', '体检历史', 'history.jsonl');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

// ── 判据常量（export 供复用）────────────────────────────────────────
/** 计划任务里应该出现的任务名关键词 */
export const TASK_NAME_KEYWORD = 'DshWorkbenchHealth';
/** 最小记录条数（少于这个数说明还没形成节奏） */
export const MIN_RECORDS = 3;
/** 最大允许间隔（小时）—— 快档设计是每天一次，超过 30 小时算停摆 */
export const MAX_GAP_HOURS = 30;

/**
 * 判「体检历史」是否形成了节奏
 * @param {Array<{at:string}>} records
 * @returns {{ok, problems, gaps, count}}
 */
export function judgeCadence(records) {
  const problems = [];
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, problems: ['没有任何体检历史记录（从未跑过）'], gaps: [], count: 0 };
  }

  const times = records
    .map((r) => Date.parse(r && r.at))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  if (times.length === 0) {
    return { ok: false, problems: ['历史记录的 at 字段都无法解析'], gaps: [], count: records.length };
  }

  if (times.length < MIN_RECORDS) {
    problems.push('只有 ' + times.length + ' 条记录（<' + MIN_RECORDS + '，还没形成节奏）');
  }

  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    gaps.push((times[i] - times[i - 1]) / 3600000);
  }
  const maxGap = gaps.length ? Math.max(...gaps) : 0;
  if (maxGap > MAX_GAP_HOURS) {
    problems.push('最大间隔 ' + maxGap.toFixed(1) + ' 小时（>' + MAX_GAP_HOURS + '，中间停摆过）');
  }

  // 最近一次是否太旧
  const lastAge = (Date.now() - times[times.length - 1]) / 3600000;
  if (lastAge > MAX_GAP_HOURS) {
    problems.push('最近一次是 ' + lastAge.toFixed(1) + ' 小时前（>' + MAX_GAP_HOURS + '，已停摆）');
  }

  return { ok: problems.length === 0, problems, gaps, count: times.length, lastAge, maxGap };
}

/** 查系统计划任务里有没有注册 */
export function findScheduledTask() {
  const r = spawnSync('schtasks', ['/Query', '/FO', 'CSV', '/NH'], {
    encoding: 'utf8', timeout: 20000, windowsHide: true,
  });
  const out = String(r.stdout || '');
  if (!out) return { ok: false, found: [], raw: 'schtasks 无输出（可能无权查询）' };
  const found = out.split('\n')
    .map((l) => l.replace(/^"|"$/g, '').split('","')[0])
    .filter((n) => n && n.includes(TASK_NAME_KEYWORD));
  return { ok: found.length > 0, found, raw: '' };
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  体检节奏体检 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】正例：形成节奏的历史必须通过');
  {
    const now = Date.now();
    const recs = [0, 1, 2].map((i) => ({ at: new Date(now - i * 20 * 3600000).toISOString() }));
    const j = judgeCadence(recs);
    chk('三条间隔 20h 的记录通过', j.ok, j.problems.join('; ') || '无问题');
  }

  console.log();
  console.log('【二】反例：完全没有记录必须失败');
  {
    const j = judgeCadence([]);
    chk('反例：0 条记录必须失败', j.ok === false, j.problems.join('; '));
    const j2 = judgeCadence(null);
    chk('反例：null 必须失败', j2.ok === false, j2.problems.join('; '));
  }

  console.log();
  console.log('【三】反例：只有 1-2 条记录必须失败（没形成节奏）');
  {
    const now = Date.now();
    const one = [{ at: new Date(now).toISOString() }];
    chk('反例：1 条记录必须失败', judgeCadence(one).ok === false, judgeCadence(one).problems.join('; '));
    const two = [0, 1].map((i) => ({ at: new Date(now - i * 3600000).toISOString() }));
    chk('反例：2 条记录必须失败', judgeCadence(two).ok === false, judgeCadence(two).problems.join('; '));
  }

  console.log();
  console.log('【四】反例：中间停摆过必须失败');
  {
    const now = Date.now();
    // 两条很近 + 一条很久以前 → 中间有大间隔
    const recs = [
      { at: new Date(now - 100 * 3600000).toISOString() },   // 100h 前
      { at: new Date(now - 1 * 3600000).toISOString() },
      { at: new Date(now).toISOString() },
    ];
    const j = judgeCadence(recs);
    const hasGapProblem = j.problems.some((p) => /最大间隔/.test(p));
    chk('反例：中间停摆必须被抓', j.ok === false && hasGapProblem, j.problems.join('; '));
  }

  console.log();
  console.log('【五】反例：最近一次太旧必须失败');
  {
    const now = Date.now();
    const recs = [0, 1, 2].map((i) => ({ at: new Date(now - (100 + i) * 3600000).toISOString() }));
    const j = judgeCadence(recs);
    const hasStale = j.problems.some((p) => /已停摆|最近一次/.test(p));
    chk('反例：最近一次太旧必须被抓', j.ok === false && hasStale, j.problems.join('; '));
  }

  console.log();
  console.log('【六】反例：at 字段无法解析必须失败');
  {
    const recs = [{ at: 'not-a-date' }, { at: '' }, { at: null }];
    const j = judgeCadence(recs);
    chk('反例：全部无法解析必须失败', j.ok === false, j.problems.join('; '));
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
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { selftest(); return; }

  console.log('='.repeat(78));
  console.log('  体检节奏体检 —— 「挂到节奏上」是不是真的挂了');
  console.log('='.repeat(78));
  console.log();

  let ok = true;
  const problems = [];
  const warnings = [];

  // ① 计划任务
  console.log('  ① 系统计划任务');
  const task = findScheduledTask();
  let taskState = null;
  if (task.found.length) {
    console.log('     ✓ 已注册: ' + task.found.join(', '));
    // 额外查它的 LogonType —— Interactive 在非交互会话里会永久排队
    try {
      const st = spawnSync('schtasks', ['/Query', '/TN', task.found[0], '/FO', 'LIST', '/V'], {
        encoding: 'utf8', timeout: 20000, windowsHide: true,
      });
      const out = String(st.stdout || '');
      const lm = out.match(/Logon Mode:\s*(.+)/);
      if (lm) {
        taskState = lm[1].trim();
        console.log('       Logon Mode: ' + taskState);
        if (/Interactive/i.test(taskState)) {
          warnings.push('计划任务是 Interactive 模式：只在用户登录时运行，' +
            '非交互会话里会永久排队（实测 Status=Queued 不前进）');
          console.log('       ⚠ Interactive 模式：只在登录时运行');
        }
      }
    } catch { /* 诊断失败不影响主判据 */ }
  } else {
    console.log('     XX 没有注册计划任务（关键词 ' + TASK_NAME_KEYWORD + '）');
    if (task.raw) console.log('        ' + task.raw);
    problems.push('系统计划任务里没有 ' + TASK_NAME_KEYWORD);
    ok = false;
  }
  console.log();

  // ② 体检历史
  console.log('  ② 体检历史记录');
  let records = [];
  if (fs.existsSync(HIST)) {
    try {
      records = fs.readFileSync(HIST, 'utf8').trim().split('\n')
        .filter(Boolean).map((l) => JSON.parse(l));
    } catch { records = []; }
  }
  const cad = judgeCadence(records);
  if (cad.count) {
    console.log('     记录数: ' + cad.count);
    if (cad.gaps && cad.gaps.length) {
      console.log('     间隔(小时): ' + cad.gaps.map((g) => g.toFixed(1)).join(', '));
    }
    if (cad.lastAge !== undefined) {
      console.log('     最近一次: ' + cad.lastAge.toFixed(1) + ' 小时前');
    }
  }
  if (cad.ok) {
    console.log('     ✓ 已成节奏');
  } else {
    for (const p of cad.problems) console.log('     XX ' + p);
    problems.push(...cad.problems);
    ok = false;
  }
  console.log();

  // ③ 定时入口脚本
  console.log('  ③ 定时入口脚本');
  const CMD = path.join(WB, 'health-fast.cmd');
  const PS1 = path.join(WB, 'health-fast.ps1');
  if (fs.existsSync(CMD)) {
    console.log('     ✓ ' + path.relative(WB, CMD));
    // 真实性检查：.cmd 必须纯 ASCII（中文路径在计划任务里会失败）
    const bytes = fs.readFileSync(CMD);
    const nonAscii = bytes.filter((b) => b > 127).length;
    if (nonAscii > 0) {
      problems.push('health-fast.cmd 含 ' + nonAscii + ' 个非 ASCII 字节' +
        '（实测会导致 cmd.exe 按系统代码页解析失败）');
      console.log('     XX 含 ' + nonAscii + ' 个非 ASCII 字节 — 计划任务会解析失败');
      ok = false;
    } else {
      console.log('     ✓ 纯 ASCII（计划任务可安全调用）');
    }
  } else {
    console.log('     XX 缺 health-fast.cmd');
    problems.push('缺定时入口脚本');
    ok = false;
  }
  if (fs.existsSync(PS1)) console.log('     ✓ ' + path.relative(WB, PS1));
  console.log();

  // ④ 手动兜底：项目内「该跑了」提醒
  //
  //   计划任务在 Interactive 模式下不可靠，所以还要有一条「人来做」的兜底：
  //   跑任何工具前看历史，超过间隔就提示该跑体检。
  console.log('  ④ 兜底：距上次快档体检');
  if (cad.lastAge !== undefined) {
    const h = cad.lastAge;
    if (h > MAX_GAP_HOURS) {
      console.log('     XX ' + h.toFixed(1) + ' 小时没跑（>' + MAX_GAP_HOURS + '）');
      console.log('        现在补跑：node 工具/分级体检.mjs --fast');
    } else {
      console.log('     ✓ ' + h.toFixed(1) + ' 小时内跑过');
    }
  } else {
    console.log('     XX 从未跑过');
  }
  console.log();

  console.log('-'.repeat(78));
  if (warnings.length) {
    console.log('  ⚠ 已知限制（不判失败，但要知道）：');
    for (const w of warnings) console.log('     · ' + w);
    console.log();
  }
  if (ok) {
    console.log('  ✓ 「挂到节奏上」是真的挂了');
  } else {
    console.log('  XX 「挂到节奏上」还没真挂：');
    for (const p of problems) console.log('     · ' + p);
    console.log();
    console.log('  注册计划任务（每天 09:00 跑快档）：');
    console.log('    schtasks /Create /TN "' + TASK_NAME_KEYWORD + '" /TR "' +
      path.join(WB, 'health-fast.cmd') + '" /SC DAILY /ST 09:00 /F');
    process.exitCode = 1;
  }
  console.log('='.repeat(78));
}

main();
