import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { sceneHealth } from './healthEngine';
import type { HealthResult } from './healthEngine';
import { K_MEMORY_TEXT, K_IDENTITY_CTX, K_IDENTITY_ID, K_INDEX_ROWS } from './storageKeys';
import { cardFingerprint } from './identityEngine';
import type { IdentityIndexRow } from './identityEngine';
import type { Verdict } from './verdict';

/**
 * 场景健康检查 —— 一次给出记忆 / 身份指纹 / 身份索引 的合成四态
 *
 * 为什么需要：这三块原本在三个 tab 里，人要分别点开才拼得出全貌，
 * 「记忆说身份是 X、身份卡登记的却是 Y」这种矛盾很容易被漏掉。
 *
 * 数据来源：**直接读 localStorage**（与三个面板同一份 key，见 storageKeys.ts），
 * 不复制各自组件内部 state —— 否则又会出现「A 改了 B 看不见」。
 * 监听 storage 事件，别处改动时自动重算。
 */

const TONE: Record<Verdict, { bg: string; fg: string; bd: string }> = {
  PASS: { bg: 'rgba(46,160,67,.12)', fg: '#2ea043', bd: 'rgba(46,160,67,.35)' },
  WARN: { bg: 'rgba(210,153,34,.12)', fg: '#d29922', bd: 'rgba(210,153,34,.35)' },
  FAIL: { bg: 'rgba(218,54,51,.12)', fg: '#da3633', bd: 'rgba(218,51,51,.35)' },
  UNKNOWN: { bg: 'rgba(128,128,128,.12)', fg: '#8b949e', bd: 'rgba(128,128,128,.35)' },
};

