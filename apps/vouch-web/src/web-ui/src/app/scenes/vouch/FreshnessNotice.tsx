import type { CSSProperties } from 'react';
import { applyFreshness, canClaimCurrent, DEFAULT_STALE_MS } from '@/app/scenes/scene-memory/freshness';
import type { Verdict } from '@/app/scenes/scene-memory/freshness';

/**
 * 数据新鲜度提示 —— 全站共用，防止「旧快照冒充此刻」
 *
 * 为什么做成组件而不是每处写一遍：
 *   2026-11-17 发现四态面板、验证场景各写了一套"显示年龄但不降级"，
 *   结果是 34~54 小时前的数据被当成当前事实。同一类错误不该有第二个实现。
 *
 * 行为（全部来自 scene-memory/freshness，有 11 项测试）：
 *   · 新鲜（≤24h）      ⇒ 不渲染（不打扰）
 *   · 陈旧（>24h）      ⇒ 黄色告警：多少小时前 + 重跑命令
 *   · 没有/非法时间戳   ⇒ 灰色 UNKNOWN：判不了新旧
 *
 * ⛔ 不阻止任何操作，只如实提示（判断权在人）。
 */

const S = {
  base: {
    display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap',
    fontSize: 'var(--openbitfun-type-body-sm-font-size)', lineHeight: 'var(--openbitfun-type-body-lg-line-height)', padding: '8px 12px', borderRadius: 8,
    marginTop: 10,
  } as CSSProperties,
  warn: { background: 'rgba(210,153,34,.12)', color: '#d29922', border: '1px solid rgba(210,153,34,.35)' } as CSSProperties,
  unknown: { background: 'rgba(128,128,128,.12)', color: '#8b949e', border: '1px solid rgba(128,128,128,.35)' } as CSSProperties,
  code: {
    // 用设计系统的语义角色令牌，不写裸字体/字号（audit-typography-tokens 会报）
    fontFamily: 'var(--openbitfun-type-code-md-font-family)',
    fontSize: 'var(--openbitfun-type-code-meta-font-size)',
    padding: '1px 6px', borderRadius: 4, background: 'rgba(128,128,128,.16)',
  } as CSSProperties,
};

export type FreshnessNoticeProps = {
  /** 数据产生时间（ISO 字符串） */
  at?: string | null;
  /** 数据来自哪个文件（用于提示） */
  source?: string;
  /** 重跑命令（如实给出，不要给不存在的命令） */
  rerunCommand?: string;
  /** 陈旧阈值，默认 24h */
  staleMs?: number;
  /** 源判定；源 FAIL 永不被新鲜度掩盖 */
  sourceVerdict?: Verdict;
  /** 自定义文案前缀 */
  label?: string;
};

export default function FreshnessNotice({
  at,
  source,
  rerunCommand,
  staleMs = DEFAULT_STALE_MS,
  sourceVerdict = 'PASS',
  label = '这份数据',
}: FreshnessNoticeProps) {
  const f = applyFreshness(sourceVerdict, at, Date.now(), staleMs);

  // 新鲜且非 FAIL：不打扰
  if (!f.stale && f.verdict !== 'UNKNOWN' && f.verdict !== 'FAIL') return null;

  const hours = f.ageHours === null ? '?' : f.ageHours.toFixed(1);
  const threshold = (staleMs / 3600000).toFixed(0);

  if (f.verdict === 'UNKNOWN') {
    return (
      <div style={{ ...S.base, ...S.unknown }} role="status">
        <span>❔</span>
        <span>
          {label}没有可用的时间戳（{f.reason}）—— <b>判不了新旧</b>，不能当成「此刻」。
          {source && <span style={S.code}>{source}</span>}
        </span>
      </div>
    );
  }

  return (
    <div style={{ ...S.base, ...S.warn }} role="status">
      <span>⚠</span>
      <span>
        {label}是 <b>{hours} 小时前</b>的快照（阈值 {threshold}h）—— <b>不等于此刻状态</b>。
        {!canClaimCurrent(f) && ' 数字仍是当时的真实结果，但已过期。'}
        {rerunCommand && (
          <>
            {' '}要声称「现在通过」，请重跑：<span style={S.code}>{rerunCommand}</span> 后刷新。
          </>
        )}
        {source && <> <span style={S.code}>{source}</span></>}
      </span>
    </div>
  );
}
