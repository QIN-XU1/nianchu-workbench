#!/usr/bin/env node
/**
 * 硬规矩 —— 三条从真实事故换来的铁律
 *
 * ══════════════════════════════════════════════════════════════
 *  设计依据（视频 BV15mnJ6YELj 原文）
 * ══════════════════════════════════════════════════════════════
 *
 *  > [04:20] 「光省钱还不够，我还订了几条硬规矩：
 *  >   ① 系统负载超过 90% 就不许再派活
 *  >   ② 几个 AI 来回回执必须一次一条、不超过 200 字，不许没完没了
 *  >   ③ 一旦见到余额报错，立刻停手
 *  >   这是真烧过钱换来的。」
 *  >
 *  > [04:44] 「之前有一晚几条 AI 互相写技术小论文，
 *  >   一个会话跑到 260 几轮，把账户余额烧到直接爆错停摆。」
 *  >
 *  > [04:52] 「规矩不是写给体面看的，是写给会犯错的机器看的。」
 *
 * ══════════════════════════════════════════════════════════════
 *  三条规矩的具体实现
 * ══════════════════════════════════════════════════════════════
 *
 *  规矩 1：负载闸
 *    系统负载 > 90% → 不许派活
 *    检查项：CPU / 内存 / 会话并发数
 *
 *  规矩 2：回执节流
 *    一次一条、不超过 200 字
 *    检查项：回执条数、字数
 *
 *  规矩 3：余额急停
 *    见到余额/配额错误 → 立刻停手
 *    检查项：错误信息关键词
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/硬规矩.mjs --load              查系统负载能否派活
 *  node 工具/硬规矩.mjs --receipt --count 3 --chars 500   查回执是否合规
 *  node 工具/硬规矩.mjs --quota --text "..." 查是否余额错误
 *  node 工具/硬规矩.mjs --all --count 1 --chars 150       三条全查
 *  node 工具/硬规矩.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// ══════════════════════════════════════════════════════════════
//  硬性常量（写死，来自他的事故）
// ══════════════════════════════════════════════════════════════
export const HARD_RULES = {
  /** 规矩 1：负载上限（百分比） */
  LOAD_MAX_PCT: 90,
  /** 规矩 2：一次最多几条回执 */
  RECEIPT_MAX_COUNT: 1,
  /** 规矩 2：回执最多多少字 */
  RECEIPT_MAX_CHARS: 200,
  /** 规矩 3：余额错误关键词 */
  QUOTA_KEYWORDS: [
    'Insufficient Balance',
    'insufficient_quota',
    'QUOTA',
    '余额不足',
    '余额用完',
    'quota exceeded',
    'out of credits',
    'billing',
    'exceeded your current quota',
  ],
  /** 规矩 3：连续多少次余额错误就停 */
  QUOTA_STOP_AFTER: 1,
};

// ══════════════════════════════════════════════════════════════
//  规矩 1：负载闸
//
//  ⚠ 2026-11-12：把「判据」从「读数」里拆出来，做成纯函数 judgeLoad。
//
//    为什么要拆：
//      原来判定塞在 checkLoad 里，而 checkLoad 必须读真实内存/CPU，
//      于是「判据对不对」只能用真实机器状态去验 ——
//      这就是第二版把环境状态当自测判据的根源（机器 93% 时永远红）。
//
//    拆开以后：
//      judgeLoad(89.9, 90) → 只跟阈值有关，跟机器忙不忙无关，
//      可以喂任意假数据验证边界；真实读数只用来喂进这个函数。
// ══════════════════════════════════════════════════════════════
export function judgeLoad(loadPct, maxPct) {
  const max = (maxPct !== undefined && maxPct !== null)
    ? Number(maxPct)
    : HARD_RULES.LOAD_MAX_PCT;
  // 非数字（NaN / null / undefined）一律判「不通过」——
  // 「量不了」不能当「可以派活」。
  if (typeof loadPct !== 'number' || !Number.isFinite(loadPct)) {
    return { pass: false, over: true, loadPct: null, maxPct: max,
      reason: '负载读不到（非数字）→ 按不许派活处理' };
  }
  // ⚠ 2026-11-12 修（判据错误：边界差一个等号）
  //
  //   原判据：`over = loadPct > max` —— 正好 90.0% 时 over=false，**放行**。
  //
  //   错在哪（两处矛盾，之前都没被发现）：
  //     ① 本文件第三版自测明确写 `judge(90) === false`（90 算超限），
  //        但自测用的是自己复制的局部 `pct < MAX_PCT`，
  //        跟生产代码 `> max` 根本不是同一条逻辑 ——
  //        所以「90 放行」这个 bug 被自测的复制品盖住了。
  //     ② 同项目的 负载闸.mjs 判据是 `peak >= warn`（含等号），
  //        自测断言「正好 90% → 停止派单（含等号）」。
  //        同一项目对同一条规矩两套边界，就是口径不对齐。
  //
  //   改成：`>=`。理由：负载闸是这条规矩的权威实现（3 次采样版），
  //        它的语义是「到 90% 就停」，硬规矩这边必须跟它一致。
  const over = loadPct >= max;
  return {
    pass: !over,
    over,
    loadPct: +loadPct.toFixed(1),
    maxPct: max,
    reason: over
      ? '负载 ' + loadPct.toFixed(1) + '% 达到上限 ' + max + '% → 不许派活'
      : '负载 ' + loadPct.toFixed(1) + '% 正常（上限 ' + max + '%）',
  };
}

