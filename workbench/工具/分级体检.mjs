#!/usr/bin/env node
// 工具/分级体检.mjs —— 把 77 项检查分成「快/慢」两档，支持定时跑快档
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具
// ══════════════════════════════════════════════════════════════════════
//  实测：
//    · 机制体检 77 项全跑一次要 ~190 秒（其中 4 项依赖工作台占 1740 秒超时预算）
//    · 26 个体检/哨兵工具里，只有 3 个需要工作台
//    · 整个项目**没有任何周期性机制** —— 备份间隔 0.1h/34h/28h 完全不规律
//
//  机制审计第⑤步要求「挂到节奏上」，判据却只验「文件里有没有 --selftest 字样」。
//  真实情况是：**手动跑 = 没跑**。
//
//  这个工具把检查分档，让「高频快档」可以真的挂到定时任务上。
//
// ══════════════════════════════════════════════════════════════════════
//  分档依据
// ══════════════════════════════════════════════════════════════════════
//  依赖工作台（CDP/engine）的 → 慢档，因为要先启动工作台
//  其余 → 快档，纯文件检查，几十秒能跑完
//
//  用法：
//    node 工具/分级体检.mjs --fast      快档（不需要工作台）
//    node 工具/分级体检.mjs --full      全档（需要工作台）
//    node 工具/分级体检.mjs --list      列出分档结果
//    node 工具/分级体检.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const HEALTH = path.join(HERE, '机制体检.mjs');
const OUT_DIR = path.join(WB, '数据', '.dsh', '体检历史');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

// ── 判据常量（export 供复用）────────────────────────────────────────
/**
 * 需要工作台的检查（CDP / 引擎 / 浏览器）
 *
 * 依据：这些工具的源码里会出现 switchScene / cdpConnect / __WB / 3083 等特征。
 * 这个清单是**显式维护**的，不靠正则猜 —— 猜错了会把快档拖成慢档。
 *
 * ⚠ 2026-11-12 修（自测反例抓到分档错误）：
 *   技能可见性体检 原来被分到快档，但它连引擎 3083（查 skills/list）。
 *   引擎没启动时它会失败 → 快档就不能真的挂定时任务。
 *   自测【四】用「源码里有没有 CDP/引擎特征」扫出来这个问题。
 */
export const SLOW_CHECKS = [
  '界面功能体检',
  '面板内容体检',
  '会话绑定验证',
  '整体体检',
  '破坏性验证',     // 内含界面相关用例
  '命令可执行体检',  // 需要沿场景 cwd 解析（不连浏览器，但为一致性归慢档）
  '技能可见性体检',  // 连引擎 3083 查 skills/list
  // ⚠ 2026-11-12 加：切模型 连引擎 3083（session/list + selectModel）
  //
  //   它是 2026-11-12 新加的（把已有会话切到新 provider）。
  //   自测【四】用「源码里有没有 CDP/引擎特征」扫出来它该在慢档 ——
  //   这正是那个自测存在的意义：新工具忘了登记会被抓到。
  '切模型',
  // ⚠ 2026-11-12 加：会话轮转 / 真实模型体检 都连引擎
  //
  //   会话轮转：session/list + session/page + session/create + selectModel
  //   真实模型体检：网关 3425 + 引擎 3083 + 真的发任务
  //   两个都必须有工作台才能跑，绝不能进「声称不需要工作台」的快档。
  //
  //   这次又是分级体检的自测【四】抓到的 —— 加完新工具忘了登记，
  //   自测立刻报「快档里没有连 CDP 的工具  含 CDP 特征: 会话轮转,真实模型体检」。
  '会话轮转',
  '真实模型体检',
  // ⚠ 2026-11-13 加：会话预热 连引擎 3083（session/list + session/prompt）
  //
  //   它是 2026-11-13 新加的（给空白会话发消息让引擎生成标题，
  //   否则侧栏不渲染、面板绑不上）。
  //   分级体检的自测【四】又一次抓到了新工具忘了登记 —— 这已经是第三次
  //   （切模型、会话轮转/真实模型体检、会话预热）。
  //   说明「新工具必须登记」这条靠人记是记不住的，得靠自测兜住。
  '会话预热',
  // ⚠ 2026-11-13 加：中枢面板体检 连 CDP 9333（查 main-agent 硬编码的 AI 对话框）
  //
  //   这是第**四**次被自测【四】抓到「新工具忘了登记慢档」：
  //     第一次：切模型
  //     第二次：会话轮转 + 真实模型体检
  //     第三次：会话预热
  //     第四次：中枢面板体检（本次）
  //
  //   四次都靠同一条自测兜住 —— 说明「新工具必须登记慢档」这件事
  //   靠人记是记不住的，只能靠自测。这条自测的价值已经被反复证明。
  '中枢面板体检',
  // ⚠ 2026-11-13 加：能力对标 / 情报生成 依赖工作台的实时文件结构
  //
  //   它们不是「连 CDP」，但确实读工作台的运行时文件：
  //     · 能力对标：读 外壳/scenarios/*.json、外壳/ui/index.js 是否存在
  //     · 情报生成：读 git 历史 + 扫工具目录
  //
  //   分级体检的自测【四】用「源码里有没有 CDP/引擎特征」扫描，
  //   它把 `外壳/ui/index.js` 这种路径字符串判成了 CDP 特征。
  //   **严格说这是误报**（我们没连 CDP），但归到慢档是正确的 ——
  //   因为它们确实需要「工作台在现场」才有意义，
  //   在「声称不需要工作台」的快档里跑会给出误导性结果。
  //
  //   这是第五次靠这条自测兜住新工具归类。
  '能力对标',
  '情报生成',
];

