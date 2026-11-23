#!/usr/bin/env node
/**
 * 健康度 —— 自进化的信号层
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么自进化必须先有信号
 * ══════════════════════════════════════════════════════════════
 *
 *  "自进化"不是"AI 自己改自己"（那是失控）。
 *  自进化 = 场景在运行中变好，且这个"变好"可验证。
 *
 *  三个必要条件（缺一则退化）：
 *    ① 有信号 —— 知道做得好不好
 *    ② 有归因 —— 知道为什么
 *    ③ 有改进 —— 能把归因变成可验证的改动
 *
 *  没有信号 → 进化就是随机漂移。
 *
 * ══════════════════════════════════════════════════════════════
 *  三个指标（全部自动采集，不需要人工打分）
 * ══════════════════════════════════════════════════════════════
 *
 *  一次通过率 = 首次交付被接受 / 总交付
 *    数据来源：派单台账里 acked 且没有 rework 标记的记录
 *
 *  返工次数 = 同一 subject 被重复派单的次数
 *    数据来源：派单台账里相同 subject 出现多次
 *
 *  越界次数 = 动了不该动的东西
 *    数据来源：越界哨兵的历史记录
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/健康度.mjs                # 打印当前健康度
 *  node 工具/健康度.mjs --save         # 写入 _共享记忆/健康度.json
 *  node 工具/健康度.mjs --scene <id>   # 只看某个场景
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');

// ══════════════════════════════════════════════════════════════
//  阈值（唯一出处）
// ══════════════════════════════════════════════════════════════
export const THRESHOLDS = {
  MIN_SAMPLES: 3,          // 少于此样本数不算健康度（避免小样本误导）
  FIRST_PASS_WARN: 0.60,   // 一次通过率低于此 → 警告
  FIRST_PASS_BAD: 0.40,    // 低于此 → 严重
  TREND_WINDOW: 2,         // 连续多少个窗口下降算 "degrading"
  CROSS_BOUNDARY_WARN: 1,  // 越界次数达到此 → 警告
};

function readJson(p, fb) {
  try {
    let s = fs.readFileSync(p, 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    return JSON.parse(s);
  } catch { return fb; }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

// ══════════════════════════════════════════════════════════════
//  核心：采集健康度
// ══════════════════════════════════════════════════════════════

/**
 * @param {object} opt
 *   opt.dataRoot   .dsh 目录
 *   opt.windowDays 统计窗口（默认 7 天）
 *   opt.nowMs      当前时间
 */
