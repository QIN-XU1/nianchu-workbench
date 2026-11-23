#!/usr/bin/env node
/**
 * 进化哨兵 —— 检查进化是否可控
 *
 * ══════════════════════════════════════════════════════════════
 *  不变量
 * ══════════════════════════════════════════════════════════════
 *
 *  INV-1  level-valid       级别必须是 L1/L2/L3
 *  INV-2  l1-append-only    L1 只能操作记忆文件，不能改技能/身份
 *  INV-3  l2-backtested     L2 技能进化必须有回测且全通过
 *  INV-4  l3-confirmed      L3 身份进化必须有人工确认
 *  INV-5  has-changelog     每次进化必须有 change + trigger（可追溯）
 *  INV-6  observed-in-time  进化后观察期结束但未回填结果 → 违规
 *  INV-7  frozen-respected  被冻结的场景不该有新的 L2/L3 进化
 *  INV-8  degraders-rolled-back  标记为 degraded 的进化应该已回滚或说明不滚的理由
 *
 *  核心问题：进化如果没有约束，就不是"进化"而是"漂移"。
 */

import fs from 'node:fs';
import os from 'node:os';   // ⚠ 2026-11-12 补：自测在临时目录造反例，不碰真实台账
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');

export const LEVEL = { L1: 'L1', L2: 'L2', L3: 'L3' };
export const GUARD = {
  OBSERVE_TASKS: 3,
  MAX_CONSECUTIVE_DEGRADE: 2,
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
 *   opt.dataRoot   .dsh 目录
 *   opt.nowMs      当前时间
 */
export function check(opt) {
  const dataRoot = opt.dataRoot || path.join(WB, '数据', '.dsh');
  const nowMs = opt.nowMs || Date.now();
  const diffs = [];
  const ID = 'evolution-guard';
  const stats = { total: 0, byLevel: {}, pending: 0, degraded: 0, frozen: 0 };

  const file = path.join(dataRoot, '场景记忆', '_共享记忆', '进化台账.json');
  if (!fs.existsSync(file)) {
    return { id: ID, diffs, stats: Object.assign(stats, { empty: true }) };
  }

  const ledger = readJson(file, null);
  if (!ledger) {
    diffs.push('进化台账 JSON 解析失败');
    return { id: ID, diffs, stats };
  }

  const evolutions = Array.isArray(ledger.evolutions) ? ledger.evolutions : [];
  const frozen = ledger.frozen || {};
  stats.total = evolutions.length;
  stats.frozen = Object.keys(frozen).length;

  const seenIds = new Set();

  for (const e of evolutions) {
    const tag = e.id || '(无 id)';

    stats.byLevel[e.level] = (stats.byLevel[e.level] || 0) + 1;
    if (e.result === 'pending') stats.pending++;
    if (e.result === 'degraded') stats.degraded++;

    // ── INV-1 级别合法 ──
    if (!Object.values(LEVEL).includes(e.level)) {
      diffs.push('进化 ' + tag + ' 级别不合法：' + e.level);
      continue;
    }

    // ── id 唯一 ──
    if (e.id) {
      if (seenIds.has(e.id)) diffs.push('进化 id 重复：' + tag);
      seenIds.add(e.id);
    }

    // ── INV-5 可追溯 ──
    if (!e.change || String(e.change).trim().length < 5) {
      diffs.push('进化 ' + tag + ' 缺 change（改了什么，无法追溯）');
    }
    if (!e.trigger || String(e.trigger).trim().length < 5) {
      diffs.push('进化 ' + tag + ' 缺 trigger（为什么改，无法追溯）');
    }

    // ── INV-2 L1 只能改记忆 ──
    if (e.level === LEVEL.L1) {
      if (e.type !== 'memory') {
        diffs.push('L1 进化的类型必须是 memory，实际 ' + e.type + '（L1 只能追加记忆）');
      }
      const t = String(e.target || '').replace(/\\/g, '/');
      const isMemory = /场景记忆\//.test(t) || /\.md$/.test(t);
      if (!isMemory) {
        diffs.push('L1 进化的 target 必须是记忆文件，实际 ' + e.target);
      }
    }

    // ── INV-3 L2 必须回测通过 ──
    if (e.level === LEVEL.L2) {
      if (!e.backtest) {
        diffs.push('L2 进化 ' + tag + ' 缺 backtest（技能改造必须有回测）');
      } else {
        const cases = Number(e.backtest.cases);
        const passed = Number(e.backtest.passed);
        if (!Number.isFinite(cases) || cases < 1) {
          diffs.push('L2 进化 ' + tag + ' 回测用例数不合法：' + e.backtest.cases);
        } else if (passed < cases) {
          diffs.push('L2 进化 ' + tag + ' 回测未全通过（' + passed + '/' + cases + '）');
        }
      }
    }

    // ── INV-4 L3 必须人工确认 ──
    if (e.level === LEVEL.L3) {
      if (!e.humanConfirmed) {
        diffs.push('L3 进化 ' + tag + ' 没有人工确认（身份卡定义"我是谁"，改错全跑偏）');
      }
      if (!e.confirmedBy || String(e.confirmedBy).trim().length < 2) {
        diffs.push('L3 进化 ' + tag + ' 没有记录确认人');
      }
    }

    // ── INV-6 观察期结束但未回填 ──
    if (e.result === 'pending' && e.observeUntil) {
      const until = new Date(e.observeUntil + 'T23:59:59Z').getTime();
      if (Number.isFinite(until) && nowMs > until) {
        diffs.push(
          '进化 ' + tag + ' 观察期已结束（' + e.observeUntil + '）但结果仍是 pending' +
          '（观察不到结果 = 不知道进化有没有用）'
        );
      }
    }

    // ── INV-7 冻结场景不该有新进化 ──
    if (frozen[e.scene] && e.level !== LEVEL.L1) {
      const frozenAt = new Date(frozen[e.scene].at || 0).getTime();
      const evoAt = new Date(e.at || 0).getTime();
      if (Number.isFinite(frozenAt) && Number.isFinite(evoAt) && evoAt > frozenAt) {
        diffs.push(
          '进化 ' + tag + ' 发生在场景「' + e.scene + '」被冻结之后' +
          '（冻结的场景不允许 L2/L3 进化）'
        );
      }
    }

    // ── INV-8 degraded 应该回滚 ──
    if (e.result === 'degraded' && !e.rolledBack) {
      const hasReason = e.noRollbackReason && String(e.noRollbackReason).trim().length >= 5;
      if (!hasReason) {
        diffs.push(
          '进化 ' + tag + ' 标记为 degraded（退化）但未回滚，也没有说明理由' +
          '（"进化导致退化还不回滚" = 反向优化）'
        );
      }
    }
  }

  return { id: ID, diffs, stats };
}

// ══════════════════════════════════════════════════════════════
//  自测（含应当失败的反例）
//
//  ⚠ 2026-11-12 补：原来没有 selftest、没有反例，机制审计判它
//    「①4 反例 0 处 · ①5 无自测入口」= 口号。
//
//    为什么必须补：进化哨兵守的是「进化不能变成漂移」。
//    如果它的 8 条判据里有任何一条写错了（字段名、方向、边界），
//    那么一次**该被拦下的身份进化（L3）**就会被放行 ——
//    而身份卡改错 = 整个场景跑偏，这是最贵的一类事故。
//    证明它会失败，比证明它会通过重要得多。
//
//    下面每条反例都是**真造一条不合法进化记录**写进临时台账，
//    再用真实 check() 读回来，断言它必须被点名。
// ══════════════════════════════════════════════════════════════
export function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  进化哨兵 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ── ① 判据常量（唯一出处在 GUARD / LEVEL，别被顺手放宽）──
  chk('级别只允许 L1/L2/L3', Object.values(LEVEL).join(',') === 'L1,L2,L3',
      Object.values(LEVEL).join(','));
  chk('观察期样本 = 3', GUARD.OBSERVE_TASKS === 3, String(GUARD.OBSERVE_TASKS));
  chk('连续退化上限 = 2', GUARD.MAX_CONSECUTIVE_DEGRADE === 2, String(GUARD.MAX_CONSECUTIVE_DEGRADE));

  const NOW = Date.parse('2026-11-12T12:00:00Z');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evoguard-'));
  const shared = path.join(tmp, '场景记忆', '_共享记忆');
  fs.mkdirSync(shared, { recursive: true });
  const ledgerFile = path.join(shared, '进化台账.json');

  // 一条「完全合法」的 L3 进化：有 change/trigger/人工确认/确认人
  function goodEvolution(over) {
    return Object.assign({
      id: 'e-001',
      level: 'L3',
      scene: 'demo',
      type: 'identity',
      target: '场景记忆/demo/身份卡.md',
      change: '把职责边界写清楚：不碰前端样式',
      trigger: '连续两次把样式问题揽到自己身上',
      humanConfirmed: true,
      confirmedBy: '用户',
      at: '2026-11-01',
      result: 'kept',
    }, over || {});
  }

  function run(evolutions, frozen) {
    fs.writeFileSync(ledgerFile, JSON.stringify({
      evolutions: evolutions || [],
      frozen: frozen || {},
    }, null, 2), 'utf8');
    return check({ dataRoot: tmp, nowMs: NOW });
  }

  // ── ② 正例：合规进化必须 PASS ──
  {
    const r = run([goodEvolution()]);
    chk('正例：合规 L3 进化通过（差异集合 = 0）', r.diffs.length === 0,
        r.diffs.slice(0, 2).join('; '));
  }

  // ── ③ 反例 1：级别不合法（写成 L4）→ 必须报 ──
  {
    const r = run([goodEvolution({ level: 'L4' })]);
    chk('反例：级别写成 L4 应当失败', !(r.diffs.length === 0),
        r.diffs[0] || '⚠ 没报，说明 INV-1 判据失效');
  }

  // ── ④ 反例 2：L3 身份进化没有人工确认 → 必须报 ──
  //    这条最关键：身份卡定义「我是谁」，未经确认就改 = 漂移
  {
    const r = run([goodEvolution({ humanConfirmed: false })]);
    const hit = r.diffs.some(x => x.includes('人工确认'));
    chk('反例：L3 没有人工确认应当失败', hit,
        hit ? r.diffs.find(x => x.includes('人工确认'))
            : '⚠ 没报，说明 INV-4 判据失效；实际: ' + (r.diffs[0] || '(空)'));
  }

  // ── ⑤ 反例 3：L2 技能进化回测未全通过 → 必须报 ──
  {
    const r = run([goodEvolution({
      level: 'L2', type: 'skill', target: 'skills/x/SKILL.md',
      backtest: { cases: 8, passed: 5 },
    })]);
    const hit = r.diffs.some(x => x.includes('回测'));
    chk('反例：L2 回测 5/8 应当失败', hit,
        hit ? r.diffs.find(x => x.includes('回测'))
            : '⚠ 没报，说明 INV-3 判据失效；实际: ' + (r.diffs[0] || '(空)'));
  }

  // ── ⑥ 反例 4：L1 进化去改技能（L1 只能追加记忆）→ 必须报 ──
  {
    const r = run([goodEvolution({
      level: 'L1', type: 'skill', target: 'skills/x/SKILL.md',
    })]);
    const hit = r.diffs.some(x => x.includes('L1'));
    chk('反例：L1 去改技能文件应当失败', hit,
        hit ? r.diffs.find(x => x.includes('L1'))
            : '⚠ 没报，说明 INV-2 判据失效；实际: ' + (r.diffs[0] || '(空)'));
  }

  // ── ⑦ 反例 5：缺 change（改了什么无法追溯）→ 必须报 ──
  {
    const r = run([goodEvolution({ change: '' })]);
    const hit = r.diffs.some(x => x.includes('缺 change'));
    chk('反例：缺 change 应当失败', hit,
        hit ? r.diffs.find(x => x.includes('缺 change'))
            : '⚠ 没报，说明 INV-5 判据失效；实际: ' + (r.diffs[0] || '(空)'));
  }

  // ── ⑧ 反例 6：观察期已过（2026-11-01）但结果仍 pending → 必须报 ──
  {
    const r = run([goodEvolution({ result: 'pending', observeUntil: '2026-11-01' })]);
    const hit = r.diffs.some(x => x.includes('观察期已结束'));
    chk('反例：观察期已过仍 pending 应当失败', hit,
        hit ? r.diffs.find(x => x.includes('观察期已结束'))
            : '⚠ 没报，说明 INV-6 判据失效；实际: ' + (r.diffs[0] || '(空)'));
  }

  // ── ⑨ 反例 7：冻结之后还做 L2 进化 → 必须报 ──
  {
    const r = run(
      [goodEvolution({
        level: 'L2', type: 'skill', target: 'skills/x/SKILL.md',
        backtest: { cases: 3, passed: 3 }, at: '2026-11-05',
      })],
      { demo: { at: '2026-11-01' } },
    );
    const hit = r.diffs.some(x => x.includes('冻结'));
    chk('反例：冻结场景之后做 L2 进化应当失败', hit,
        hit ? r.diffs.find(x => x.includes('冻结'))
            : '⚠ 没报，说明 INV-7 判据失效；实际: ' + (r.diffs[0] || '(空)'));
  }

  // ── ⑩ 反例 8：degraded 却没回滚也没写理由 → 必须报 ──
  {
    const r = run([goodEvolution({ result: 'degraded', rolledBack: false })]);
    const hit = r.diffs.some(x => x.includes('degraded'));
    chk('反例：degraded 未回滚且无理由应当失败', hit,
        hit ? r.diffs.find(x => x.includes('degraded'))
            : '⚠ 没报，说明 INV-8 判据失效；实际: ' + (r.diffs[0] || '(空)'));
  }

  // ── ⑪ 边界：degraded 但写了足够长的理由 → 不该报（合法例外）──
  {
    const r = run([goodEvolution({
      result: 'degraded', rolledBack: false,
      noRollbackReason: '回滚会丢掉已确认的新边界，经人工评估保留',
    })]);
    chk('边界：degraded 有理由时不误报', r.diffs.length === 0,
        r.diffs[0] || '（正确放行）');
  }

  // ── ⑫ 关键：8 条 INV 的反例必须全部被检出 ──
  //    ⚠ 2026-11-12：用显式变量攒结果，不靠数组下标切片
  //      （切片写错会让这条「永远通过」，又是一条新的装饰）
  {
    const hits = {
      级别合法: R[4], 人工确认: R[5], 回测: R[6], L1只能记忆: R[7],
      可追溯change: R[8], 观察期: R[9], 冻结: R[10], 回滚: R[11],
    };
    const all = Object.values(hits).every(v => v === true);
    chk('关键：造出的 8 个违规进化全部被检出（判据不是装饰）', all,
        Object.entries(hits).map(([k, v]) => k + '=' + v).join(' '));
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
  // ⚠ 2026-11-12 补：--selftest 入口（五步法第 5 步）。
  if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);

  const dataRoot = process.env.SEA_DATA_DIR
    ? path.resolve(process.env.SEA_DATA_DIR)
    : path.join(WB, '数据', '.dsh');

  const nowMs = process.env.SEA_NOW
    ? (Number.isFinite(+process.env.SEA_NOW) ? +process.env.SEA_NOW : Date.parse(process.env.SEA_NOW))
    : Date.now();

  const r = check({ dataRoot, nowMs });

  console.log('  进化记录: ' + r.stats.total +
    (r.stats.total ? '（L1=' + (r.stats.byLevel.L1 || 0) +
      ' L2=' + (r.stats.byLevel.L2 || 0) +
      ' L3=' + (r.stats.byLevel.L3 || 0) + '）' : ''));
  if (r.stats.pending) console.log('  待观察: ' + r.stats.pending);
  if (r.stats.degraded) console.log('  已退化: ' + r.stats.degraded);
  if (r.stats.frozen) console.log('  已冻结场景: ' + r.stats.frozen);
  console.log();

  if (r.diffs.length === 0) {
    console.log('PASS ' + r.id + ': 差异集合 = 0');
    process.exit(0);
  } else {
    console.log('FAIL ' + r.id + ': 差异集合 = ' + r.diffs.length + ' 项');
    for (const d of r.diffs) console.log('  - ' + d);
    process.exit(1);
  }
}
