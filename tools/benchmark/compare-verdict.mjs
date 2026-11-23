/**
 * 四态判定与自检（从 executable-compare.mjs 抽出，因为主文件有 32KB 红线）
 *
 * 抽出时保持行为完全一致：selfTest 用依赖注入，不直接引用主文件的变量。
 */

/**
 * 离群检测 —— 最强值是否可疑地被小样本放大
 *
 * 实测：craft-anything 714 文件时 P1 每千 40.6，第二名只有 15.4（2.6 倍）。
 * 若最强 > 次强 × 2.5，**如实标注「可疑」**，不默默采信也不主观剔除。
 * 判断类的事不机械化 —— 这里只负责提醒，不负责决定。
 */
export function detectOutlier(values) {
  const sorted = values.filter((v) => v > 0).sort((a, b) => b - a);
  if (sorted.length < 2) return { suspicious: false, top: sorted[0] || 0, second: 0, ratio: 0 };
  const ratio = sorted[1] > 0 ? sorted[0] / sorted[1] : Infinity;
  return { suspicious: ratio > 2.5, top: sorted[0], second: sorted[1], ratio };
}

/**
 * 四态判定
 *
 *   FAIL    负对照 > 0 —— 扫描器什么都匹配，全部数据不可信
 *   UNKNOWN 可扫系统 < 10 —— 样本太少，判不了
 *   WARN    领先 < 落后 —— **诚实说横向不领先**
 *   PASS    领先 >= 落后 且负对照 0 且样本够
 *
 * WARN 不是失败，是「数据说我们没领先」。硬报 PASS 就是假绿。
 */
export function composeVerdict({ neg, available, lead, behind }) {
  if (neg > 0) {
    return { state: 'FAIL', why: '负对照命中 ' + neg + ' 次 —— 扫描器什么都匹配，全部数据不可信' };
  }
  if (available < 10) {
    return { state: 'UNKNOWN', why: '可扫系统只有 ' + available + ' 个（< 10）—— 样本太少，判不了横向领先' };
  }
  if (lead < behind) {
    return {
      state: 'WARN',
      why: '领先 ' + lead + ' 项 / 落后 ' + behind + ' 项 —— **横向不领先**，这是诚实结论不是失败',
    };
  }
  return { state: 'PASS', why: '领先 ' + lead + ' 项 / 落后 ' + behind + ' 项 · 负对照 0 · 可扫 ' + available + ' 个系统' };
}