/** 快档里额外要跑的「不依赖工作台但重要」的检查 */
export const FAST_EXTRA = [
  { file: '机制审计.mjs', args: [], desc: '77 项是否都满足五步法' },
  { file: '机制清单.mjs', args: ['--check'], desc: '清单与体检条目是否一致' },
  { file: '检查器可靠性体检.mjs', args: [], desc: '检查器自身是否可靠' },
];

// ══════════════════════════════════════════════════════════════════════
/** 从 机制体检.mjs 里抽出所有 guard */
export function loadGuards() {
  const src = fs.readFileSync(HEALTH, 'utf8');
  const out = [];
  // 匹配 { name: 'X', file: 'Y.mjs', ... args: [...]? }
  const re = /\{\s*\n\s*name:\s*'([^']+)',\s*\n\s*file:\s*'([^']+)',([\s\S]{0,600}?)\n\s*\},/g;
  for (const m of src.matchAll(re)) {
    const name = m[1];
    const file = m[2];
    const rest = m[3];
    const am = rest.match(/args:\s*\[([^\]]*)\]/);
    let args = [];
    if (am) {
      args = [...am[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    }
    out.push({ name, file, args });
  }
  return out;
}

/** 分档：返回 { fast: [...], slow: [...] } */
export function splitByTier(guards) {
  const fast = [];
  const slow = [];
  for (const g of guards) {
    if (SLOW_CHECKS.includes(g.name)) slow.push(g);
    else fast.push(g);
  }
  return { fast, slow };
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  分级体检 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】能抽出 guard 清单');
  {
    const guards = loadGuards();
    chk('抽出 guard 数 > 50', guards.length > 50, String(guards.length));
    chk('每个 guard 有 name/file', guards.every((g) => g.name && g.file.endsWith('.mjs')),
      guards.filter((g) => !g.name || !g.file.endsWith('.mjs')).length + ' 个不完整');
    chk('能抽出 args', guards.some((g) => Array.isArray(g.args)),
      '有 args 的: ' + guards.filter((g) => g.args.length > 0).length);
  }

  console.log();
  console.log('【二】分档');
  {
    const { fast, slow } = splitByTier(loadGuards());
    chk('快档非空', fast.length > 0, String(fast.length));
    chk('慢档非空', slow.length > 0, String(slow.length));
    chk('快慢不重叠', fast.every((f) => !slow.some((s) => s.name === f.name)));
    chk('合起来等于总数', fast.length + slow.length === loadGuards().length,
      fast.length + '+' + slow.length + '=' + (fast.length + slow.length));
    // 慢档必须都是显式清单里的
    chk('慢档成员都在 SLOW_CHECKS 里', slow.every((s) => SLOW_CHECKS.includes(s.name)));
  }

  console.log();
  console.log('【三】反例：分档不能把「依赖工作台的」放进快档');
  {
    const { fast } = splitByTier(loadGuards());
    // 这几个必然依赖工作台，出现在快档就是分档错误
    const MUST_BE_SLOW = ['界面功能体检', '面板内容体检'];
    const wrong = fast.filter((f) => MUST_BE_SLOW.includes(f.name));
    chk('反例：界面功能体检/面板内容体检 必须在慢档',
      wrong.length === 0, wrong.length ? '被错放进快档: ' + wrong.map((x) => x.name).join(',') : '正确');
  }

  console.log();
  console.log('【四】反例：快档必须真的不含需要工作台的工具');
  {
    const { fast } = splitByTier(loadGuards());
    // 逐个读源码，看有没有 CDP 特征
    const CDP_LIKE = /switchScene|cdpConnect|__WB\b|127\.0\.0\.1['"]?\s*,\s*port:\s*3083/;
    const offenders = [];
    for (const g of fast) {
      const p = path.join(HERE, g.file);
      if (!fs.existsSync(p)) continue;
      const c = fs.readFileSync(p, 'utf8');
      if (CDP_LIKE.test(c)) offenders.push(g.name);
    }
    chk('反例：快档里没有连 CDP 的工具', offenders.length === 0,
        offenders.length ? '含 CDP 特征: ' + offenders.join(',') : '干净');
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
function runOne(file, args, timeoutMs) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, file), ...args], {
    cwd: WB, encoding: 'utf8', timeout: timeoutMs || 300000, windowsHide: true,
  });
  const ms = Date.now() - t0;
  const out = String((r.stdout || '') + (r.stderr || ''));
  return { code: r.status === null ? -1 : r.status, ms, out };
}

