#!/usr/bin/env node
/**
 * 健康哨兵 —— 检查"场景有没有变差"
 *
 * ══════════════════════════════════════════════════════════════
 *  不变量
 * ══════════════════════════════════════════════════════════════
 *
 *  INV-1  first-pass-rate   一次通过率 < 40% 且样本足够 → 违规
 *  INV-2  cross-boundary    越界次数 ≥ 1 → 违规
 *  INV-3  degrading-trend   连续 2 个窗口指标下降 → 违规
 *  INV-4  evidence-file     健康度.json 里的数据必须能追溯到派单台账（防伪造）
 *
 *  INV-4 特别重要：
 *    如果健康度可以手写，那"变好了"就是自欺。
 *    必须能证明每个数字都是从真实台账算出来的。
 *
 * ══════════════════════════════════════════════════════════════
 *  诚实的空状态
 * ══════════════════════════════════════════════════════════════
 *
 *  窗口内没有派单记录 = 没有数据可评估。
 *  这不是"通过"，是"无法评估"。
 *  哨兵对此输出 PASS 但附带明确提示（不能假装健康）。
 */

import fs from 'node:fs';
import os from 'node:os';   // ⚠ 2026-11-12 补：自测要在临时目录造反例，不能碰真实数据
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');

export const THRESHOLDS = {
  MIN_SAMPLES: 3,
  FIRST_PASS_BAD: 0.40,
  FIRST_PASS_WARN: 0.60,
  CROSS_BOUNDARY_WARN: 1,
  TREND_DECLINE: 0.15,     // 下降超过 15% 算退化
};