export function checkLoad(opts) {
  const o = opts || {};

  // CPU 负载：用 os.loadavg() 在 Windows 上返回 [0,0,0]，
  // 所以用 CPU 使用率（基于 os.cpus() 两次采样差分）
  const cpus = os.cpus();
  const cpuCount = cpus.length;

  // 内存
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memUsedPct = ((totalMem - freeMem) / totalMem) * 100;

  // CPU 使用率（用 loadavg 如果有，否则用 1 - idle 比例）
  let cpuPct = 0;
  const loadavg = os.loadavg();
  if (loadavg[0] > 0) {
    cpuPct = (loadavg[0] / cpuCount) * 100;
  } else {
    // Windows：用总 idle 比例估算
    let totalIdle = 0;
    let totalTick = 0;
    for (const c of cpus) {
      for (const t of Object.values(c.times)) totalTick += t;
      totalIdle += c.times.idle;
    }
    cpuPct = totalTick > 0 ? (1 - totalIdle / totalTick) * 100 : 0;
  }

  // 综合负载：取两者的高者（保守）
  const loadPct = Math.max(cpuPct, memUsedPct);

  // ⚠ 自测抓到的缺陷：原来写 `o.maxPct || HARD_RULES.LOAD_MAX_PCT`，
  //   maxPct=0 是假值会被忽略 → 用默认值 90 → 反例测不出来。
  //   改用显式 undefined 判断。
  //
  // ⚠ 2026-11-12：判定逻辑已抽到 judgeLoad（纯函数），这里只负责读数。
  const j = judgeLoad(loadPct, o.maxPct);

  return {
    pass: j.pass,
    loadPct: +loadPct.toFixed(1),
    cpuPct: +cpuPct.toFixed(1),
    memPct: +memUsedPct.toFixed(1),
    maxPct: j.maxPct,
    cpuCount,
    totalMemMB: Math.round(totalMem / 1048576),
    reason: j.reason,
  };
}

// ══════════════════════════════════════════════════════════════
//  规矩 2：回执节流
// ══════════════════════════════════════════════════════════════
export function checkReceipt(count, chars, opts) {
  const o = opts || {};
  const maxCount = (o.maxCount !== undefined && o.maxCount !== null) ? Number(o.maxCount) : HARD_RULES.RECEIPT_MAX_COUNT;
  const maxChars = (o.maxChars !== undefined && o.maxChars !== null) ? Number(o.maxChars) : HARD_RULES.RECEIPT_MAX_CHARS;

  const problems = [];
  const c = Number(count) || 0;
  const ch = Number(chars) || 0;

  if (c > maxCount) {
    problems.push('一次回执 ' + c + ' 条，超过上限 ' + maxCount + ' 条（必须一次一条）');
  }
  if (ch > maxChars) {
    problems.push('回执 ' + ch + ' 字，超过上限 ' + maxChars + ' 字');
  }

  return {
    pass: problems.length === 0,
    problems,
    count: c,
    chars: ch,
    maxCount,
    maxChars,
    reason: problems.length
      ? problems.join('；')
      : '回执合规（' + c + ' 条 / ' + ch + ' 字）',
  };
}

