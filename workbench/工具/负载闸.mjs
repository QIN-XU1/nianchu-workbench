#!/usr/bin/env node
/**
 * 负载闸 —— 按 luanyujia 的工程严谨度重做
 *
 * ══════════════════════════════════════════════════════════════
 *  依据（参考项目 10-源码/机制小工具/负载闸.mjs，22.6 KB）
 * ══════════════════════════════════════════════════════════════
 *
 *  他的判据（写死，别处不许再定义一套）：
 *    CPU  = **采样 3 次、间隔 1.5 s、取均值**
 *           「单次采样太抖 —— 这条是用户定的，别改成单次」
 *    内存 = (总量 − 可用) / 总量，用 os.totalmem()/os.freemem() 即时同步读
 *
 *  三档 + 一档「量不了」：
 *    都 < 90%          ⇒ ✓ 可派单    → exit 0
 *    任一 ≥ 90% (<95%) ⇒ ⚠ 停止派单  → exit 10
 *    任一 ≥ 95%        ⇒ ⛔ 停重活    → exit 20
 *    闸门本身没跑成     ⇒ ⛔ 无法判定  → exit 3
 *
 *  「⚠ 10/20 是『越线』，3 是『量不了』——
 *    两者都不是 0，调用方一律当『别派』处理最安全。」
 *
 * ══════════════════════════════════════════════════════════════
 *  我们原来的实现（硬规矩.mjs 里的 checkLoad）
 * ══════════════════════════════════════════════════════════════
 *
 *    单次瞬时采样 → 抖动大，可能正好采到低谷
 *    只有 pass/fail 两档 → 「量不了」和「越线」混在一起
 *
 *  本工具是独立版，供关键决策前调用（派单/批处理前）。
 *  硬规矩.mjs 里的简化版保留（用于快速自检）。
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/负载闸.mjs              默认：一行结论
 *  node 工具/负载闸.mjs --json       完整 JSON
 *  node 工具/负载闸.mjs --quiet      只打结论
 *  node 工具/负载闸.mjs --fast       单次采样（约 0s，给自测用）
 *  node 工具/负载闸.mjs --selftest
 *
 *  退出码：0=可派 · 10=停止派单 · 20=停重活 · 3=量不了
 */

import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);

// ══════════════════════════════════════════════════════════════
//  判据常量（写死在这里，别处不许再定义一套）
// ══════════════════════════════════════════════════════════════
export const GATE = {
  /** 采样次数 */
  SAMPLE_N: 3,
  /** 采样间隔（毫秒） */
  SAMPLE_INTERVAL_MS: 1500,
  /** ≥ 这个值 ⇒ 停止派单 */
  WARN_PCT: 90,
  /** ≥ 这个值 ⇒ 停重活 */
  STOP_PCT: 95,
  /** 退出码 */
  EXIT: { OK: 0, WARN: 10, STOP: 20, UNKNOWN: 3 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════
//  CPU 采样：os.cpus() 累计 tick 差分
//
//  为什么不用 WMI：实测单次 Get-CimInstance Win32_Processor 要 1.05~1.33 s，
//  3 次 = 3.2s 查询 + 3.0s 睡眠 ≈ 7.8s，太慢。
//  os.cpus() 一次采样 ≈0 ms，能在精确的 0/1.5/3.0s 三个时刻真采样。
// ══════════════════════════════════════════════════════════════
function cpuTicks() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  return { idle, total };
}

/** 单次采样：与上一次 tick 的差分 */
function sampleOnce(prev) {
  const cur = cpuTicks();
  const dTotal = cur.total - prev.total;
  const dIdle = cur.idle - prev.idle;
  if (dTotal <= 0) return null;
  return ((dTotal - dIdle) / dTotal) * 100;
}

/**
 * 多轮采样取均值
 *
 * ⚠ 关键：每次采样之间要 sleep，且用「相邻两次 tick 差分」，
 *   这样每次采样测的是「这 1.5 秒内」的占用率，不是开机以来平均值。
 */
export async function sampleCpu(opts) {
  const o = opts || {};
  const n = o.n || GATE.SAMPLE_N;
  const interval = o.interval !== undefined ? o.interval : GATE.SAMPLE_INTERVAL_MS;
  const samples = [];

  let prev = cpuTicks();
  for (let i = 0; i < n; i++) {
    await sleep(interval);
    const cur = cpuTicks();
    const dTotal = cur.total - prev.total;
    const dIdle = cur.idle - prev.idle;
    prev = cur;
    if (dTotal <= 0) continue;
    samples.push(((dTotal - dIdle) / dTotal) * 100);
  }

  if (samples.length === 0) return { ok: false, samples: [] };
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    ok: true,
    avg: Math.round(avg * 10) / 10,
    samples: samples.map((x) => Math.round(x * 10) / 10),
    count: samples.length,
  };
}

