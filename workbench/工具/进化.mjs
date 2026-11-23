#!/usr/bin/env node
/**
 * 进化 —— 自进化的改进层（三级 + 回滚）
 *
 * ══════════════════════════════════════════════════════════════
 *  三级进化（风险从低到高）
 * ══════════════════════════════════════════════════════════════
 *
 *  L1 记忆进化（自动，不需要审批）
 *     动作：把坑与决策追加进 §五
 *     限制：只追加不修改；单条 ≤ 200 字；总长受 25KB 红线约束
 *     回滚：不需要（只追加，不破坏已有）
 *
 *  L2 技能进化（半自动，需要回测）
 *     触发：同类问题 30 天内出现 ≥3 次
 *     动作：生成技能补丁 → 用历史失败案例回测 → 通过才写
 *     回滚：技能文件带 version + changelog，可回退
 *
 *  L3 身份进化（人工确认）
 *     触发：同类判断被纠正 ≥2 次；或越界 ≥2 次
 *     动作：修订身份卡的职责边界
 *     限制：必须人工确认后才写入
 *     回滚：身份卡带 version，可回退
 *
 * ══════════════════════════════════════════════════════════════
 *  三条安全阀（防"进化"变成"退化"）
 * ══════════════════════════════════════════════════════════════
 *
 *  ① 版本化：技能/身份卡都带 version + changelog
 *  ② 对比验证：进化后观察 3 次任务，指标跌 >15% → 警报
 *  ③ 自动回滚 + 冻结：连续 2 次退化 → 回滚 → 冻结该场景的 L2/L3
 *
 *  "进化是有刹车的加速。"
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/进化.mjs --list                          # 列出所有进化记录
 *  node 工具/进化.mjs --record --scene X --level L2 --type skill \
 *       --target <文件> --change "改了什么" --trigger "为什么改" \
 *       --backtest '{"cases":3,"passed":3}'            # 登记一次进化
 *  node 工具/进化.mjs --observe <id> --result improved|stable|degraded
 *  node 工具/进化.mjs --rollback <id>                  # 回滚（用备份）
 *  node 工具/进化.mjs --frozen                         # 列出被冻结的场景
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');

export const EVOLUTION_FILE_REL = path.join('场景记忆', '_共享记忆', '进化台账.json');

export const LEVEL = {
  L1: 'L1',   // 记忆（自动）
  L2: 'L2',   // 技能（回测通过才写）
  L3: 'L3',   // 身份（人工确认）
};

export const RESULT = {
  PENDING: 'pending',
  IMPROVED: 'improved',
  STABLE: 'stable',
  DEGRADED: 'degraded',
};

// 安全阀阈值
//
// ⚠ 2026-11-10 修复（依据 方案/120 调研）：
//   bug 2 → OBSERVE_TASKS 原注释写"观察 3 次任务"，
//           但 :298 的实现是 +3*86400000 = 3 个【日历日】，单位错配。
//           现在拆成两个独立常量，各自语义清晰。
//   bug 1 → DEGRADE_THRESHOLD 原来只定义、从不使用。
//           现在 --observe 用它自动判定退化（见 observe 分支）。
export const GUARD = {
  /** 观察期 = N 个日历日（原 OBSERVE_TASKS 的真实语义） */
  OBSERVE_DAYS: 3,
  /** 最少需要多少个真实样本才允许回填（原意"3 次任务"） */
  OBSERVE_MIN_SAMPLES: 3,
  /** 指标跌超过这个比例算退化（-15% 及以上） */
  DEGRADE_THRESHOLD: 0.15,
  /** 连续 N 次退化 → 自动冻结 */
  MAX_CONSECUTIVE_DEGRADE: 2,
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

export function ledgerPath(dataRoot) {
  return path.join(dataRoot, EVOLUTION_FILE_REL);
}

export function loadLedger(dataRoot) {
  const j = readJson(ledgerPath(dataRoot), null);
  if (!j) {
    return {
      _note: '进化台账 —— 每次进化都必须登记，否则无法回滚',
      _levels: {
        L1: '记忆（自动，只追加）',
        L2: '技能（回测通过才写）',
        L3: '身份（人工确认）',
      },
      _guard: GUARD,
      evolutions: [],
      frozen: {},
    };
  }
  if (!Array.isArray(j.evolutions)) j.evolutions = [];
  if (!j.frozen) j.frozen = {};
  return j;
}

export function saveLedger(dataRoot, ledger) {
  writeJson(ledgerPath(dataRoot), ledger);
}

// ══════════════════════════════════════════════════════════════
//  晋级门槛判定
// ══════════════════════════════════════════════════════════════

/**
 * 检查一次进化是否满足晋级门槛
 * @returns {string[]} 不满足的原因（空 = 通过）
 */
