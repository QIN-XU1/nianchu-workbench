#!/usr/bin/env node
/**
 * 台账「独立性」检查 —— 单独一个模块。
 *
 * 从 `tools/evolve/evolve.mjs` 拆出（原文件加检查后涨到 32.9KB 超红线）。
 * 拆分理由也顺：这是**判断一条改进是否真的被独立验证**的规则，
 * 与「台账读写」「追加」是不同职责，而且它是最容易被我自己糊弄过去的一条。
 *
 * 为什么要这个模块：
 *   `independent` 是我可以随手写 true 的字段。真正能证明独立性的是**证据**
 *   （谁跑的、跑了什么、输出在哪），不是这个布尔值。
 *   所以至少要能抓住「台账自己说不算独立、却记成 closed」这种最明显的矛盾。
 *
 * 实测抓到 12 条：例如 H-0092 的 notes 明写
 *   「C5：验证方与实现方是同一个（lead）⇒ 状态降为「部分」，不算独立验证」
 * 而 independent=true、status=closed，原检查器报 0 个问题。
 */

/** notes / verifier 里自认「不算独立验证」的说法 */
export const SELF_DENIES = /不算独立|非独立|同一个（lead）|自验自|自我验证/;

/** 明确标注由独立子代理验证的 verifier 名（唯一能当「独立」证据的形态） */
export const INDEPENDENT_VERIFIER = /independent-subagent/i;

/**
 * 检查一条台账记录的独立性是否自洽。
 * @returns {string|null} 有问题返回说明，没问题返回 null
 */
export function checkIndependence(e, effectiveStatus) {
  if (!e || typeof e !== 'object') return null;
  const st = effectiveStatus ? effectiveStatus(e) : e.status;

  // ① 自己验自己却记 closed
  if (e.independent === false && st === 'closed') {
    return e.id + ' 自己验自己但状态写 closed（应降为 partial）';
  }

  // ② notes 里自认不算独立，却记 closed
  if (st === 'closed') {
    const txt = (Array.isArray(e.notes) ? e.notes.join(' ') : '') + ' ' + String(e.verifier || '');
    if (SELF_DENIES.test(txt)) {
      return e.id + ' notes 自认「不算独立验证」却记 closed（应降为 partial）';
    }
  }
  return null;
}

/**
 * 统计：closed 里有多少条的 verifier 明确是独立子代理。
 * 这是 T1「≥3 轮由非实现方独立验证」的可数口径 —— 只看名字带 independent-subagent 的，
 * 不认 `v-y` 这类我自己起的名字（那些没有独立性证据）。
 */
export function countIndependentClosed(entries, effectiveStatus) {
  const eff = effectiveStatus || ((x) => (x.disputedBy ? 'refuted' : x.status));
  const closed = entries.filter((e) => eff(e) === 'closed');
  const indep = closed.filter((e) => INDEPENDENT_VERIFIER.test(String(e.verifier || '')));
  return { closed: closed.length, independent: indep.length, ids: indep.map((e) => e.id) };
}
