/**
 * 数据新鲜度判定 —— 防止「历史快照冒充此刻状态」
 *
 * 背景（2026-11-17 自查）：四态贯通面板把 34.9 小时前的审计快照显示成 PASS。
 * 那是假绿：源数据当时确实是 PASS，但**此刻**没重跑，不能拿它当"现在通过"。
 *
 * 判据：
 *   · 没有时间戳 / 时间戳非法 ⇒ UNKNOWN（判不了新旧，不猜）
 *   · 年龄 > staleMs（默认 24h）  ⇒ WARN（数据是快照，附年龄）
 *   · 年龄 ≤ staleMs              ⇒ 沿用源 verdict
 *   · 源 verdict 是 FAIL          ⇒ 永远 FAIL（新鲜也不掩盖失败）
 */

export type Verdict = 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN';

/** 默认陈旧阈值：24 小时 */
export const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;

export type Freshness = {
  verdict: Verdict;
  ageMs: number | null;
  ageHours: number | null;
  stale: boolean;
  reason: string;
};

/**
 * 计算新鲜度并给出**降级后**的 verdict。
 * @param sourceVerdict 源里写的四态
 * @param atIso 数据产生时间（ISO 字符串）
 * @param nowMs 当前时间（毫秒），默认 Date.now()
 * @param staleMs 陈旧阈值
 */
export function applyFreshness(
  sourceVerdict: Verdict,
  atIso: string | null | undefined,
  nowMs: number = Date.now(),
  staleMs: number = DEFAULT_STALE_MS,
): Freshness {
  // 源失败永远优先，不被新鲜度掩盖
  if (sourceVerdict === 'FAIL') {
    return { verdict: 'FAIL', ageMs: null, ageHours: null, stale: false, reason: '源判定 FAIL，不被新鲜度掩盖' };
  }

  if (!atIso || typeof atIso !== 'string') {
    return { verdict: 'UNKNOWN', ageMs: null, ageHours: null, stale: false, reason: '没有时间戳 —— 判不了新旧（UNKNOWN）' };
  }
  const t = Date.parse(atIso);
  if (!Number.isFinite(t)) {
    return { verdict: 'UNKNOWN', ageMs: null, ageHours: null, stale: false, reason: '时间戳非法 —— 判不了新旧（UNKNOWN）' };
  }

  const ageMs = Math.max(0, nowMs - t);
  const ageHours = ageMs / 3600000;
  const stale = ageMs > staleMs;

  if (stale) {
    return {
      verdict: 'WARN',
      ageMs,
      ageHours,
      stale: true,
      reason: `数据是 ${ageHours.toFixed(1)} 小时前的快照（阈值 ${(staleMs / 3600000).toFixed(0)}h）—— 不等于此刻状态，重跑审计后才算当前`,
    };
  }
  return {
    verdict: sourceVerdict,
    ageMs,
    ageHours,
    stale: false,
    reason: `数据 ${ageHours.toFixed(1)} 小时前，在阈值内`,
  };
}

/** 新鲜度是否允许声称「当前通过」 */
export function canClaimCurrent(f: Freshness): boolean {
  return f.verdict === 'PASS' && !f.stale;
}
