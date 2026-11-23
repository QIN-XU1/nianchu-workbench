#!/usr/bin/env node
/**
 * 进度判定 —— 中枢的 progress 决策点
 *
 * ══════════════════════════════════════════════════════════════
 *  依据 方案/121 调研（Magentic-One 内层循环）
 * ══════════════════════════════════════════════════════════════
 *
 *  Magentic-One 论文 §1 原文：
 *    orchestrator 每轮回答五问：
 *
 *     ① satisfied    任务完成了吗
 *     ② in_loop      是不是在打转（重复同一动作）
 *     ③ progressing  有进展吗
 *     ④ next_actor   下一个该谁做
 *     ⑤ next_action  给它什么指令
 *
 *  卡住计数超阈值（AutoGen 实现 max_stalls=3）就：
 *    退出内层 → 反思根因 → 更新 facts 和 plan → 重排
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么必须做成本地工具而不是 prompt
 * ══════════════════════════════════════════════════════════════
 *
 *  调研 §5.3 指出：写了反而有害的内容包括「完整流程步骤长 prose」。
 *  Claude Code 的结论：必须每次都发生的事做成 hook/deny rule，
 *  不要写成 prompt 文字。
 *
 *  「是否在打转」这种判断，机器算比 LLM 猜准得多：
 *    · 派单台账里有状态历史和时间戳
 *    · 同一 subject 反复派 = 明显打转
 *    · 状态长期不变 = 卡住
 *
 * ══════════════════════════════════════════════════════════════
 *  五问怎么算（全本地，不调 LLM）
 * ══════════════════════════════════════════════════════════════
 *
 *  ① satisfied     所有派单 state ∈ {closed, cancelled} 
 *                  且没有 pending 的 → true
 *  ② in_loop       同一 target+subject 出现过 >= 2 次
 *                  或状态连续 N 次检查无变化
 *  ③ progressing   最近一次状态变更距离现在 < 阈值
 *  ④ next_actor    有 unacked → 该场景；有 created → 需投递
 *  ⑤ next_action   具体的下一步命令
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/进度判定.mjs                    判定当前所有在途派单
 *  node 工具/进度判定.mjs --id d-xxx         只判一条
 *  node 工具/进度判定.mjs --json             严格 JSON 输出（机制体检用这个）
 *  node 工具/进度判定.mjs --ledger X.json    换一份台账（造破坏验证用）
 *  node 工具/进度判定.mjs --selftest         自测（含反例）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sceneIds as _sceneIds, sceneNames as _sceneNames } from './_场景清单.mjs';

/** 全部场景 id / 中文名（从 scenarios/*.json 动态读，唯一权威） */
const ALL_IDS = _sceneIds();
const ALL_NAMES = _sceneNames();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA_ROOT = path.join(WB, '数据', '.dsh');
const LEDGER = path.join(DATA_ROOT, '场景记忆', '_共享记忆', '派单台账.json');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// ══════════════════════════════════════════════════════════════
//  阈值（写死，可测）
// ══════════════════════════════════════════════════════════════
export const THRESHOLDS = {
  /** 同一 target+subject 出现这个次数 → 判为打转 */
  LOOP_REPEAT: 2,
  /** 状态超过这么多小时没变化 → 判为停滞 */
  STALL_HOURS: 24,
  /** 连续多少次检查判为打转 → 触发重规划（对齐 AutoGen max_stalls） */
  MAX_STALLS: 3,
};

