#!/usr/bin/env node
/**
 * 念初 · 记忆分层与大小预算
 *
 * ══ 从哪来的 ═════════════════════════════════════════════════
 * 参照 D:/refs/luanyujia-fresh/总纲.md:28-33「记忆怎么不丢」：
 *   · 每轮注入：全局须知只放「不读就会白干」的铁律，必须极短
 *   · 场景私有：§〇 当前交接 ≤4KB；主文件 ≤25KB
 *   · 项目记忆：一个项目一份 ≤8KB
 *   · 换会话前先写交接 → 跑场景记忆 check，**不过不许换**
 *
 * 我们原来只有「一个记忆库」，**没有任何预算** —— 条目只增不减，
 * 每轮注入还能全塞进去。这不叫记忆，叫垃圾桶。
 * 这里引入三层 + 硬预算 + 换会话闸门。
 *
 * ══ 三层与默认预算（可按需覆盖）═════════════════════════════
 *   core    每次对话必注入的铁律              ≤ 2 KB   （超了必须裁，因为它每轮都花 token）
 *   scene   本场景交接/画像                   ≤ 4 KB
 *   project 单项目记忆                        ≤ 8 KB
 *   misc    其它                              ≤ 8 KB
 *
 * 作用域由 key 前缀决定：core.* / scene.* / project.* / 其余 misc。
 *
 * ══ 诚实边界 ═════════════════════════════════════════════════
 * · 预算按**字符**算，不是精确 token（精确要引分词器，代价不成比例）。
 * · 裁剪是**按最近更新时间保留**，不是按重要性打分 —— 打分需要模型，这里刻意不用。
 * · 裁剪**不删除**记忆，只把它移出「注入集」（还是能检索到），避免误删信息。
 */

import { load as memLoad, save as memSave, effectiveState } from '../memory/store.mjs';

export const SCOPES = {
  core: { cap: 2 * 1024, desc: '每次注入的铁律' },
  scene: { cap: 4 * 1024, desc: '本场景交接/画像' },
  project: { cap: 8 * 1024, desc: '单项目记忆' },
  misc: { cap: 8 * 1024, desc: '其它' },
};

/** key → 作用域 */
export function scopeOf(key) {
  const k = String(key || '');
  if (k.startsWith('core.')) return 'core';
  if (k.startsWith('scene.')) return 'scene';
  if (k.startsWith('project.')) return 'project';
  return 'misc';
}

function entriesOf(db) {
  return Array.isArray(db && db.entries) ? db.entries : [];
}

/** 某作用域当前占用（只算仍然有效的条目） */
export function usageOf(db, scope, now = new Date()) {
  let chars = 0;
  const rows = [];
  for (const e of entriesOf(db)) {
    if (scopeOf(e.key) !== scope) continue;
    if (effectiveState(e, now) !== 'fresh') continue;
    const size = String(e.key || '').length + String(e.value || '').length;
    chars += size;
    rows.push({ key: e.key, size, updatedAt: e.updatedAt || e.createdAt || '' });
  }
  rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { scope, chars, cap: SCOPES[scope].cap, rows, over: chars > SCOPES[scope].cap };
}

/** 所有作用域的占用概览 */
export function usageAll(db, now = new Date()) {
  const d = db || memLoad();
  return Object.keys(SCOPES).map((s) => usageOf(d, s, now));
}

/**
 * 计算某作用域「该注入哪些条目」。
 *
 * 超过预算就按最近更新**从新到旧**取，直到塞满；超出的部分不注入但**显式报告**。
 * @returns {{injected:Array<{key,value}>, skipped:number, chars:number, cap:number, over:boolean}}
 */
export function planInjection(db, scope, now = new Date()) {
  const u = usageOf(db, scope, now);
  const cap = u.cap;
  const injected = [];
  let chars = 0;
  let skipped = 0;
  for (const row of u.rows) {
    if (chars + row.size > cap && injected.length > 0) { skipped++; continue; }
    const e = entriesOf(db).find((x) => x.key === row.key);
    if (!e) { skipped++; continue; }
    injected.push({ key: e.key, value: e.value });
    chars += row.size;
  }
  return { injected, skipped, chars, cap, over: skipped > 0 };
}

/**
 * 强制收敛到预算：把超出预算的条目**降级**（打上 outOfBudget 标记后从注入集移除）。
 * 不删除条目本身 —— 信息还在，只是不再每轮花 token。
 */
export function enforceBudget(db, scope, now = new Date()) {
  const plan = planInjection(db, scope, now);
  if (!plan.over) return { scope, changed: 0, chars: plan.chars, cap: plan.cap, over: false };
  const keep = new Set(plan.injected.map((x) => x.key));
  let changed = 0;
  for (const e of entriesOf(db)) {
    if (scopeOf(e.key) !== scope) continue;
    if (keep.has(e.key)) { delete e.outOfBudget; continue; }
    if (e.outOfBudget !== true) { e.outOfBudget = true; changed++; }
  }
  return { scope, changed, chars: plan.chars, cap: plan.cap, over: true, skipped: plan.skipped };
}

/**
 * 换会话闸门（对应 luanyujia 的「不过不许换」）。
 *
 * 判据：
 *   1. 必须存在 scene.handoff 交接条目（结论 / 下一步）
 *   2. 该条目 ≤ scene 预算
 *   3. core 层不超预算（否则每轮都在烧 token）
 * 返回 ok=false 时给出具体问题，**不假装通过**。
 */
export function checkHandoff(db, now = new Date()) {
  const d = db || memLoad();
  const problems = [];
  const handoff = entriesOf(d).find((e) => e.key === 'scene.handoff'
    && effectiveState(e, now) === 'fresh');
  if (!handoff || !String(handoff.value || '').trim()) {
    problems.push('缺少 scene.handoff 交接条目（换会话前必须先写：结论 / 下一步 / 卡点）');
  } else {
    const v = String(handoff.value);
    if (v.length > SCOPES.scene.cap) {
      problems.push('scene.handoff 超预算：' + v.length + ' > ' + SCOPES.scene.cap);
    }
    if (!/下一步|next/i.test(v)) problems.push('scene.handoff 里没写「下一步」');
  }
  const coreUse = usageOf(d, 'core', now);
  if (coreUse.over) {
    problems.push('core 层超预算：' + coreUse.chars + ' > ' + coreUse.cap + '（每轮都注入，必须裁）');
  }
  return { ok: problems.length === 0, problems, handoffChars: handoff ? String(handoff.value).length : 0, coreUse: coreUse.chars };
}