export function checkPromotion(rec) {
  const problems = [];

  // L1 无门槛（但必须只追加）
  if (rec.level === LEVEL.L1) {
    if (rec.type !== 'memory') {
      problems.push('L1 只能是 memory 类型（记忆进化），实际 ' + rec.type);
    }
    return problems;
  }

  // L2 必须回测
  if (rec.level === LEVEL.L2) {
    if (!rec.backtest) {
      problems.push('L2 技能进化必须提供 backtest（回测结果）');
    } else {
      const cases = Number(rec.backtest.cases);
      const passed = Number(rec.backtest.passed);
      if (!Number.isFinite(cases) || cases < 1) {
        problems.push('L2 回测必须至少 1 个用例');
      } else if (!Number.isFinite(passed) || passed < cases) {
        problems.push('L2 回测未全部通过（' + passed + '/' + cases + '）');
      }
    }
  }

  // L3 必须人工确认
  if (rec.level === LEVEL.L3) {
    if (!rec.humanConfirmed) {
      problems.push('L3 身份进化必须 humanConfirmed = true（人工确认后才能写）');
    }
    if (!rec.confirmedBy || String(rec.confirmedBy).trim().length < 2) {
      problems.push('L3 必须记录 confirmedBy（谁确认的）');
    }
  }

  // 通用：必须说明为什么改
  if (!rec.trigger || String(rec.trigger).trim().length < 5) {
    problems.push('必须说明触发原因（trigger ≥5 字）');
  }

  // 通用：必须说明改了什么
  if (!rec.change || String(rec.change).trim().length < 5) {
    problems.push('必须说明改了什么（change ≥5 字）');
  }

  // 通用：目标路径必须存在
  if (!rec.target) {
    problems.push('必须指定 target（改的是哪个文件）');
  }

  return problems;
}

// ══════════════════════════════════════════════════════════════
//  安全阀判定
// ══════════════════════════════════════════════════════════════

/**
 * 判断某场景是否应该冻结（连续退化）
 */