/** 内存：即时同步读，不依赖子进程 */
export function readRam() {
  const total = os.totalmem();
  const free = os.freemem();
  const usedPct = ((total - free) / total) * 100;
  return {
    totalMB: Math.round(total / 1048576),
    freeMB: Math.round(free / 1048576),
    usedPct: Math.round(usedPct * 10) / 10,
  };
}

// ══════════════════════════════════════════════════════════════
//  判定
// ══════════════════════════════════════════════════════════════
export function judge(cpuPct, ramPct, opts) {
  const o = opts || {};
  const warn = o.warnPct !== undefined ? o.warnPct : GATE.WARN_PCT;
  const stop = o.stopPct !== undefined ? o.stopPct : GATE.STOP_PCT;

  const peak = Math.max(cpuPct, ramPct);

  if (peak >= stop) {
    return {
      verdict: 'stop',
      label: '⛔ 停重活',
      exit: GATE.EXIT.STOP,
      reason: '负载 ' + peak.toFixed(1) + '% ≥ ' + stop + '%，连体检/构建/全盘扫描都别跑',
      canDispatch: false,
      canHeavy: false,
    };
  }
  if (peak >= warn) {
    return {
      verdict: 'warn',
      label: '⚠ 停止派单',
      exit: GATE.EXIT.WARN,
      reason: '负载 ' + peak.toFixed(1) + '% ≥ ' + warn + '%，不许派子代理、不许唤醒别的 AI',
      canDispatch: false,
      canHeavy: true,
    };
  }
  return {
    verdict: 'ok',
    label: '✓ 可派单',
    exit: GATE.EXIT.OK,
    reason: '负载 ' + peak.toFixed(1) + '% < ' + warn + '%',
    canDispatch: true,
    canHeavy: true,
  };
}

// ══════════════════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════════════════
export async function runGate(opts) {
  const o = opts || {};
  const fast = o.fast === true;
  const started = Date.now();

  // CPU
  let cpuResult;
  if (fast) {
    // 快速模式：单次（给自测/快速检查用）
    const a = cpuTicks();
    await sleep(300);
    const b = cpuTicks();
    const dTotal = b.total - a.total;
    const dIdle = b.idle - a.idle;
    if (dTotal <= 0) {
      return {
        ok: false,
        verdict: 'unknown',
        label: '⛔ 无法判定',
        exit: GATE.EXIT.UNKNOWN,
        reason: 'CPU tick 差分失败（dTotal=' + dTotal + '）',
        canDispatch: false,
      };
    }
    const pct = ((dTotal - dIdle) / dTotal) * 100;
    cpuResult = { ok: true, avg: Math.round(pct * 10) / 10, samples: [Math.round(pct * 10) / 10], count: 1 };
  } else {
    cpuResult = await sampleCpu({ n: o.n, interval: o.interval });
  }

  if (!cpuResult.ok) {
    return {
      ok: false,
      verdict: 'unknown',
      label: '⛔ 无法判定',
      exit: GATE.EXIT.UNKNOWN,
      reason: 'CPU 采样全失败（os.cpus() 拿不到 tick 差分）',
      canDispatch: false,
    };
  }

  const ram = readRam();
  const j = judge(cpuResult.avg, ram.usedPct, { warnPct: o.warnPct, stopPct: o.stopPct });

  return {
    ok: true,
    time: new Date().toISOString(),
    cpu: cpuResult.avg,
    samples: cpuResult.samples,
    sampleCount: cpuResult.count,
    ram: ram.usedPct,
    ramDetail: ram,
    peak: Math.max(cpuResult.avg, ram.usedPct),
    ...j,
    ms: Date.now() - started,
  };
}