const S = {
  wrap: { padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 14 } as CSSProperties,
  head: { display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' } as CSSProperties,
  h1: { fontSize: 'var(--openbitfun-type-heading-md-font-size)', fontWeight: 'var(--openbitfun-type-label-md-weight-font-weight)', margin: 0 } as CSSProperties,
  sub: { fontSize: 'var(--openbitfun-type-body-sm-font-size)', opacity: 0.65 } as CSSProperties,
  panel: {
    border: '1px solid rgba(128,128,128,.25)', borderRadius: 10, padding: 14,
    display: 'flex', flexDirection: 'column', gap: 8,
  } as CSSProperties,
  row: { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' } as CSSProperties,
  partRow: {
    display: 'flex', gap: 10, alignItems: 'baseline', padding: '6px 0',
    borderTop: '1px solid rgba(128,128,128,.15)',
  } as CSSProperties,
  label: { fontSize: 'var(--openbitfun-type-body-sm-font-size)', fontWeight: 'var(--openbitfun-type-label-md-weight-font-weight)', opacity: 0.85, minWidth: 130 } as CSSProperties,
  hint: { fontSize: 'var(--openbitfun-type-body-sm-font-size)', opacity: 0.7 } as CSSProperties,
  mono: { fontFamily: 'var(--openbitfun-type-code-md-font-family)', fontSize: 'var(--openbitfun-type-body-sm-font-size)' } as CSSProperties,
};

const badge = (v: Verdict): CSSProperties => ({
  padding: '2px 9px', borderRadius: 999, fontSize: 'var(--openbitfun-type-meta-font-size)', fontWeight: 'var(--openbitfun-type-heading-panel-weight-font-weight)',
  background: TONE[v].bg, color: TONE[v].fg, border: '1px solid ' + TONE[v].bd,
});

export default function HealthPanel() {
  const [tick, setTick] = useState(0);
  const [computed, setComputed] = useState<string | null>(null);

  const raw = useMemo(() => {
    const g = (k: string): string => {
      try { return localStorage.getItem(k) ?? ''; } catch { return ''; }
    };
    let rows: IdentityIndexRow[] = [];
    try {
      const p = JSON.parse(g(K_INDEX_ROWS) || '[]') as IdentityIndexRow[];
      if (Array.isArray(p)) rows = p;
    } catch { rows = []; }
    return {
      memoryText: g(K_MEMORY_TEXT),
      ctxCard: g(K_IDENTITY_CTX),
      idCard: g(K_IDENTITY_ID),
      indexRows: rows,
    };
    // tick 用于 storage 事件后强制重读
  }, [tick]);

  // 别处改了同一份 key 时要重算（否则又是「A 改了 B 看不见」）
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener('storage', bump);
    window.addEventListener('nianchu:memory-changed', bump);
    window.addEventListener('nianchu:identity-changed', bump);
    return () => {
      window.removeEventListener('storage', bump);
      window.removeEventListener('nianchu:memory-changed', bump);
      window.removeEventListener('nianchu:identity-changed', bump);
    };
  }, []);

  // 真实 sha256（Web Crypto），异步算出后回填
  useEffect(() => {
    let alive = true;
    if (!raw.ctxCard.trim()) { setComputed(null); return; }
    cardFingerprint(raw.ctxCard)
      .then((fp) => { if (alive) setComputed(fp); })
      .catch(() => { if (alive) setComputed(null); });
    return () => { alive = false; };
  }, [raw.ctxCard]);

  const health: HealthResult = useMemo(
    () => sceneHealth({
      memoryText: raw.memoryText,
      ctxCard: raw.ctxCard,
      idCard: raw.idCard,
      computedFingerprint: computed,
      indexRows: raw.indexRows,
    }),
    [raw, computed],
  );

  return (
    <div style={S.wrap}>
      <div style={S.head}>
        <h1 style={S.h1}>场景健康检查</h1>
        <span style={S.sub}>
          记忆 · 身份指纹 · 身份索引 三项合成一个四态 —— 判不了不许被平均成通过
        </span>
        <span style={{ marginLeft: 'auto' }} />
        <span style={badge(health.verdict)}>{health.verdict}</span>
      </div>

      <div style={S.panel}>
        <div style={S.row}>
          <span style={S.label}>合成结果</span>
          <span style={S.sub}>
            {health.counts.PASS} PASS · {health.counts.WARN} WARN · {health.counts.FAIL} FAIL ·{' '}
            {health.counts.UNKNOWN} UNKNOWN
          </span>
          <span style={{ marginLeft: 'auto' }} />
          <button
            style={{
              padding: '3px 10px', borderRadius: 6, fontSize: 'var(--openbitfun-type-meta-font-size)', cursor: 'pointer',
              border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit',
            }}
            onClick={() => setTick((t) => t + 1)}
          >
            重新检查
          </button>
        </div>

        {health.parts.map((p) => (
          <div key={p.id} style={S.partRow}>
            <span style={badge(p.verdict)}>{p.verdict}</span>
            <span style={{ ...S.label, minWidth: 110 }}>{p.label}</span>
            <span style={{ ...S.hint, flex: 1 }}>{p.detail}</span>
          </div>
        ))}
      </div>

      {health.blockers.length > 0 ? (
        <div style={S.panel}>
          <div style={S.row}>
            <span style={S.label}>拖后腿的项（{health.blockers.length}）</span>
            <span style={S.hint}>按严重度排序：FAIL → UNKNOWN → WARN</span>
          </div>
          {health.blockers.map((b) => (
            <div key={b.id} style={S.row}>
              <span style={badge(b.verdict)}>{b.verdict}</span>
              <span style={S.mono}>{b.label}</span>
              <span style={S.hint}>{b.detail}</span>
            </div>
          ))}
        </div>
      ) : health.verdict === 'PASS' ? (
        <div style={S.panel}>
          <div style={{ ...S.hint, color: '#2ea043' }}>
            ✓ 三项都通过。注意：这只说明「填的东西合规且对得上」，不说明内容写得好不好。
          </div>
        </div>
      ) : null}

      <div style={S.panel}>
        <div style={S.hint}>
          数据来源：localStorage 的四个 key（记忆正文 / 定位卡 / 身份卡 / 索引表格），
          与三个面板同一份。指纹用 Web Crypto 真算 sha256，不是本地拼字符串。
        </div>
        <div style={S.hint}>
          {raw.ctxCard.trim() === ''
            ? '定位卡为空 —— 指纹判不了（UNKNOWN），不是通过。'
            : computed
              ? '定位卡指纹（实算）：' + computed
              : '正在计算定位卡指纹…'}
        </div>
      </div>
    </div>
  );
}