function main() {
  if (has('selftest')) { selftest(); return; }

  const guards = loadGuards();
  const { fast, slow } = splitByTier(guards);

  if (has('list')) {
    console.log('='.repeat(78));
    console.log('  分级体检 · 分档结果');
    console.log('='.repeat(78));
    console.log();
    console.log('  快档（不需要工作台）: ' + fast.length + ' 项');
    for (const g of fast) console.log('    · ' + g.name);
    console.log();
    console.log('  慢档（需要工作台）: ' + slow.length + ' 项');
    for (const g of slow) console.log('    · ' + g.name);
    console.log();
    console.log('  快档额外: ' + FAST_EXTRA.length + ' 项');
    for (const e of FAST_EXTRA) console.log('    · ' + e.file + ' ' + e.args.join(' ') + '  —— ' + e.desc);
    return;
  }

  const isFast = has('fast');
  const list = isFast ? fast : fast.concat(slow);
  const label = isFast ? '快档' : '全档';

  console.log('='.repeat(78));
  console.log('  分级体检 · ' + label + '（' + list.length + ' 项）');
  console.log('='.repeat(78));
  console.log();
  if (isFast) {
    console.log('  快档 = 不依赖工作台的检查，可以挂到定时任务上');
    console.log();
  }

  const t0 = Date.now();
  const results = [];
  for (const g of list) {
    process.stdout.write('  ' + g.name.padEnd(18));
    const r = runOne(g.file, g.args);
    const ok = r.code === 0;
    results.push({ name: g.name, file: g.file, code: r.code, ms: r.ms, ok });
    console.log((ok ? '✓' : 'XX') + '  ' + String(r.ms).padStart(6) + 'ms' +
      (ok ? '' : '   exit=' + r.code));
    if (!ok) {
      const tail = r.out.split('\n').filter((l) => l.trim()).slice(-3);
      for (const t of tail) console.log('        ' + t.trim().slice(0, 100));
    }
  }

  // 快档额外项
  if (isFast) {
    console.log();
    console.log('  ── 快档额外检查 ──');
    for (const e of FAST_EXTRA) {
      process.stdout.write('  ' + path.basename(e.file).padEnd(18));
      const r = runOne(e.file, e.args, 600000);
      const ok = r.code === 0;
      results.push({ name: e.file, file: e.file, code: r.code, ms: r.ms, ok });
      console.log((ok ? '✓' : 'XX') + '  ' + String(r.ms).padStart(6) + 'ms' +
        (ok ? '' : '   exit=' + r.code));
    }
  }

  const totalMs = Date.now() - t0;
  const passed = results.filter((r) => r.ok).length;

  console.log();
  console.log('-'.repeat(78));
  console.log('  结果: ' + passed + ' / ' + results.length + ' 通过   （耗时 ' +
    Math.round(totalMs / 1000) + ' 秒）');

  // 落盘历史，供「体检节奏」验证用
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const rec = {
      at: new Date().toISOString(),
      tier: label,
      total: results.length,
      passed,
      elapsedSec: Math.round(totalMs / 1000),
      failed: results.filter((r) => !r.ok).map((r) => r.name),
    };
    const hf = path.join(OUT_DIR, 'history.jsonl');
    fs.appendFileSync(hf, JSON.stringify(rec) + '\n', 'utf8');
    console.log('  已记录到 ' + path.relative(WB, hf));
  } catch { /* fail-open */ }

  if (passed < results.length) {
    console.log();
    console.log('  未通过: ' + results.filter((r) => !r.ok).map((r) => r.name).join(', '));
    process.exitCode = 1;
  }
  console.log('='.repeat(78));
}

main();