function readJson(p, fb) {
  try {
    let s = fs.readFileSync(p, 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    return JSON.parse(s);
  } catch { return fb; }
}

/**
 * @param {object} opt
 *   opt.dataRoot  .dsh 目录
 *   opt.nowMs     当前时间
 */
export function check(opt) {
  const dataRoot = opt.dataRoot || path.join(WB, '数据', '.dsh');
  const nowMs = opt.nowMs || Date.now();
  const diffs = [];
  const ID = 'health-guard';
  const stats = { scenes: 0, withData: 0, noData: 0, bad: 0, warn: 0 };

  const shared = path.join(dataRoot, '场景记忆', '_共享记忆');
  const healthFile = path.join(shared, '健康度.json');

  if (!fs.existsSync(healthFile)) {
    // 没跑过健康度采集 —— 不违规，但提示
    return { id: ID, diffs, stats: Object.assign(stats, { empty: true }), note: '未采集过健康度（跑 工具/健康度计算.mjs）' };
  }

  const health = readJson(healthFile, null);
  if (!health) {
    diffs.push('健康度.json 解析失败');
    return { id: ID, diffs, stats };
  }

  const scenes = health.scenes || {};
  stats.scenes = Object.keys(scenes).length;

  // ═══ 逐场景检查 ═══
  for (const [key, s] of Object.entries(scenes)) {
    if (!s.hasEnoughSamples) {
      stats.noData++;
      continue;
    }
    stats.withData++;

    // ── INV-1 一次通过率太低 ──
    if (s.firstPassRate !== null && s.firstPassRate < THRESHOLDS.FIRST_PASS_BAD) {
      stats.bad++;
      diffs.push(
        '场景「' + s.scene + '」一次通过率 ' +
        Math.round(s.firstPassRate * 100) + '% < ' + Math.round(THRESHOLDS.FIRST_PASS_BAD * 100) + '%' +
        '（' + s.firstPass + '/' + s.tasks + '，需要归因）'
      );
    }

    // ── INV-2 越界 ──
    if (s.crossBoundary >= THRESHOLDS.CROSS_BOUNDARY_WARN) {
      stats.warn++;
      diffs.push(
        '场景「' + s.scene + '」越界 ' + s.crossBoundary + ' 次（应 ≥1 次即警告）'
      );
    }
  }

  // ═══ INV-3 趋势下降 ═══
  const history = health.history || [];
  if (history.length >= 2) {
    const recent = history.slice(-2);
    for (const sceneKey of Object.keys(scenes)) {
      const rates = recent
        .map(w => (w.scenes && w.scenes[sceneKey] && w.scenes[sceneKey].firstPassRate))
        .filter(x => typeof x === 'number');
      if (rates.length === 2 && rates[1] < rates[0] - THRESHOLDS.TREND_DECLINE) {
        diffs.push(
          '场景「' + sceneKey + '」趋势下降：' +
          Math.round(rates[0] * 100) + '% → ' + Math.round(rates[1] * 100) +
          '（下降 ' + Math.round((rates[0] - rates[1]) * 100) + ' 个百分点）'
        );
      }
    }
  }

  // ═══ INV-4 可追溯性：健康度必须能由派单台账算出 ═══
  const ledgerFile = path.join(shared, '派单台账.json');
  const ledger = readJson(ledgerFile, { dispatches: [] });
  const dispatches = (ledger.dispatches || []).filter(d => d.type === 'dispatch');

  // 简单交叉验证：健康度里的 tasks 总数不该超过台账里的 dispatch 总数
  let healthTasks = 0;
  for (const s of Object.values(scenes)) healthTasks += (s.tasks || 0);

  if (healthTasks > 0 && dispatches.length === 0) {
    diffs.push(
      '健康度声称有 ' + healthTasks + ' 个任务，但派单台账里 0 条 dispatch' +
      '（健康度数据无法追溯 —— 可能是手写伪造的）'
    );
  } else if (healthTasks > dispatches.length) {
    diffs.push(
      '健康度任务数（' + healthTasks + '）超过派单台账 dispatch 数（' + dispatches.length +
      '）—— 数据不一致'
    );
  }

  return { id: ID, diffs, stats };
}

// ══════════════════════════════════════════════════════════════
//  自测（含应当失败的反例）
//
//  ⚠ 2026-11-12 补：原来没有 selftest、没有反例，机制审计判它
//    「①4 反例 0 处 · ①5 无自测入口」两项不满足 = 口号。
//
//    为什么必须补：健康哨兵此前**从未被证明会失败过**。
//    它判的是「场景有没有变差」，如果判据写错了（比如阈值方向反了、
//    字段名拼错），它会对真退化永远 PASS —— 那就是装饰，
//    而「场景变差」恰恰是最不能漏的一类。
//
//    这里的反例都是**真造数据**：在临时目录写一份必然违规的
//    健康度.json / 派单台账.json，然后调真实的 check() 读它。
//    不是 `!true` 这种恒真断言。
// ══════════════════════════════════════════════════════════════
export function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  健康哨兵 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ── ① 阈值常量本身是对的（判据唯一出处，别被顺手改小）──
  chk('一次通过率红线 = 40%', THRESHOLDS.FIRST_PASS_BAD === 0.40, String(THRESHOLDS.FIRST_PASS_BAD));
  chk('最小样本 = 3', THRESHOLDS.MIN_SAMPLES === 3, String(THRESHOLDS.MIN_SAMPLES));
  chk('越界警告阈值 = 1', THRESHOLDS.CROSS_BOUNDARY_WARN === 1, String(THRESHOLDS.CROSS_BOUNDARY_WARN));
  chk('趋势退化幅度 = 15%', THRESHOLDS.TREND_DECLINE === 0.15, String(THRESHOLDS.TREND_DECLINE));

  const NOW = Date.parse('2026-11-12T12:00:00Z');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'healthguard-'));
  const shared = path.join(tmp, '场景记忆', '_共享记忆');
  fs.mkdirSync(shared, { recursive: true });

  const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8');

  // 造一套「合规」的健康度：通过率 80%、无越界、无趋势下降、台账 10 条
  function goodHealth() {
    return {
      scenes: {
        demo: {
          scene: 'demo', tasks: 10, firstPass: 8, firstPassRate: 0.8,
          crossBoundary: 0, hasEnoughSamples: true,
        },
      },
      history: [],
    };
  }
  function goodLedger() {
    const dispatches = [];
    for (let i = 0; i < 10; i++) {
      dispatches.push({ id: 'd-x-' + i, type: 'dispatch', to: 'demo', subject: '任务' + i, state: 'acked' });
    }
    return { dispatches };
  }

  // 每次跑反例前先铺一份合规基线，避免上一条的残留污染下一条
  function reset(health, ledger) {
    writeJson(path.join(shared, '健康度.json'), health || goodHealth());
    writeJson(path.join(shared, '派单台账.json'), ledger || goodLedger());
  }

  // ── ② 正例：合规数据必须 PASS ──
  reset();
  const okRun = check({ dataRoot: tmp, nowMs: NOW });
  chk('正例：合规数据通过（差异集合 = 0）', okRun.diffs.length === 0,
      okRun.diffs.slice(0, 2).join('; '));

  // ── ③ 反例 1：一次通过率 30% < 40% → 必须报 ──
  {
    const h = goodHealth();
    h.scenes.demo.firstPass = 3;
    h.scenes.demo.firstPassRate = 0.30;
    reset(h);
    const r = check({ dataRoot: tmp, nowMs: NOW });
    chk('反例：一次通过率 30%（< 40%）应当失败', !(r.diffs.length === 0),
        r.diffs[0] || '⚠ 没报，说明 INV-1 判据失效');
  }

  // ── ④ 反例 2：越界 1 次 → 必须报 ──
  {
    const h = goodHealth();
    h.scenes.demo.crossBoundary = 1;
    reset(h);
    const r = check({ dataRoot: tmp, nowMs: NOW });
    chk('反例：越界 1 次应当失败', !(r.diffs.length === 0),
        r.diffs[0] || '⚠ 没报，说明 INV-2 判据失效');
  }

  // ── ⑤ 反例 3：健康度声称 10 个任务但台账 0 条 → 必须报「无法追溯」──
  {
    reset(null, { dispatches: [] });
    const r = check({ dataRoot: tmp, nowMs: NOW });
    chk('反例：健康度无台账可追溯应当失败', !(r.diffs.length === 0),
        r.diffs[0] || '⚠ 没报，说明 INV-4 判据失效');
  }

  // ── ⑥ 反例 4：趋势下降 60% → 20%（降 40 个百分点 > 15）→ 必须报 ──
  {
    const h = goodHealth();
    h.scenes.demo.firstPassRate = 0.20;
    h.scenes.demo.firstPass = 2;
    h.history = [
      { scenes: { demo: { firstPassRate: 0.60 } } },
      { scenes: { demo: { firstPassRate: 0.20 } } },
    ];
    // 台账放到 10 条，避免 INV-4 抢了这条的头条，确保报的是趋势
    reset(h);
    const r = check({ dataRoot: tmp, nowMs: NOW });
    const hit = r.diffs.some(x => x.includes('趋势下降'));
    chk('反例：趋势下降 40 个百分点应当失败', hit,
        hit ? r.diffs.find(x => x.includes('趋势下降'))
            : '⚠ 没报趋势下降，说明 INV-3 判据失效；实际: ' + (r.diffs[0] || '(空)'));
  }

  // ── ⑦ 边界：通过率 40%（恰好等于红线）→ 不该报，判据必须是「严格小于」──
  {
    const h = goodHealth();
    h.scenes.demo.firstPass = 4;
    h.scenes.demo.firstPassRate = 0.40;
    reset(h);
    const r = check({ dataRoot: tmp, nowMs: NOW });
    chk('边界：通过率恰好 40% 不判失败', r.diffs.length === 0,
        r.diffs[0] || '（严格小于判据正确）');
  }

  // ── ⑧ 边界：样本不足（hasEnoughSamples=false）→ 不评估，不报 ──
  {
    const h = goodHealth();
    h.scenes.demo = {
      scene: 'demo', tasks: 2, firstPass: 0, firstPassRate: 0,
      crossBoundary: 99, hasEnoughSamples: false,
    };
    reset(h, { dispatches: goodLedger().dispatches.slice(0, 2) });
    const r = check({ dataRoot: tmp, nowMs: NOW });
    chk('边界：样本不足时不评估（不误报）', r.diffs.length === 0,
        r.diffs[0] || '（正确跳过）');
  }

  // ── ⑨ 边界：健康度.json 不存在 → 不算违规（诚实空状态）──
  {
    fs.rmSync(path.join(shared, '健康度.json'), { force: true });
    const r = check({ dataRoot: tmp, nowMs: NOW });
    chk('边界：未采集过健康度不算违规', r.diffs.length === 0 && !!r.note,
        r.note || '（应给提示）');
  }

  // ── ⑩ 关键：4 个反例必须全部被检出 ──
  //    ⚠ 2026-11-12：用显式变量攒结果，不靠数组下标切片
  //      （切片写错会让这条「永远通过」，又是一条新的装饰）
  {
    const hitLowRate = R[5];
    const hitCross = R[6];
    const hitTrace = R[7];
    const hitTrend = R[8];
    chk('关键：造出的 4 个违规数据全部被检出（判据不是装饰）',
        hitLowRate === true && hitCross === true && hitTrace === true && hitTrend === true,
        '通过率=' + hitLowRate + ' 越界=' + hitCross +
        ' 追溯=' + hitTrace + ' 趋势=' + hitTrend);
  }

  fs.rmSync(tmp, { recursive: true, force: true });

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

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  // ⚠ 2026-11-12 补：--selftest 入口（五步法第 5 步「挂到节奏上」）。
  //   没有入口的自测 = 写了但没人跑 = 等于没写。
  if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);

  const dataRoot = process.env.SEA_DATA_DIR
    ? path.resolve(process.env.SEA_DATA_DIR)
    : path.join(WB, '数据', '.dsh');

  const nowMs = process.env.SEA_NOW
    ? (Number.isFinite(+process.env.SEA_NOW) ? +process.env.SEA_NOW : Date.parse(process.env.SEA_NOW))
    : Date.now();

  const r = check({ dataRoot, nowMs });

  console.log('  场景: ' + r.stats.scenes + '  有数据: ' + r.stats.withData +
    '  无数据: ' + r.stats.noData);
  if (r.note) console.log('  提示: ' + r.note);
  console.log();

  if (r.diffs.length === 0) {
    console.log('PASS ' + r.id + ': 差异集合 = 0');
    if (r.stats.withData === 0) {
      console.log('  ⚠ 注意：这不是"健康"，是"没有数据可评估"（窗口内无派单记录）');
    }
    process.exit(0);
  } else {
    console.log('FAIL ' + r.id + ': 差异集合 = ' + r.diffs.length + ' 项');
    for (const d of r.diffs) console.log('  - ' + d);
    process.exit(1);
  }
}
