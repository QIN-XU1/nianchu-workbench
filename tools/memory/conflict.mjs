#!/usr/bin/env node
/**
 * 记忆冲突与推翻 —— 冲突标记 / 显式解决 / 回滚。
 *
 * 从 `tools/memory/store.mjs` 拆出。这一族对应 P6「记忆冲突/推翻」。
 *
 * 三条硬规则（照搬原实现）：
 *   ① **冲突不许自动选边** —— 同 key 不同值把旧条目标 superseded 并链 supersededBy，
 *      或者（conflict 模式）把所有条目标 conflicted 等人工裁决
 *   ② **解决必须留理由** —— resolve 要求 why 非空；机制不替你决定，但要求留下决定的理由
 *   ③ **旧值永远可查** —— 静默覆盖会让记忆不可信
 */
import { M, effectiveState, isExpired } from './ttl.mjs';

/**
 * 从一批同 key 条目里挑出「当前有效」与「冲突候选」。
 * @returns {{live: object|null, liveCount:number, conflicted:object[], ambiguous:boolean}}
 */
export function classify(entries, now = new Date()) {
  const withState = entries.map((e) => ({ ...e, effective: effectiveState(e, now) }));
  const live = withState.filter((e) => e.effective === M.FRESH);
  const conflicted = withState.filter((e) => e.effective === M.CONFLICTED);
  return {
    live: live.length ? live[live.length - 1] : null,
    liveCount: live.length,
    conflicted,
    // 【实测修过的坑】原来 ambiguous 只看 live.length > 1；冲突模式下 live 是 0 条
    // ⇒ ambiguous=false，调用方看到「没有值、也没有歧义」—— 把冲突藏起来了。
    ambiguous: live.length > 1 || conflicted.length > 0,
  };
}

/**
 * 显式解决冲突。**必须说明理由**。
 * @returns {{ok:boolean, why?:string, superseded?:string[]}}
 */
export function resolveConflict(db, { key, chooseId, why, now = new Date(), by = 'agent' }) {
  if (!key) return { ok: false, why: 'key 不能为空' };
  if (!chooseId) return { ok: false, why: '必须指定 chooseId（选哪一条）' };
  if (!why || !String(why).trim()) {
    return { ok: false, why: '必须写理由（why）—— 冲突解决不许无痕' };
  }
  const all = (db.entries || []).filter((e) => e.key === String(key).trim());
  const chosen = all.find((e) => e.id === chooseId);
  if (!chosen) return { ok: false, why: '找不到 ' + chooseId };
  const st = effectiveState(chosen, now);
  if (st === M.SUPERSEDED) {
    return { ok: false, why: '不能选一条已被推翻的条目' };
  }
  // 【2026-11-18 修·独立审计 P1】原来只拒绝 SUPERSEDED，不拒绝 EXPIRED。
  // 选中过期条目后 chosen.state=FRESH，但它实际仍是 expired ⇒ classify 得到
  // live=null, ambiguous=false, conflicted=[] —— 调用方看到「没有值、也没有歧义」。
  // 这正是本文件 L27-29 注释里说「原来会把冲突藏起来」的同一种失败模式，
  // 只是入口从 `live.length>1` 换成了 TTL。现在显式拒绝。
  if (st === M.EXPIRED) {
    return { ok: false, why: '不能选一条已过期的条目（会让冲突被静默抹平）' };
  }

  const superseded = [];
  for (const o of all) {
    if (o.id === chooseId) continue;
    if (effectiveState(o, now) !== M.CONFLICTED) continue;
    o.state = M.SUPERSEDED;
    o.supersededBy = chooseId;
    o.supersededAt = now.toISOString();
    superseded.push(o.id);
  }
  chosen.state = M.FRESH;
  chosen.resolvedAt = now.toISOString();
  chosen.resolvedBy = by;
  chosen.resolveWhy = String(why).trim();
  return { ok: true, superseded };
}

/**
 * 回滚到某条历史值。
 * 不是「删除现在的值」，而是把当前值标 superseded、把目标条目标回 fresh —— 全程留痕。
 */
export function revertTo(db, { key, toEntryId, why, now = new Date(), by = 'agent' }) {
  if (!key) return { ok: false, why: 'key 不能为空' };
  if (!toEntryId) return { ok: false, why: '必须指定 toEntryId' };
  if (!why || !String(why).trim()) return { ok: false, why: '必须写理由（why）—— 回滚不许无痕' };

  const all = (db.entries || []).filter((e) => e.key === String(key).trim());
  const target = all.find((e) => e.id === toEntryId);
  if (!target) return { ok: false, why: '找不到 ' + toEntryId };
  // 【2026-11-18 修·审计 P1】与 resolveConflict 同理：回滚到已过期条目 = 假装有了有效值
  // 用 isExpired 而不是 effectiveState：后者在 SUPERSEDED 时**提前返回**，
  // 而回滚的目标通常正是 superseded ⇒ 用它会永远判不到 expired（实测踩到）。
  if (isExpired(target, now)) {
    return { ok: false, why: '不能回滚到一条已过期的条目' };
  }

  const superseded = [];
  for (const e of all) {
    if (e.id === toEntryId) continue;
    // 【2026-11-18 修·审计 P1】原来只处理 FRESH，冲突条目原封不动 ⇒ 回滚后仍 ambiguous。
    // store.revert 会收口冲突，端点用的这个弱版本不会 —— 现在对齐。
    if (effectiveState(e, now) === M.FRESH || effectiveState(e, now) === M.CONFLICTED) {
      e.state = M.SUPERSEDED;
      e.supersededBy = toEntryId;
      e.supersededAt = now.toISOString();
      superseded.push(e.id);
    }
  }
  target.state = M.FRESH;
  target.revertedAt = now.toISOString();
  target.revertedBy = by;
  target.revertWhy = String(why).trim();
  return { ok: true, superseded };
}
