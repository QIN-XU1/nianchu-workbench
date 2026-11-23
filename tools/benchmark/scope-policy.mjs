/**
 * 「什么算我们的代码」口径策略 —— T5 的地基
 *
 * 【2026-11-17】连续 9 轮校准发现：同一份代码，不同分母给出完全相反的 T5 结论
 *   28076→2/6 · 9550→2/6 · 4863→2/6 · 1893→3/5 · 1435→4/4(PASS)
 * 所以「领先与否」不是数据问题，是分母没定义。
 *
 * 三层，全部可见：
 *   ours      自己写的、当前在用的   → 计入四态判定
 *   archived  自己写过但已归档       → 单独报数，不计入（**这是判断，必须可见**）
 *   notOurs   别人的（fork/参考/缓存）→ 完全排除，单独报数
 *
 * 判据都要可核对：git 跟踪状态 / .gitignore / 内容 hash。
 */
export const SCOPE_POLICY = {
  ours: {
    rule: 'git 跟踪 且 不在参考副本/fork 目录里',
    evidence: 'git ls-files 有输出 + REF_COPY_DIRS/FORK_DIRS 未命中',
  },
  archived: {
    dirs: ['归档'],
    rule: 'git 跟踪但我方已归档（旧备份/已删技能/调试脚本）',
    why: '归档代码不是当前产品能力，计入会高估；但它确实是我们的，所以单独报数不隐藏',
  },
  notOurs: {
    rule: '内容 hash 与上游相同（fork）或 .gitignore 标注为参考副本/缓存',
    evidence: 'FORK_DIRS 的 cheapHash 比对 + REF_COPY_DIRS 来自 .gitignore',
  },
};

/** 是否属于「已归档」目录（注意：不许前缀误判，归档X ≠ 归档） */
export function isArchived(relPath) {
  return SCOPE_POLICY.archived.dirs.some((d) => relPath === d || relPath.startsWith(d + '/'));
}