// ══════════════════════════════════════════════════════════════
//  规矩 3：余额急停
// ══════════════════════════════════════════════════════════════
export function checkQuota(text, opts) {
  const o = opts || {};
  const t = String(text || '');
  const kws = o.keywords || HARD_RULES.QUOTA_KEYWORDS;

  const hits = kws.filter((k) => t.includes(k));

  return {
    pass: hits.length === 0,
    hits,
    reason: hits.length > 0
      ? '检测到余额/配额错误「' + hits[0] + '」→ 必须立刻停手'
      : '无余额错误',
  };
}

// ══════════════════════════════════════════════════════════════
//  三条全查
// ══════════════════════════════════════════════════════════════
export function checkAll(input) {
  const i = input || {};
  const results = [];

  const r1 = checkLoad(i.load || {});
  results.push({ id: 1, name: '负载闸', ...r1 });

  const r2 = checkReceipt(i.receiptCount, i.receiptChars, i.receipt || {});
  results.push({ id: 2, name: '回执节流', ...r2 });

  const r3 = checkQuota(i.quotaText || '', i.quota || {});
  results.push({ id: 3, name: '余额急停', ...r3 });

  const pass = results.every((r) => r.pass);

  return {
    pass,
    results,
    stop: results.filter((r) => !r.pass).map((r) => r.name),
    verdict: pass ? '可以继续' : '必须停手：' + results.filter((r) => !r.pass).map((r) => r.name).join('、'),
  };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  硬规矩 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 常量来自他的事故
  chk('负载上限 90%', HARD_RULES.LOAD_MAX_PCT === 90, String(HARD_RULES.LOAD_MAX_PCT));
  chk('回执上限 1 条', HARD_RULES.RECEIPT_MAX_COUNT === 1, String(HARD_RULES.RECEIPT_MAX_COUNT));
  chk('回执上限 200 字', HARD_RULES.RECEIPT_MAX_CHARS === 200, String(HARD_RULES.RECEIPT_MAX_CHARS));
  chk('有余额关键词', HARD_RULES.QUOTA_KEYWORDS.length > 0, HARD_RULES.QUOTA_KEYWORDS.length + ' 个');

  // ② 负载闸
  const loadReal = checkLoad();
  chk('负载闸能跑', typeof loadReal.pass === 'boolean', '当前 ' + loadReal.loadPct + '%');

  // 反例：模拟超载
  const loadOver = checkLoad({ maxPct: 0 });   // 上限设 0，必然超
  chk('反例：超载被拒', loadOver.pass === false, loadOver.reason);

  // ③ 回执节流
  const rOk = checkReceipt(1, 150);
  chk('回执合规通过', rOk.pass === true, rOk.reason);

  const rTooMany = checkReceipt(3, 150);
  chk('反例：回执多条被拒', rTooMany.pass === false, rTooMany.problems[0] || '');

  const rTooLong = checkReceipt(1, 500);
  chk('反例：回执超字数被拒', rTooLong.pass === false, rTooLong.problems[0] || '');

  // ④ 余额急停
  const qOk = checkQuota('任务执行成功，返回 200');
  chk('无余额错误通过', qOk.pass === true, '');

  const qBad = checkQuota('Error: Insufficient Balance (request_id: xxx)');
  chk('反例：余额错误被拦', qBad.pass === false, qBad.hits[0] || '');

  const qBad2 = checkQuota('请求失败：余额不足，请充值');
  chk('中文余额错误也能拦', qBad2.pass === false, qBad2.hits[0] || '');

  // ⑤ 三条全查
  const allOk = checkAll({ receiptCount: 1, receiptChars: 100, quotaText: 'ok', load: { maxPct: 100 } });
  chk('三条全过', allOk.pass === true, allOk.verdict);

  const allBad = checkAll({
    receiptCount: 5,
    receiptChars: 900,
    quotaText: 'Insufficient Balance',
    load: { maxPct: 0 },
  });
  chk('三条全挂时能列出', allBad.results.filter((r) => !r.pass).length === 3,
      allBad.results.filter((r) => !r.pass).map((r) => r.name).join(','));
  chk('停手结论明确', allBad.verdict.startsWith('必须停手'), allBad.verdict);

  // ⑥ 关键：这个闸必须能拦住他那次事故
  const incident = checkAll({
    receiptCount: 260,        // 他的实际值：260 轮
    receiptChars: 5000,
    quotaText: 'Insufficient Balance',   // 最后爆余额
    load: { maxPct: 0 },
  });
  chk('关键：能拦住「260轮烧光余额」事故',
      incident.results.filter((r) => !r.pass).length >= 2,
      incident.results.filter((r) => !r.pass).map((r) => r.name).join(','));

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  // ⚠ 2026-11-12 二次修（第一次修过头了）：
  //
  //   第一次修：把 chk('当前系统负载', true) 改成真的判断 pct < 90
  //     —— 那确实修掉了「恒真装饰」。
  //
  //   但这样又有新问题：**把「环境状态」当成自测判据**。
  //   实测：机器内存 93.7% 时这一条永远红，
  //        于是机制体检永远不全绿，而代码完全没问题。
  //
  //   自测应该验证「判据逻辑对不对」，而不是「当前机器忙不忙」。
  //
  //   正确做法：用注入的假数据验证判据边界，再看真实负载仅作报告。
  {
    const MAX_PCT = 90;

    // ① 判据逻辑（用假数据，不受环境干扰）
    //
    //  ⚠ 2026-11-12 加固：原来这里自己写了一个局部 `judge = pct => pct < 90`，
    //    等于「用假函数测假逻辑」—— judgeLoad 真被改坏了，这条也照样绿。
    //    现在改成调用**生产用的** judgeLoad，喂假数据：
    //      · 判据和线上是同一条代码，不是复制品
    //      · 输入是假数据，所以不受机器忙不忙影响（保持第三版的做法）
    chk('判据：89.9% 算通过', judgeLoad(89.9, MAX_PCT).pass === true, '89.9%');
    chk('判据：90% 算超限', judgeLoad(90, MAX_PCT).pass === false, '90%');
    chk('判据：94% 算超限', judgeLoad(94, MAX_PCT).pass === false, '94%');
    chk('判据：非数字算失败',
        judgeLoad(NaN, MAX_PCT).pass === false && judgeLoad(null, MAX_PCT).pass === false,
        'NaN/null');
    chk('判据：0% 算通过', judgeLoad(0, MAX_PCT).pass === true, '0%');

    // ② 真实负载仅作报告，不参与判定
    const loadInfo = checkLoad();
    const pct = loadInfo.loadPct;
    console.log('  ──  当前系统负载（仅供参考，不作判据）: ' + pct + '% / 上限 ' + MAX_PCT + '%' +
      (pct >= MAX_PCT ? '  ← 机器忙，不代表代码有问题' : ''));
  }
  return R.filter(Boolean).length === R.length;
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-12 加 --check（机制体检用这个，**不许用 --load**）
  //
  //    为什么不能用 --load 当体检项：
  //      `--load` 读的是**真实机器状态**。机器内存 93% 时它必然 exit 1，
  //      于是「硬规矩」这个体检项永远红，而三条规矩的代码完全没问题。
  //      这正是本文件历史第二版的错误：把环境状态当判据。
  //      （第一版是 `chk('当前系统负载', true)` 恒真装饰；都不能退回去。）
  //
  //    --check 做什么：用**假数据**验证三条规矩的判据边界，
  //      全部通过就 exit 0，判据被改坏就 exit 1。
  //      真实负载/真实余额**只报告，不参与判定**。
  // ══════════════════════════════════════════════════════════════
  if (has('--check')) {
    const fails = [];
    const t = (name, ok, got) => { if (!ok) fails.push(name + '（实际 ' + got + '）'); };

    // 规矩 1：负载判据边界（假数据）
    t('负载 89.9% 应通过', judgeLoad(89.9).pass === true, judgeLoad(89.9).pass);
    t('负载 90% 应拒绝（含等号）', judgeLoad(90).pass === false, judgeLoad(90).pass);
    t('负载 94% 应拒绝', judgeLoad(94).pass === false, judgeLoad(94).pass);
    t('负载 NaN 应拒绝', judgeLoad(NaN).pass === false, judgeLoad(NaN).pass);
    t('负载 null 应拒绝', judgeLoad(null).pass === false, judgeLoad(null).pass);
    t('负载上限常量应为 90', HARD_RULES.LOAD_MAX_PCT === 90, HARD_RULES.LOAD_MAX_PCT);

    // 规矩 2：回执节流边界（假数据）
    t('1 条 200 字应通过', checkReceipt(1, 200).pass === true, checkReceipt(1, 200).pass);
    t('2 条应拒绝', checkReceipt(2, 100).pass === false, checkReceipt(2, 100).pass);
    t('201 字应拒绝', checkReceipt(1, 201).pass === false, checkReceipt(1, 201).pass);
    t('回执上限常量应为 1/200',
        HARD_RULES.RECEIPT_MAX_COUNT === 1 && HARD_RULES.RECEIPT_MAX_CHARS === 200,
        HARD_RULES.RECEIPT_MAX_COUNT + '/' + HARD_RULES.RECEIPT_MAX_CHARS);

    // 规矩 3：余额关键词（假数据）
    t('「无余额错误」应通过', checkQuota('任务成功，返回 200').pass === true,
        checkQuota('任务成功，返回 200').pass);
    t('英文余额错误应拦', checkQuota('Error: Insufficient Balance').pass === false,
        checkQuota('Error: Insufficient Balance').pass);
    t('中文余额错误应拦', checkQuota('请求失败：余额不足').pass === false,
        checkQuota('请求失败：余额不足').pass);

    // 真实负载仅报告（不参与判定）
    const real = checkLoad();
    const realPct = real.loadPct;

    console.log('═'.repeat(72));
    console.log('  硬规矩 · 检查（判据用假数据，真实负载仅报告）');
    console.log('═'.repeat(72));
    console.log();
    console.log('  真实负载（仅供参考，不作判据）: ' + realPct + '% / 上限 ' +
      HARD_RULES.LOAD_MAX_PCT + '%' +
      (realPct >= HARD_RULES.LOAD_MAX_PCT ? '  ← 机器忙，不代表代码有问题' : ''));
    console.log();

    if (fails.length === 0) {
      console.log('  ✓ 三条硬规矩的判据都正确（14 个边界全部符合预期）');
      process.exit(0);
    }
    console.log('  ✗ 判据被改坏了：');
    for (const f of fails) console.log('    · ' + f);
    process.exit(1);
  }

  if (has('--load')) {
    const r = checkLoad();
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.pass ? 0 : 1);
  }

  if (has('--receipt')) {
    const r = checkReceipt(val('--count'), val('--chars'));
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.pass ? 0 : 1);
  }

  if (has('--quota')) {
    const r = checkQuota(val('--text'));
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.pass ? 0 : 1);
  }

  // 默认 / --all
  const r = checkAll({
    receiptCount: has('--count') ? val('--count') : 1,
    receiptChars: has('--chars') ? val('--chars') : 100,
    quotaText: val('--text') || '',
  });

  console.log('═'.repeat(72));
  console.log('  三条硬规矩');
  console.log('═'.repeat(72));
  console.log();
  for (const x of r.results) {
    console.log('  ' + (x.pass ? '✓' : '✗') + ' 规矩' + x.id + ' ' + x.name + '  ' + x.reason);
  }
  console.log();
  console.log('─'.repeat(72));
  console.log('  结论: ' + r.verdict);
  console.log('─'.repeat(72));
  console.log();
  console.log('  这些规矩来自一次真实事故（视频 BV15mnJ6YELj）：');
  console.log('  「之前有一晚几条 AI 互相写技术小论文，一个会话跑到 260 几轮，');
  console.log('    把账户余额烧到直接爆错停摆。」');
  console.log('  「规矩不是写给体面看的，是写给会犯错的机器看的。」');

  process.exit(r.pass ? 0 : 1);
}