function readJsonSafe(p) {
  try {
    const s = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function loadLedger(override) {
  const j = readJsonSafe(override || LEDGER);
  return j || { dispatches: [] };
}

/** 有效状态（含超时推导，与派单工具一致） */
export function effectiveState(d, now) {
  const t = now || Date.now();
  if (d.state === 'delivered') {
    const deadline = d.deadline ? new Date(d.deadline).getTime() : null;
    if (deadline && t > deadline) return 'unacked';
  }
  return d.state || 'created';
}

// 终态集合
//
// ⚠ 2026-11-10 修正（真实数据抓到的）：原来只有 closed/cancelled/rejected，
//    漏了 acked —— 已回执的派单被算成「在途」，
//    进度判定报「还有 10 条在途」，实际只有 7 条。
//
//  语义：
//    acked    = 场景已回执，中枢待验收（算「等中枢动作」，不是「等场景」）
//    verified = 中枢已验收，等销账
//    closed   = 已销账（终态）
//    cancelled/rejected = 作废（终态）
//
//  所以：acked 不算「在途」（场景已经完成了它的部分），
//       但也不算「已完全结束」—— 需要中枢验收。
const TERMINAL = new Set(['closed', 'cancelled', 'rejected']);
/** 场景侧已完成（不含中枢验收） */
const SCENE_DONE = new Set(['acked', 'verified']);

/**
 * 五问判定
 *
 * @param {Array} dispatches 台账里的派单
 * @param {Object} opts { now, thresholds }
 * @returns { satisfied, in_loop, progressing, next_actor, next_action, reasons }
 */
export function judgeProgress(dispatches, opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const th = o.thresholds || THRESHOLDS;
  const list = Array.isArray(dispatches) ? dispatches : [];

  // 只看「场景侧还没完成」的（acked 之后是中枢的活，不再算在途）
  const active = list.filter((d) => {
    const st = effectiveState(d, now);
    return !TERMINAL.has(st) && !SCENE_DONE.has(st);
  });

  // 等中枢验收的（acked）
  const awaitingVerify = list.filter((d) => SCENE_DONE.has(effectiveState(d, now)) && !TERMINAL.has(effectiveState(d, now)));

  const reasons = {};

  // ═══ ① satisfied ═══
  //   完成 = 没有在途 且 没有待验收
  const satisfied = active.length === 0 && awaitingVerify.length === 0;
  reasons.satisfied = satisfied
    ? '没有在途派单（全部已关闭/取消/验收）'
    : (active.length > 0
      ? '还有 ' + active.length + ' 条在途：' + active.map((d) => d.id).join(',')
      : '有 ' + awaitingVerify.length + ' 条待验收：' + awaitingVerify.map((d) => d.id).join(','));

  // ═══ ② in_loop（打转判定）═══
  //   规则：同一 target+subject 出现 >= LOOP_REPEAT 次
  //
  // ⚠ 2026-11-12 修（判据错误：把历史记录当成了当前失败）
  //
  //   原判据：`for (const d of list)` —— 把台账里**所有**派单都算进重复计数，
  //          包括 closed / cancelled 的历史单。
  //
  //   错在哪（实测）：台账里 7 条「架构梳理 → 闭环验证-完整四件套」全是
  //          cancelled 的历史遗留（2026-11-10 那几轮调试），
  //          于是 in_loop 恒为 true，进度判定永远报「在打转 ×7」，
  //          而这个信号跟当前有没有在途任务毫无关系。
  //          这正是「历史记录当当前失败」——检查永远红，代码没问题。
  //
  //   改成：只统计「场景侧还没完成」的派单（与上面 active 同一集合）。
  //        打转的语义是「**现在**还在重复同一个动作」，已关闭/已作废的不算。
  //        反例保留在自测里：两条 closed 的历史重复不得判 in_loop。
  const keyCount = {};
  for (const d of active) {
    const k = String(d.to || '') + '|' + String(d.subject || '');
    keyCount[k] = (keyCount[k] || 0) + 1;
  }
  const loopKeys = Object.entries(keyCount).filter(([, n]) => n >= th.LOOP_REPEAT);
  const in_loop = loopKeys.length > 0;
  reasons.in_loop = in_loop
    ? '重复派单：' + loopKeys.map(([k, n]) => k.replace('|', ' → ') + '×' + n).join('; ')
    : '没有重复派单';

  // ═══ ③ progressing（进展判定）═══
  //   规则：最近一次状态变更距现在 < STALL_HOURS
  let lastChange = 0;
  for (const d of active) {
    for (const f of ['deliveredAt', 'ackedAt', 'createdAt']) {
      const t = d[f] ? new Date(d[f]).getTime() : 0;
      if (t > lastChange) lastChange = t;
    }
  }
  const stallMs = th.STALL_HOURS * 3600 * 1000;
  let progressing = false;
  if (active.length === 0) {
    progressing = true;   // 没在途 = 不算停滞
    reasons.progressing = '没有在途任务';
  } else if (lastChange === 0) {
    progressing = false;
    reasons.progressing = '在途任务从未有过状态变更记录';
  } else {
    const age = now - lastChange;
    progressing = age < stallMs;
    const hours = (age / 3600000).toFixed(1);
    reasons.progressing = progressing
      ? '最近 ' + hours + ' 小时内有状态变更'
      : '已 ' + hours + ' 小时无状态变更（阈值 ' + th.STALL_HOURS + '）';
  }

  // 停滞 → 算作打转的一种（Magentic-One 的 stalled 概念）
  const stalled = !progressing && active.length > 0;
  if (stalled) {
    reasons.in_loop = (reasons.in_loop === '没有重复派单' ? '' : reasons.in_loop + '；') +
      '状态停滞：' + reasons.progressing;
  }

  // ═══ ④ next_actor ═══
  //   优先级：待验收（中枢的活）> created（中枢投递）> unacked（催场景）> delivered（等场景）
  let next_actor = null;
  let next_scene = null;

  const created = active.filter((d) => effectiveState(d, now) === 'created');
  const unacked = active.filter((d) => effectiveState(d, now) === 'unacked');
  const delivered = active.filter((d) => effectiveState(d, now) === 'delivered');

  if (awaitingVerify.length > 0) {
    // 场景已回执，等中枢验收销账
    next_actor = 'hub';
    next_scene = awaitingVerify[0].to;
  } else if (created.length > 0) {
    next_actor = 'hub';
    next_scene = created[0].to;
  } else if (unacked.length > 0) {
    next_actor = unacked[0].to;
    next_scene = unacked[0].to;
  } else if (delivered.length > 0) {
    next_actor = delivered[0].to;
    next_scene = delivered[0].to;
  }
  reasons.next_actor = next_actor
    ? (awaitingVerify.length > 0 ? '有 ' + awaitingVerify.length + ' 条已回执，待中枢验收销账'
      : created.length > 0 ? '有 ' + created.length + ' 条未投递，需中枢投递'
        : unacked.length > 0 ? '有 ' + unacked.length + ' 条超时未回执'
          : '等 ' + delivered[0].to + ' 回执')
    : '无待办';

  // ═══ ⑤ next_action（具体命令）═══
  let next_action = '';
  if (awaitingVerify.length > 0) {
    next_action = '验收并销账：node 工具/派单.mjs --close --id ' + awaitingVerify[0].id;
  } else if (created.length > 0) {
    next_action = 'node 工具/派单.mjs --deliver --id ' + created[0].id;
  } else if (unacked.length > 0) {
    next_action = '催办或改派：node 工具/派单.mjs --pending 查看；必要时 --announce 提醒 ' + unacked[0].to;
  } else if (delivered.length > 0) {
    next_action = '等待 ' + delivered[0].to + ' 回执；超时可重派（引用旧 id）';
  } else {
    next_action = '无（全部完成）';
  }
  reasons.next_action = next_action;

  return {
    satisfied,
    in_loop: in_loop || stalled,
    progressing,
    next_actor,
    next_scene,
    next_action,
    stalled,
    activeCount: active.length,
    awaitingVerifyCount: awaitingVerify.length,
    reasons,
  };
}

/**
 * 严格 JSON 输出 + 校验（对齐调研 §8.1 的 progress 段要求）
 */
export function progressJson(dispatches, opts) {
  const p = judgeProgress(dispatches, opts);
  return {
    satisfied: p.satisfied,
    in_loop: p.in_loop,
    progressing: p.progressing,
    next_actor: p.next_actor,
    next_action: p.next_action,
    reason: {
      satisfied: p.reasons.satisfied,
      in_loop: p.reasons.in_loop,
      progressing: p.reasons.progressing,
      next_actor: p.reasons.next_actor,
    },
  };
}

/**
 * 校验 progress JSON
 *
 * 五问每一项都必须有值且有 reason（调研要求「每项带 reason」）
 *
 * ⚠ 2026-11-10 修正（真实数据抓到的）：
 *   派单台账里的 `to` 存的是中文场景名（如「架构梳理」），
 *   而场景 id 是英文（arch-review）。原来只认英文 id → 校验失败。
 *   现在两者都认。
 */
export function validateProgressJson(obj, sceneIds) {
  const errs = [];
  // ⚠ 2026-11-14 改：不再硬编码场景清单
  //
  //   原来 ids 和 names 各写死 9 个，新增 3 个工坊后没更新
  //   → 判进度时把「工具工坊」这类新场景当成未知场景。
  //
  //   唯一权威是 外壳/scenarios/*.json。
  const ids = sceneIds || ALL_IDS;
  const names = ALL_NAMES;
  const known = new Set([...ids, ...names]);

  if (typeof obj !== 'object' || obj === null) return ['progress 结果必须是对象'];

  for (const k of ['satisfied', 'in_loop', 'progressing']) {
    if (typeof obj[k] !== 'boolean') errs.push(k + ' 必须是布尔');
  }

  if (!('next_actor' in obj)) {
    errs.push('缺 next_actor 字段');
  } else if (obj.next_actor !== null && !known.has(obj.next_actor)) {
    errs.push('next_actor 不在已知场景内：' + String(obj.next_actor) +
      '（允许英文 id 或中文名）');
  }

  if (typeof obj.next_action !== 'string') errs.push('next_action 必须是字符串');

  if (!obj.reason || typeof obj.reason !== 'object') {
    errs.push('缺 reason 对象（五个判定都必须给理由）');
  } else {
    for (const k of ['satisfied', 'in_loop', 'progressing', 'next_actor']) {
      if (!obj.reason[k] || String(obj.reason[k]).trim() === '') {
        errs.push('reason.' + k + ' 不能为空');
      }
    }
  }

  // 一致性：完成时不该还要派活
  if (obj.satisfied === true && obj.next_actor !== null) {
    errs.push('satisfied 却还有 next_actor，矛盾');
  }

  return errs;
}

// ══════════════════════════════════════════════════════════════
//  自测（含反例）
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  进度判定 · 自测');
  console.log('═'.repeat(72));
  console.log();

  const now = Date.now();
  const H = 3600000;

  // ① 全部完成 → satisfied
  const done = [
    { id: 'd1', to: 'arch-review', state: 'closed', createdAt: new Date(now - 10 * H).toISOString(), deliveredAt: new Date(now - 9 * H).toISOString(), ackedAt: new Date(now - 8 * H).toISOString() },
  ];
  const p1 = judgeProgress(done, { now });
  chk('全部 closed → satisfied', p1.satisfied === true, String(p1.satisfied));
  chk('全部完成时 next_actor 为 null', p1.next_actor === null, String(p1.next_actor));

  // ② 有未投递 → next_actor 应该是 hub
  const created = [
    { id: 'd2', to: 'arch-review', state: 'created', createdAt: new Date(now - 1 * H).toISOString() },
  ];
  const p2 = judgeProgress(created, { now });
  chk('未投递 → satisfied=false', p2.satisfied === false, '');
  chk('未投递 → next_actor=hub', p2.next_actor === 'hub', String(p2.next_actor));
  chk('未投递 → next_action 含 --deliver', p2.next_action.includes('--deliver'), p2.next_action.slice(0, 50));

  // ③ 已投递未回执且超时 → unacked → next_actor 是场景
  const unacked = [
    { id: 'd3', to: 'build-plan', state: 'delivered', createdAt: new Date(now - 30 * H).toISOString(), deliveredAt: new Date(now - 29 * H).toISOString(), deadline: new Date(now - 5 * H).toISOString() },
  ];
  const p3 = judgeProgress(unacked, { now });
  chk('超时未回执 → next_actor=场景', p3.next_actor === 'build-plan', String(p3.next_actor));

  // ④ 打转判定：同一 target+subject 在**在途**里重复
  //
  //  ⚠ 2026-11-12 修：原用例用的是两条 closed 的单子，
  //    那是按「历史记录也算重复」的旧判据写的。
  //    判据已改为只看在途（见 judgeProgress ②），
  //    所以这里必须换成真的在途单，否则用例测的不是新判据。
  const loop = [
    { id: 'd4', to: 'research', subject: '搜资料', state: 'delivered', createdAt: new Date(now - 3 * H).toISOString(), deliveredAt: new Date(now - 2 * H).toISOString(), deadline: new Date(now + 24 * H).toISOString() },
    { id: 'd5', to: 'research', subject: '搜资料', state: 'delivered', createdAt: new Date(now - 2 * H).toISOString(), deliveredAt: new Date(now - 1 * H).toISOString(), deadline: new Date(now + 24 * H).toISOString() },
  ];
  const p4 = judgeProgress(loop, { now });
  chk('在途重复派单 → in_loop=true', p4.in_loop === true, p4.reasons.in_loop.slice(0, 50));

  // ④b 关键反例：历史（closed/cancelled）里的重复不得判打转
  //
  //  这是 2026-11-12 修掉的真实缺陷：台账里 7 条 cancelled 的
  //  「架构梳理 → 闭环验证-完整四件套」让 in_loop 恒为 true。
  const histLoop = [
    { id: 'h1', to: '架构梳理', subject: '闭环验证-完整四件套', state: 'closed', createdAt: new Date(now - 40 * H).toISOString(), ackedAt: new Date(now - 39 * H).toISOString() },
    { id: 'h2', to: '架构梳理', subject: '闭环验证-完整四件套', state: 'cancelled', createdAt: new Date(now - 39 * H).toISOString() },
    { id: 'h3', to: '架构梳理', subject: '闭环验证-完整四件套', state: 'cancelled', createdAt: new Date(now - 38 * H).toISOString() },
  ];
  const p4b = judgeProgress(histLoop, { now });
  chk('反例：历史重复不得判打转', p4b.in_loop === false,
      'closed/cancelled 各重复，in_loop=' + p4b.in_loop);

  // ⑤ 反例：在途但不重复，不得判打转
  const noLoop = [
    { id: 'd6', to: 'research', subject: '搜资料A', state: 'delivered', createdAt: new Date(now - 2 * H).toISOString(), deliveredAt: new Date(now - 1 * H).toISOString(), deadline: new Date(now + 24 * H).toISOString() },
    { id: 'd7', to: 'arch-review', subject: '架构A', state: 'delivered', createdAt: new Date(now - 2 * H).toISOString(), deliveredAt: new Date(now - 1 * H).toISOString(), deadline: new Date(now + 24 * H).toISOString() },
  ];
  const p5 = judgeProgress(noLoop, { now });
  chk('反例：不重复不得判打转', p5.in_loop === false, String(p5.in_loop));

  // ⑥b acked 不该算「在途」（真实数据抓到的缺陷）
  const acked = [
    { id: 'd9', to: 'arch-review', state: 'acked', createdAt: new Date(now - 10 * H).toISOString(), deliveredAt: new Date(now - 9 * H).toISOString(), ackedAt: new Date(now - 8 * H).toISOString(), receipt: '产物路径 xxx' },
  ];
  const p6b = judgeProgress(acked, { now });
  chk('acked 不算在途', p6b.activeCount === 0, 'activeCount=' + p6b.activeCount);
  chk('acked 算待验收', p6b.awaitingVerifyCount === 1, 'awaitingVerify=' + p6b.awaitingVerifyCount);
  chk('acked 时 next_actor=hub', p6b.next_actor === 'hub', String(p6b.next_actor));
  chk('acked 时 next_action 是 close', p6b.next_action.includes('--close'), p6b.next_action.slice(0, 40));
  chk('acked 未销账时 satisfied=false', p6b.satisfied === false, String(p6b.satisfied));

  // ⑥c acked + closed 才算全部完成
  const allDone = [
    { id: 'd10', to: 'arch-review', state: 'closed', createdAt: new Date(now - 10 * H).toISOString(), deliveredAt: new Date(now - 9 * H).toISOString(), ackedAt: new Date(now - 8 * H).toISOString(), receipt: '产物路径 xxx' },
  ];
  const p6c = judgeProgress(allDone, { now });
  chk('全部 closed 时 satisfied=true', p6c.satisfied === true,
      'active=' + p6c.activeCount + ' awaiting=' + p6c.awaitingVerifyCount);

  // ⑥ 停滞判定：在途但很久没变
  const stalled = [
    { id: 'd8', to: 'pc-cleanup', subject: '清理', state: 'delivered', createdAt: new Date(now - 100 * H).toISOString(), deliveredAt: new Date(now - 99 * H).toISOString(), deadline: new Date(now + 24 * H).toISOString() },
  ];
  const p6 = judgeProgress(stalled, { now });
  chk('长期无变化 → progressing=false', p6.progressing === false, p6.reasons.progressing.slice(0, 40));
  chk('停滞也算 in_loop', p6.in_loop === true, String(p6.in_loop));

  // ⑦ 严格 JSON
  const j1 = progressJson(done, { now });
  chk('progressJson 通过校验', validateProgressJson(j1).length === 0, validateProgressJson(j1).join(';'));

  // ⑧ 反例：缺 reason 必须被拒
  const bad1 = { ...j1, reason: {} };
  chk('反例：缺 reason 必须被拒', validateProgressJson(bad1).length > 0, validateProgressJson(bad1)[0] || '');

  // ⑨ 反例：非法 next_actor 必须被拒
  const bad2 = { ...j1, satisfied: false, next_actor: '不存在的场景' };
  chk('反例：非法 next_actor 必须被拒', validateProgressJson(bad2).length > 0, validateProgressJson(bad2)[0] || '');

  // ⑩ 反例：satisfied 却有 next_actor
  const bad3 = { ...j1, satisfied: true, next_actor: 'arch-review' };
  chk('反例：satisfied 却有 next_actor 必须被拒', validateProgressJson(bad3).length > 0, validateProgressJson(bad3)[0] || '');

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
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  // --ledger：换一份台账（造破坏验证 / 试算用，不碰真实台账）
  //
  //  ⚠ 2026-11-12 加：机制体检要先把「造破坏会失败」验证过才算过关。
  //     没有入口就无法在不改真实数据的前提下验证判据。
  const ledger = loadLedger(val('--ledger'));
  let list = ledger.dispatches || [];

  if (has('--id')) {
    const id = val('--id');
    list = list.filter((d) => d.id === id);
    if (list.length === 0) { console.error('找不到: ' + id); process.exit(2); }
  }

  // ── 严格 JSON ──
  if (has('--json')) {
    const obj = progressJson(list);
    const errs = validateProgressJson(obj);
    if (errs.length > 0) {
      console.error(JSON.stringify({ ok: false, errors: errs }, null, 2));
      process.exit(2);
    }
    console.log(JSON.stringify(obj, null, 2));
    process.exit(obj.satisfied ? 0 : 1);
  }

  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-12 加 --check（机制体检用这个，**不要用 --json**）
  //
  //    为什么 --json 不适合当体检项：
  //      它的退出码是 `satisfied ? 0 : 1`。
  //      只要台账里有**任何一张在途派单**，satisfied=false → exit 1。
  //      但「有派单正在跑」是**正常业务状态**，不是失败。
  //      拿它当体检项 = 系统一干活就报红，是典型的
  //      「把环境/运行状态当判据」。
  //
  //    真正该报红的是这两种：
  //      ① 打转：同一 target+subject 在在途里重复出现
  //      ② 停滞：在途任务超过 STALL_HOURS 没有任何状态变更
  //      这两条才对应 Magentic-One 里「该退出内层、反思重排」的信号。
  //
  //    --check 判据：
  //      · 有打转 → exit 1
  //      · 有停滞 → exit 1
  //      · 只是有在途任务、但都在正常推进 → exit 0（这是健康状态）
  //    「有在途」只报告，不参与判定。
  // ══════════════════════════════════════════════════════════════
  if (has('--check')) {
    const p = judgeProgress(list);
    const problems = [];

    if (p.in_loop) problems.push('打转：' + p.reasons.in_loop);
    if (p.stalled) problems.push('停滞：' + p.reasons.progressing);

    console.log('═'.repeat(72));
    console.log('  进度判定 · 检查（Magentic-One 五问）');
    console.log('═'.repeat(72));
    console.log();
    console.log('  台账条数: ' + list.length + '   在途: ' + p.activeCount +
      '   待验收: ' + p.awaitingVerifyCount + '   （在途只报告，不作判据）');
    console.log('  打转: ' + (p.in_loop ? '⚠ 是' : '✓ 否') + '   停滞: ' + (p.stalled ? '⚠ 是' : '✓ 否'));
    if (p.next_action) console.log('  下一步: ' + p.next_action);
    console.log();

    if (problems.length === 0) {
      console.log('  ✓ 没有打转、没有停滞');
      process.exit(0);
    }
    console.log('  ✗ 检测到需要重排的信号：');
    for (const x of problems) console.log('    · ' + x);
    console.log();
    console.log('    按 Magentic-One：退出内层 → 反思根因 → 更新计划 → 重排');
    process.exit(1);
  }

  // ── 人读 ──
  const p = judgeProgress(list);
  console.log('═'.repeat(72));
  console.log('  进度判定（Magentic-One 五问）');
  console.log('═'.repeat(72));
  console.log();

  const mark = (b) => (b ? '✓' : '✗');
  console.log('  ① 完成了吗      ' + mark(p.satisfied) + '  ' + p.reasons.satisfied);
  console.log('  ② 在打转吗      ' + mark(!p.in_loop) + '  ' + p.reasons.in_loop);
  console.log('  ③ 有进展吗      ' + mark(p.progressing) + '  ' + p.reasons.progressing);
  console.log('  ④ 下一个该谁    ' + (p.next_actor || '无') + '  ' + p.reasons.next_actor);
  console.log('  ⑤ 下一步做什么  ' + p.next_action);
  console.log();
  console.log('─'.repeat(72));
  console.log('  在途派单: ' + p.activeCount + ' 条');
  if (p.stalled) {
    console.log('  ⚠ 检测到停滞（对齐 AutoGen max_stalls=' + THRESHOLDS.MAX_STALLS + '）');
    console.log('    按 Magentic-One：应退出内层 → 反思根因 → 更新计划 → 重排');
  }
  console.log('─'.repeat(72));
  process.exit(p.satisfied || p.progressing ? 0 : 1);
}