// ══════════════════════════════════════════════════════════════
//  自测（含负例：必须能触发 warn / stop / unknown）
// ══════════════════════════════════════════════════════════════
async function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  负载闸 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 判据常量
  chk('采样 3 次', GATE.SAMPLE_N === 3, String(GATE.SAMPLE_N));
  chk('间隔 1.5 秒', GATE.SAMPLE_INTERVAL_MS === 1500, String(GATE.SAMPLE_INTERVAL_MS));
  chk('warn 阈值 90', GATE.WARN_PCT === 90, String(GATE.WARN_PCT));
  chk('stop 阈值 95', GATE.STOP_PCT === 95, String(GATE.STOP_PCT));
  chk('退出码 0/10/20/3', GATE.EXIT.OK === 0 && GATE.EXIT.WARN === 10 &&
      GATE.EXIT.STOP === 20 && GATE.EXIT.UNKNOWN === 3,
      JSON.stringify(GATE.EXIT));

  // ② 判定：正常
  const j1 = judge(30, 50);
  chk('30%/50% → 可派单', j1.verdict === 'ok' && j1.exit === 0, j1.label);

  // ③ 判定：warn
  const j2 = judge(92, 50);
  chk('92%/50% → 停止派单', j2.verdict === 'warn' && j2.exit === 10, j2.label);
  chk('warn 时不许派单', j2.canDispatch === false, '');

  // ④ 判定：stop
  const j3 = judge(50, 96);
  chk('50%/96% → 停重活', j3.verdict === 'stop' && j3.exit === 20, j3.label);
  chk('stop 时连重活也不许', j3.canHeavy === false, '');

  // ⑤ 边界：正好 90 → warn
  const j4 = judge(90, 50);
  chk('正好 90% → 停止派单（含等号）', j4.verdict === 'warn', j4.label);

  // ⑥ 边界：89.9 → ok
  const j5 = judge(89.9, 50);
  chk('89.9% → 可派单', j5.verdict === 'ok', j5.label);

  // ⑦ 边界：正好 95 → stop
  const j6 = judge(95, 50);
  chk('正好 95% → 停重活（含等号）', j6.verdict === 'stop', j6.label);

  // ⑧ 取两者最大值
  const j7 = judge(30, 92);
  chk('取 CPU/内存的高者', j7.verdict === 'warn', 'cpu=30 ram=92 → ' + j7.label);

  // ⑨ 负例注入：把阈值调到极低，必然越线
  const j8 = judge(50, 50, { warnPct: 1, stopPct: 2 });
  chk('负例注入：阈值 1/2 → stop', j8.verdict === 'stop', j8.label);

  const j9 = judge(50, 50, { warnPct: 40, stopPct: 999 });
  chk('负例注入：阈值 40/999 → warn', j9.verdict === 'warn', j9.label);

  // ⑩ 实跑（快速模式）
  console.log();
  console.log('  实跑（--fast，约 0.3s）…');
  const real = await runGate({ fast: true });
  chk('实跑能出结论', typeof real.verdict === 'string', real.label + '  ' + real.reason);
  chk('实跑有 CPU/内存数值', typeof real.cpu === 'number' && typeof real.ram === 'number',
      'cpu=' + real.cpu + '% ram=' + real.ram + '%');
  chk('实跑退出码合法', [0, 10, 20, 3].includes(real.exit), String(real.exit));

  // ⑪ 关键：三档必须都能触发
  chk('关键：ok/warn/stop 三档都能触发',
      j1.verdict === 'ok' && j2.verdict === 'warn' && j3.verdict === 'stop',
      '这是三档设计的理由——不能只有 pass/fail');

  // ⚠ 2026-11-12 加：两处「应当失败」的反例（机制审计第④步）
  //
  //   前面那些是正例 + 边界值，但没明确验证「判据会不会在该失败时失败」。
  //   这两条专门验：
  //     ① 判据失效（永远放行）时必须被这条反例抓住
  //     ② 判据失效（永远拒绝）时也必须被抓住
  {
    // 反例1：如果把 judge 改成永远 ok（恒放行），这条会失败
    const alwaysOk = () => ({ verdict: 'ok', exit: GATE.EXIT.OK });
    chk('反例：恒放行的假判据必须被抓出来',
        alwaysOk(99, 99).exit === GATE.EXIT.OK && judge(99, 99).exit !== GATE.EXIT.OK,
        '真判据在 99%/99% 时必须判 stop');

    // 反例2：如果把 judge 改成永远 stop（恒拒绝），这条会失败
    const alwaysStop = () => ({ verdict: 'stop', exit: GATE.EXIT.STOP });
    chk('反例：恒拒绝的假判据必须被抓出来',
        alwaysStop(1, 1).exit === GATE.EXIT.STOP && judge(1, 1).exit !== GATE.EXIT.STOP,
        '真判据在 1%/1% 时必须判 ok');

    // 反例3：阈值边界不能写成 >= 和 > 混用（90.0% 时一个放行一个拦）
    chk('反例：warn 阈值边界必须一致（90% 恰好进 warn）',
        judge(GATE.WARN_PCT, 10).verdict === 'warn' &&
        judge(GATE.WARN_PCT - 1, 10).verdict === 'ok',
        'WARN_PCT=' + GATE.WARN_PCT + ' 时必须是 warn，低 1% 才是 ok');
  }

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (has('--selftest')) {
    const ok = await selftest();
    process.exit(ok ? 0 : 1);
  }

  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-12 加 --check（机制体检用这个，**不要用默认/--json**）
  //
  //    这是个**运行时闸门**：它的职责是「现在这台机器能不能派活」，
  //    必须读真实的 CPU/内存，没有「静态可查」的输入。
  //    所以：
  //      · 默认模式 / --json / --quiet 的退出码 10/20 是**运行状态**，
  //        不是「代码坏了」。机器忙到 95% 时它 exit 20，
  //        那说明机器忙，不说明负载闸写错了。
  //        拿它当体检项 = 把环境状态当判据（硬规矩第二版就是这么错的）。
  //
  //    --check 做什么：用**注入的假数据**验判据边界，不读真实负载。
  //      真正跑真实负载那部分**只报告**，不参与判定。
  //      判据被改坏（阈值/退出码/等号）→ exit 1。
  // ══════════════════════════════════════════════════════════════
  if (has('--check')) {
    const fails = [];
    const t = (name, ok, got) => { if (!ok) fails.push(name + '（实际 ' + got + '）'); };

    // 阈值常量
    t('采样次数应为 3', GATE.SAMPLE_N === 3, GATE.SAMPLE_N);
    t('warn 阈值应为 90', GATE.WARN_PCT === 90, GATE.WARN_PCT);
    t('stop 阈值应为 95', GATE.STOP_PCT === 95, GATE.STOP_PCT);
    t('退出码应为 0/10/20/3',
      GATE.EXIT.OK === 0 && GATE.EXIT.WARN === 10 &&
      GATE.EXIT.STOP === 20 && GATE.EXIT.UNKNOWN === 3,
      JSON.stringify(GATE.EXIT));

    // 判定边界（假数据，不受机器影响）
    t('30%/50% → ok', judge(30, 50).verdict === 'ok', judge(30, 50).verdict);
    t('89.9% → ok', judge(89.9, 50).verdict === 'ok', judge(89.9, 50).verdict);
    t('正好 90% → warn（含等号）', judge(90, 50).verdict === 'warn', judge(90, 50).verdict);
    t('92% → warn', judge(92, 50).verdict === 'warn', judge(92, 50).verdict);
    t('正好 95% → stop（含等号）', judge(95, 50).verdict === 'stop', judge(95, 50).verdict);
    t('96% → stop', judge(50, 96).verdict === 'stop', judge(50, 96).verdict);
    t('取 CPU/内存高者', judge(30, 92).verdict === 'warn', judge(30, 92).verdict);
    t('warn 时不许派单', judge(92, 50).canDispatch === false, judge(92, 50).canDispatch);
    t('stop 时不许重活', judge(50, 96).canHeavy === false, judge(50, 96).canHeavy);

    // 负例注入：阈值压到极低，必须越线（证明判据真的会被触发）
    t('阈值 1/2 → stop', judge(50, 50, { warnPct: 1, stopPct: 2 }).verdict === 'stop',
      judge(50, 50, { warnPct: 1, stopPct: 2 }).verdict);
    t('阈值 40/999 → warn', judge(50, 50, { warnPct: 40, stopPct: 999 }).verdict === 'warn',
      judge(50, 50, { warnPct: 40, stopPct: 999 }).verdict);

    // 真实负载仅报告（不参与判定）
    const real = await runGate({ fast: true });

    console.log('═'.repeat(72));
    console.log('  负载闸 · 检查（判据用假数据，真实负载仅报告）');
    console.log('═'.repeat(72));
    console.log();
    console.log('  真实负载（仅供参考，不作判据）: ' + (real.ok
      ? 'peak=' + real.peak + '% cpu=' + real.cpu + '% ram=' + real.ram + '% → ' + real.label
      : '量不了（' + real.reason + '）'));
    console.log();

    if (fails.length === 0) {
      console.log('  ✓ 负载闸判据正确（阈值/边界/退出码全部符合预期）');
      process.exit(0);
    }
    console.log('  ✗ 判据被改坏了：');
    for (const f of fails) console.log('    · ' + f);
    process.exit(1);
  }

  const r = await runGate({ fast: has('--fast') });

  if (has('--json')) {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.exit);
  }

  if (has('--quiet')) {
    console.log(r.label);
    process.exit(r.exit);
  }

  // 默认输出
  console.log('═'.repeat(72));
  console.log('  负载闸');
  console.log('═'.repeat(72));
  console.log();
  if (r.ok) {
    console.log('  CPU:   ' + r.cpu + '%' +
      (r.sampleCount > 1 ? '  （' + r.sampleCount + ' 次采样：' + r.samples.join(' / ') + '）' : ''));
    console.log('  内存:  ' + r.ram + '%  （' + (r.ramDetail.totalMB - r.ramDetail.freeMB) +
      ' / ' + r.ramDetail.totalMB + ' MB）');
    console.log('  峰值:  ' + r.peak + '%');
    console.log('  耗时:  ' + r.ms + ' ms');
    console.log();
    console.log('  ' + r.label);
    console.log('  ' + r.reason);
    console.log();
    console.log('  ' + (r.canDispatch ? '✓ 可派活' : '⛔ 不许派活'));
    console.log('  ' + (r.canHeavy ? '✓ 可跑重活' : '⛔ 连重活也别跑'));
  } else {
    console.log('  ' + r.label);
    console.log('  ' + r.reason);
    console.log();
    console.log('  ⚠ 「量不了」不等于「可以派单」，调用方一律当「别派」处理。');
  }
  console.log();
  console.log('─'.repeat(72));
  console.log('  退出码：0=可派 · 10=停止派单 · 20=停重活 · 3=量不了');
  console.log('─'.repeat(72));

  process.exit(r.exit);
}