export function shouldFreeze(ledger, scene) {
  const recs = ledger.evolutions.filter(e => e.scene === scene && e.level !== LEVEL.L1);
  // 只看已观察的
  const observed = recs.filter(e => e.result && e.result !== RESULT.PENDING);
  // 从最近的开始数连续 degraded
  let consecutive = 0;
  for (let i = observed.length - 1; i >= 0; i--) {
    if (observed[i].result === RESULT.DEGRADED) consecutive++;
    else break;
  }
  return {
    should: consecutive >= GUARD.MAX_CONSECUTIVE_DEGRADE,
    consecutive,
    needed: GUARD.MAX_CONSECUTIVE_DEGRADE,
  };
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

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dataRoot = process.env.SEA_DATA_DIR
    ? path.resolve(process.env.SEA_DATA_DIR)
    : path.join(WB, '数据', '.dsh');

  const ledger = loadLedger(dataRoot);

  // ── 列出 ──
  if (has('list')) {
    console.log('═'.repeat(80));
    console.log('  进化台账（共 ' + ledger.evolutions.length + ' 条）');
    console.log('═'.repeat(80));
    console.log();
    if (!ledger.evolutions.length) {
      console.log('  （空 —— 还没有任何进化记录）');
      console.log();
      console.log('  说明：进化必须先登记，否则无法回滚。');
      console.log('        这是"可控进化"和"随机漂移"的分界线。');
    } else {
      console.log('  ' + 'ID'.padEnd(20) + '场景'.padEnd(14) + '级别'.padEnd(6) +
        '类型'.padEnd(10) + '结果'.padEnd(12) + '变化');
      console.log('  ' + '─'.repeat(76));
      for (const e of ledger.evolutions) {
        const mark = e.result === RESULT.DEGRADED ? ' ⛔' : (e.result === RESULT.IMPROVED ? ' ✓' : '');
        console.log('  ' +
          String(e.id).padEnd(20) +
          String(e.scene).padEnd(14) +
          String(e.level).padEnd(6) +
          String(e.type).padEnd(10) +
          (String(e.result || '-') + mark).padEnd(12) +
          String(e.change).slice(0, 24));
      }
    }
    console.log();
    if (Object.keys(ledger.frozen).length) {
      console.log('  🧊 已冻结的场景:');
      for (const [scene, info] of Object.entries(ledger.frozen)) {
        console.log('    ' + scene + '  ' + (info.reason || '') + '  (' + info.at + ')');
      }
      console.log();
    }
    process.exit(0);
  }

  // ── 登记进化 ──
  if (has('record')) {
    const scene = argv('scene');
    const level = argv('level');
    const type = argv('type');
    const target = argv('target');
    const change = argv('change');
    const trigger = argv('trigger');

    if (!scene || scene === true) { console.error('缺 --scene'); process.exit(2); }
    if (!level || level === true) { console.error('缺 --level (L1/L2/L3)'); process.exit(2); }
    if (!Object.values(LEVEL).includes(level)) { console.error('--level 必须是 L1/L2/L3'); process.exit(2); }
    if (!type || type === true) { console.error('缺 --type (memory/skill/identity)'); process.exit(2); }
    if (!target || target === true) { console.error('缺 --target'); process.exit(2); }
    if (!change || change === true) { console.error('缺 --change'); process.exit(2); }
    if (!trigger || trigger === true) { console.error('缺 --trigger'); process.exit(2); }

    // 冻结检查
    if (ledger.frozen[scene]) {
      console.error('⛔ 场景「' + scene + '」已被冻结：' + ledger.frozen[scene].reason);
      console.error('   解冻需要人工确认（--unfreeze --scene ' + scene + '）');
      process.exit(2);
    }

    const rec = {
      id: 'ev-' + new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-'),
      scene,
      level,
      type,
      target,
      change,
      trigger,
      backtest: null,
      humanConfirmed: has('human-confirmed'),
      confirmedBy: argv('confirmed-by') === true ? null : argv('confirmed-by'),
      at: new Date().toISOString(),
      observeUntil: new Date(Date.now() + GUARD.OBSERVE_DAYS * 86400000).toISOString().slice(0, 10),
      result: RESULT.PENDING,
      rolledBack: false,
    };

    const bt = argv('backtest');
    if (bt && bt !== true) {
      try {
        rec.backtest = JSON.parse(bt);
      } catch (e) {
        console.error('--backtest 必须是 JSON: ' + e.message);
        process.exit(2);
      }
    }

    // 晋级门槛
    const problems = checkPromotion(rec);
    if (problems.length) {
      console.error('⛔ 进化门槛未通过：');
      for (const p of problems) console.error('   - ' + p);
      process.exit(2);
    }

    ledger.evolutions.push(rec);
    saveLedger(dataRoot, ledger);

    console.log('已登记进化: ' + rec.id);
    console.log('  场景: ' + scene + '  级别: ' + level + '  类型: ' + type);
    console.log('  改动: ' + change);
    console.log('  观察期到: ' + rec.observeUntil + '（' + GUARD.OBSERVE_DAYS + ' 个日历日）');
    console.log('  回填要求: 至少 ' + GUARD.OBSERVE_MIN_SAMPLES + ' 个真实样本 + 机器可读的指标变化');
    console.log();
    console.log('  后续：观察后运行 --observe ' + rec.id + ' --sealed-delta <数值> --samples <样本数>');
    console.log('        --sealed-delta 是「封存集得分变化」，正数=变好，负数=变差');
    console.log('        退化判定：delta <= -' + GUARD.DEGRADE_THRESHOLD + ' 时自动判 degraded');
    process.exit(0);
  }

  // ── 回填观察结果 ──
  //
  // ⚠ 2026-11-10 重写（依据 方案/120 调研 P1/P2）：
  //
  //   旧实现：--observe <id> --result improved|stable|degraded
  //     → 观察结果由**人传一个字符串**，无任何证据绑定。
  //     → 等于"让 Agent 自己说自己变好了"，这正是 2607.24300 证明的失效模式。
  //
  //   新实现：必须提供**机器可读的封存集指标变化**
  //     --observe <id> --sealed-delta <数值> --samples <样本数>
  //     → 退化判定由 DEGRADE_THRESHOLD 自动算，不接受人工指定 result
  //     → 样本数不足 OBSERVE_MIN_SAMPLES 时拒绝回填
  //
  //   为什么：2607.24300（6 模型 3 种子）与 2610.11464 的核心结论 ——
  //   Agent 同时控制"被优化对象"和"验证器"时，自评必然与真实性能脱钩。
  const obIdx = process.argv.indexOf('--observe');
  if (obIdx >= 0) {
    const id = process.argv[obIdx + 1];
    const rec = ledger.evolutions.find((e) => e.id === id);
    if (!rec) { console.error('找不到: ' + id); process.exit(2); }

    // ① 必须带封存集指标变化（机器可读）
    const rawDelta = argv('sealed-delta');
    if (rawDelta === undefined || rawDelta === '') {
      console.error('⛔ 缺少 --sealed-delta');
      console.error('   观察结果不能由人指定，必须提供封存集的机器指标变化。');
      console.error('   用法：--observe ' + id + ' --sealed-delta <数值> --samples <样本数>');
      console.error('   说明：sealed-delta = 封存集得分变化，正数=变好，负数=变差');
      console.error('         （例如 +0.08 表示得分提升 8 个百分点）');
      process.exit(2);
    }

    const sealedDelta = Number(rawDelta);
    if (!Number.isFinite(sealedDelta)) {
      console.error('⛔ --sealed-delta 必须是数字，收到: ' + rawDelta);
      process.exit(2);
    }

    // ② 必须带样本数，且不少于阈值
    const rawSamples = argv('samples');
    if (rawSamples === undefined || rawSamples === '') {
      console.error('⛔ 缺少 --samples');
      console.error('   必须提供评估样本数，证明观察期真的跑了任务。');
      process.exit(2);
    }
    const samples = Number(rawSamples);
    if (!Number.isInteger(samples) || samples < GUARD.OBSERVE_MIN_SAMPLES) {
      console.error('⛔ 样本数不足');
      console.error('   要求 >= ' + GUARD.OBSERVE_MIN_SAMPLES + '，收到: ' + rawSamples);
      console.error('   样本太少时指标不可信，拒绝回填。');
      process.exit(2);
    }

    // ③ 由指标自动判定结果（不再接受人工字符串）
    let result;
    if (sealedDelta <= -GUARD.DEGRADE_THRESHOLD) {
      result = RESULT.DEGRADED;
    } else if (sealedDelta >= GUARD.DEGRADE_THRESHOLD) {
      result = RESULT.IMPROVED;
    } else {
      result = RESULT.STABLE;
    }

    rec.result = result;
    rec.observedAt = new Date().toISOString();
    // 绑定证据（可追溯，不可事后篡改而不留痕）
    rec.sealedDelta = sealedDelta;
    rec.samples = samples;
    rec.evidence = {
      sealedDelta,
      samples,
      threshold: GUARD.DEGRADE_THRESHOLD,
      decidedBy: 'DEGRADE_THRESHOLD（自动判定，非人工指定）',
      at: rec.observedAt,
    };

    // 安全阀：检查是否该冻结
    const fz = shouldFreeze(ledger, rec.scene);
    saveLedger(dataRoot, ledger);

    console.log('已回填: ' + id);
    console.log('  封存集变化: ' + (sealedDelta >= 0 ? '+' : '') + sealedDelta);
    console.log('  样本数: ' + samples + '（要求 >= ' + GUARD.OBSERVE_MIN_SAMPLES + '）');
    console.log('  自动判定: ' + result + '（阈值 ±' + GUARD.DEGRADE_THRESHOLD + '）');
    console.log();

    if (fz.should) {
      // 自动冻结
      ledger.frozen[rec.scene] = {
        at: new Date().toISOString(),
        reason: '连续 ' + fz.consecutive + ' 次进化导致退化',
      };
      saveLedger(dataRoot, ledger);
      console.log();
      console.log('🧊 自动冻结场景「' + rec.scene + '」');
      console.log('   原因：连续 ' + fz.consecutive + ' 次退化（阈值 ' + fz.needed + '）');
      console.log('   该场景的 L2/L3 进化已停止，需要人工介入。');
    } else if (result === RESULT.DEGRADED) {
      console.log('  ⚠ 已记录退化（连续 ' + fz.consecutive + ' / ' + fz.needed + '，达到将自动冻结）');
    }
    process.exit(0);
  }

  // ── 列出冻结 ──
  if (has('frozen')) {
    console.log('═'.repeat(66));
    console.log('  被冻结的场景');
    console.log('═'.repeat(66));
    console.log();
    const entries = Object.entries(ledger.frozen);
    if (!entries.length) {
      console.log('  （无）');
    } else {
      for (const [scene, info] of entries) {
        console.log('  🧊 ' + scene);
        console.log('     原因: ' + info.reason);
        console.log('     时间: ' + info.at);
        console.log();
      }
    }
    process.exit(0);
  }

  // ── 解冻 ──
  if (has('unfreeze')) {
    const scene = argv('scene');
    if (!scene || scene === true) { console.error('缺 --scene'); process.exit(2); }
    if (!ledger.frozen[scene]) {
      console.log('场景「' + scene + '」未被冻结');
      process.exit(0);
    }
    delete ledger.frozen[scene];
    saveLedger(dataRoot, ledger);
    console.log('已解冻: ' + scene);
    process.exit(0);
  }

  // ── 用法 ──
  console.log('进化台账');
  console.log();
  console.log('  --list                                              # 列出所有进化');
  console.log('  --record --scene <场景> --level L1|L2|L3 --type memory|skill|identity \\');
  console.log('           --target <文件> --change "改了什么" --trigger "为什么改" \\');
  console.log('           [--backtest \'{"cases":3,"passed":3}\']      # 登记进化');
  console.log('           [--human-confirmed --confirmed-by "宿主"]  # L3 必需');
  console.log('  --observe <id> --result improved|stable|degraded     # 回填观察结果');
  console.log('  --frozen                                            # 列出冻结');
  console.log('  --unfreeze --scene <场景>                           # 解冻');
}