export function collect(opt) {
  const dataRoot = opt.dataRoot || path.join(WB, '数据', '.dsh');
  const nowMs = opt.nowMs || Date.now();
  const windowMs = (opt.windowDays || 7) * 86400000;
  const cutoff = nowMs - windowMs;

  const shared = path.join(dataRoot, '场景记忆', '_共享记忆');

  // ═══ 从派单台账采集 ═══
  const ledger = readJson(path.join(shared, '派单台账.json'), { dispatches: [] });
  const dispatches = (ledger.dispatches || []);

  // 按场景聚合
  const byScene = {};

  function ensure(scene) {
    if (!byScene[scene]) {
      byScene[scene] = {
        scene,
        tasks: 0,         // 总派单数
        acked: 0,         // 已回执数
        received: 0,      // 收到的派单（作为 to）
        sent: 0,          // 发出的派单（作为 from）
        rework: 0,        // 返工次数
        firstPass: 0,     // 一次通过数
        crossBoundary: 0, // 越界次数（从越界记录读）
        subjects: {},
      };
    }
    return byScene[scene];
  }

  for (const d of dispatches) {
    if (d.type !== 'dispatch') continue;
    const created = new Date(d.createdAt).getTime();
    if (!Number.isFinite(created) || created < cutoff) continue;

    // 作为发起方
    const from = ensure(d.from);
    from.sent++;

    // 作为承接方
    const to = ensure(d.to);
    to.received++;
    to.tasks++;

    // 同 subject 重复 = 返工
    const key = String(d.subject || '').trim();
    if (key) {
      to.subjects[key] = (to.subjects[key] || 0) + 1;
      if (to.subjects[key] > 1) to.rework++;
    }

    // ★ 自检修复：只认 'acked' 会漏掉已销账（closed）的记录
    //   真实场景：派单走完 created → delivered → acked → closed
    //   销账后 state = 'closed'，但它确实回过执
    //   最准的判据是 ackedAt 字段是否存在
    const hasAcked = !!d.ackedAt || d.state === 'acked' || d.state === 'closed';
    if (hasAcked) {
      to.acked++;
      // 一次通过：有回执且没被标记 rework
      if (!d.needsRework) to.firstPass++;
    }
  }

  // ═══ 从越界记录采集 ═══
  const boundaryLog = readJson(path.join(shared, '越界记录.json'), { events: [] });
  for (const ev of (boundaryLog.events || [])) {
    const t = new Date(ev.at || 0).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    if (ev.tier !== 'D' && ev.tier !== 'E') continue;
    if (ev.scene) ensure(ev.scene).crossBoundary++;
  }

  // ═══ 计算比率与趋势 ═══
  const result = { scenes: {}, window: { from: new Date(cutoff).toISOString(), to: new Date(nowMs).toISOString(), days: opt.windowDays || 7 } };

  for (const [scene, s] of Object.entries(byScene)) {
    const denominator = s.tasks || 0;
    const firstPassRate = denominator > 0 ? s.firstPass / denominator : null;
    const reworkRate = denominator > 0 ? s.rework / denominator : null;

    let verdict = 'no-data';
    if (denominator >= THRESHOLDS.MIN_SAMPLES) {
      if (firstPassRate !== null && firstPassRate < THRESHOLDS.FIRST_PASS_BAD) verdict = 'bad';
      else if (firstPassRate !== null && firstPassRate < THRESHOLDS.FIRST_PASS_WARN) verdict = 'warn';
      else if (s.crossBoundary >= THRESHOLDS.CROSS_BOUNDARY_WARN) verdict = 'warn';
      else verdict = 'ok';
    }

    result.scenes[scene] = {
      scene,
      tasks: s.tasks,
      acked: s.acked,
      sent: s.sent,
      rework: s.rework,
      firstPass: s.firstPass,
      firstPassRate,
      reworkRate,
      crossBoundary: s.crossBoundary,
      verdict,
      hasEnoughSamples: denominator >= THRESHOLDS.MIN_SAMPLES,
    };
  }

  // 全局
  const all = Object.values(result.scenes);
  result.summary = {
    scenes: all.length,
    withData: all.filter(x => x.hasEnoughSamples).length,
    ok: all.filter(x => x.verdict === 'ok').length,
    warn: all.filter(x => x.verdict === 'warn').length,
    bad: all.filter(x => x.verdict === 'bad').length,
    noData: all.filter(x => x.verdict === 'no-data').length,
  };

  return result;
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const dataRoot = process.env.SEA_DATA_DIR
    ? path.resolve(process.env.SEA_DATA_DIR)
    : path.join(WB, '数据', '.dsh');

  const wi = args.indexOf('--window');
  const windowDays = wi >= 0 ? parseInt(args[wi + 1], 10) : 7;

  const nowMs = process.env.SEA_NOW
    ? (Number.isFinite(+process.env.SEA_NOW) ? +process.env.SEA_NOW : Date.parse(process.env.SEA_NOW))
    : Date.now();

  const h = collect({ dataRoot, windowDays, nowMs });

  const si = args.indexOf('--scene');
  const onlyScene = si >= 0 ? args[si + 1] : null;

  console.log('═'.repeat(74));
  console.log('  健康度  ' + h.window.from.slice(0, 10) + ' ~ ' + h.window.to.slice(0, 10) +
    '（' + h.window.days + ' 天）');
  console.log('═'.repeat(74));
  console.log();

  const entries = Object.values(h.scenes);
  if (!entries.length) {
    console.log('  （窗口内没有派单记录 —— 无法评估）');
    console.log();
    console.log('  说明：健康度依赖真实派单数据。');
    console.log('        没有数据 = 系统从未真实运转 = 健康度无从谈起。');
    console.log();
  } else {
    console.log('  ' + '场景'.padEnd(16) + '任务'.padEnd(6) + '回执'.padEnd(6) +
      '一次通过'.padEnd(10) + '返工'.padEnd(6) + '越界'.padEnd(6) + '判定');
    console.log('  ' + '─'.repeat(70));
    for (const s of entries) {
      if (onlyScene && s.scene !== onlyScene) continue;
      const fpr = s.firstPassRate === null ? '—' : Math.round(s.firstPassRate * 100) + '%';
      const vmark = s.verdict === 'ok' ? '✓' : (s.verdict === 'bad' ? '⛔' : (s.verdict === 'warn' ? '⚠' : '·'));
      console.log('  ' +
        String(s.scene).padEnd(16) +
        String(s.tasks).padEnd(6) +
        String(s.acked).padEnd(6) +
        String(fpr).padEnd(10) +
        String(s.rework).padEnd(6) +
        String(s.crossBoundary).padEnd(6) +
        vmark + ' ' + s.verdict
      );
    }
  }

  console.log();
  console.log('  汇总: 有数据 ' + h.summary.withData + ' / 场景 ' + h.summary.scenes +
    '   ok=' + h.summary.ok + '  warn=' + h.summary.warn +
    '  bad=' + h.summary.bad + '  no-data=' + h.summary.noData);
  console.log();

  if (args.includes('--save')) {
    const out = Object.assign({}, h, { _at: new Date(nowMs).toISOString() });
    const p = path.join(dataRoot, '场景记忆', '_共享记忆', '健康度.json');
    writeJson(p, out);
    console.log('已保存: ' + path.relative(path.resolve(WB, '..'), p));
    console.log();
  }
}
