import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import data from '../benchmark/data/four-state-layers.json';
import { tally, allGreen } from './verdict';
import { applyFreshness, canClaimCurrent, DEFAULT_STALE_MS } from './freshness';
import type { Verdict } from './verdict';

/**
 * 四态贯通面板 —— T3 的界面化（观测→验证→记忆→改进→证明 五层 × 四态）
 *
 * 数据**不手抄**：来自 `evidence/evolve/four-state-layers.json`，
 * 由 `tools/evolve/export-four-state.mjs` 从真实审计产物导出。
 * 面板顶部显示源路径与导出时间，任何人可回查。
 *
 * 关键：
 *   · 每层每条案例显示 PASS/FAIL（ok=true/false），**不把失败画成通过**
 *   · 整体 state 直接取源里的 state；源没有 state ⇒ UNKNOWN（不猜 PASS）
 *   · 案例数为 0 ⇒ UNKNOWN（没跑过不等于通过）
 */

type Case = { name: string; ok: boolean; detail?: string };
type Layer = { layer: string; script: string; cases?: Case[]; ok?: boolean; why?: string };

const D = data as unknown as {
  what?: string; at?: string; state?: string;
  layersOk?: number; totalLayers?: number;
  passedCases?: number; totalCases?: number;
  results?: Layer[];
  source?: string; exportedAt?: string;
};

const S = {
  wrap: { padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14, height: '100%', overflow: 'auto' } as CSSProperties,
  head: { display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' } as CSSProperties,
  h1: { fontSize: 'var(--openbitfun-type-heading-md-font-size)', fontWeight: 'var(--openbitfun-type-label-md-weight-font-weight)', margin: 0 } as CSSProperties,
  sub: { fontSize: 'var(--openbitfun-type-body-sm-font-size)', opacity: 0.6 } as CSSProperties,
  card: { border: '1px solid var(--vouch-border, rgba(128,128,128,.25))', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 } as CSSProperties,
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } as CSSProperties,
  label: { fontSize: 'var(--openbitfun-type-body-md-font-size)', fontWeight: 'var(--openbitfun-type-label-md-weight-font-weight)' } as CSSProperties,
  hint: { fontSize: 'var(--openbitfun-type-meta-font-size)', opacity: 0.55, lineHeight: 'var(--openbitfun-type-body-md-line-height)' } as CSSProperties,
  mono: { fontFamily: 'var(--openbitfun-type-code-md-font-family)', fontSize: 'var(--openbitfun-type-meta-font-size)', opacity: 0.75 } as CSSProperties,
  caseRow: { fontSize: 'var(--openbitfun-type-body-sm-font-size)', lineHeight: 'var(--openbitfun-type-body-lg-line-height)', display: 'flex', gap: 8, alignItems: 'baseline' } as CSSProperties,
  ok: { color: '#2ea043', fontWeight: 'var(--openbitfun-type-heading-panel-weight-font-weight)' } as CSSProperties,
  bad: { color: '#da3633', fontWeight: 'var(--openbitfun-type-heading-panel-weight-font-weight)' } as CSSProperties,
  detail: { fontSize: 'var(--openbitfun-type-meta-font-size)', opacity: 0.6, fontFamily: 'var(--openbitfun-type-code-md-font-family)' } as CSSProperties,
  seg: (on: boolean): CSSProperties => ({
    padding: '5px 12px', borderRadius: 6, fontSize: 'var(--openbitfun-type-body-sm-font-size)', cursor: 'pointer',
    border: '1px solid ' + (on ? 'var(--vouch-accent, #4c8dff)' : 'rgba(128,128,128,.35)'),
    background: on ? 'rgba(76,141,255,.14)' : 'transparent',
    color: 'inherit', fontWeight: on ? 600 : 400,
  }),
};

const VERDICT_COLORS: Record<Verdict, [string, string]> = {
  PASS: ['rgba(46,160,67,.16)', '#2ea043'],
  WARN: ['rgba(210,153,34,.16)', '#d29922'],
  FAIL: ['rgba(218,54,51,.16)', '#da3633'],
  UNKNOWN: ['rgba(128,128,128,.16)', '#8b949e'],
};
const badgeStyle = (v: Verdict): CSSProperties => {
  const [bg, fg] = VERDICT_COLORS[v];
  return { padding: '3px 10px', borderRadius: 999, background: bg, color: fg, fontSize: 'var(--openbitfun-type-body-sm-font-size)', fontWeight: 'var(--openbitfun-type-heading-panel-weight-font-weight)', border: '1px solid ' + fg };
};

export default function FourStatePanel() {
  const layers = useMemo<Layer[]>(() => (Array.isArray(D.results) ? D.results : []), []);
  const [onlyFail, setOnlyFail] = useState(false);

  const totalCases = useMemo(
    () => layers.reduce((a, l) => a + (Array.isArray(l.cases) ? l.cases.length : 0), 0),
    [layers],
  );
  const failedCases = useMemo(
    () => layers.reduce((a, l) => a + (l.cases || []).filter((c) => !c.ok).length, 0),
    [layers],
  );

  // 整体四态：先按数据推，再按**新鲜度降级**（防历史快照冒充此刻）
  const sourceVerdict: Verdict = useMemo(() => {
    if (layers.length === 0 || totalCases === 0) return 'UNKNOWN';
    if (failedCases > 0) return 'FAIL';
    const s = String(D.state || '').toUpperCase();
    if (s === 'PASS' || s === 'WARN' || s === 'FAIL' || s === 'UNKNOWN') return s as Verdict;
    return 'UNKNOWN';
  }, [layers, totalCases, failedCases]);

  const fresh = useMemo(
    () => applyFreshness(sourceVerdict, D.at, Date.now(), DEFAULT_STALE_MS),
    [sourceVerdict],
  );
  const verdict: Verdict = fresh.verdict;

  const counts = useMemo(
    () => tally(layers.map((l) => ((l.cases || []).every((c) => c.ok) ? 'PASS' : 'FAIL') as Verdict)),
    [layers],
  );

  const shown = useMemo(() => (onlyFail ? layers.filter((l) => (l.cases || []).some((c) => !c.ok)) : layers), [layers, onlyFail]);

  return (
    <div style={S.wrap}>
      <div style={S.head}>
        <h1 style={S.h1}>四态贯通（五层）</h1>
        <span style={S.sub}>观测 → 验证 → 记忆 → 改进 → 证明｜UNKNOWN 永不被并入通过</span>
        <span style={{ marginLeft: 'auto' }} />
        <span style={badgeStyle(verdict)}>{verdict}</span>
      </div>

      <div style={S.card}>
        <div style={S.row}>
          <span style={S.label}>总体</span>
          <span style={S.hint}>
            层 {D.layersOk ?? '—'}/{D.totalLayers ?? layers.length} 通过 · 案例 {D.passedCases ?? (totalCases - failedCases)}/{D.totalCases ?? totalCases} 通过
          </span>
          <span style={{ marginLeft: 'auto' }} />
          <span style={S.hint}>{counts.PASS} 层 PASS · {counts.FAIL} 层 FAIL</span>
        </div>
        <div style={S.hint}>{D.what || '（无说明）'}</div>
        <div style={S.mono}>来源：{D.source || '—'} · 审计时间 {D.at || '—'} · 导出 {D.exportedAt || '—'}</div>
        <div style={S.row}>
          <span style={S.label}>数据新鲜度</span>
          <span style={fresh.ageHours === null ? S.hint : fresh.stale ? { ...S.hint, color: '#d29922', fontWeight: 'var(--openbitfun-type-heading-panel-weight-font-weight)' } : S.hint}>
            {fresh.ageHours === null ? '未知' : fresh.ageHours.toFixed(1) + ' 小时前'}
            {' '}· 阈值 {(DEFAULT_STALE_MS / 3600000).toFixed(0)}h
            {' '}· {canClaimCurrent(fresh) ? '可作为「当前」' : '**不可**作为「当前」'}
          </span>
        </div>
        <div style={fresh.stale ? { ...S.hint, color: '#d29922' } : S.hint}>{fresh.reason}</div>
        {fresh.stale && (
          <div style={{ ...S.hint, color: '#d29922' }}>
            ⚠ 这是历史快照，不是此刻状态。要声称「现在通过」，请重跑：
            <span style={S.mono}> node tools/evolve/audit-four-state-layers.mjs && node tools/evolve/export-four-state.mjs</span>
          </div>
        )}
        {verdict === 'UNKNOWN' && (
          <div style={{ ...S.hint, color: '#d29922' }}>
            ⚠ 判不了（UNKNOWN）—— 没有层/案例数据，或源里没有合法 state。**没跑过不等于通过**。
          </div>
        )}
      </div>

      <div style={S.row}>
        <button style={S.seg(!onlyFail)} onClick={() => setOnlyFail(false)}>全部层（{layers.length}）</button>
        <button style={S.seg(onlyFail)} onClick={() => setOnlyFail(true)}>只看有失败的层</button>
      </div>

      {shown.length === 0 ? (
        <div style={S.card}><div style={S.hint}>{layers.length === 0 ? '没有数据 —— 判不了（UNKNOWN）。' : '没有失败的层。'}</div></div>
      ) : (
        shown.map((l) => {
          const cs = l.cases || [];
          const okAll = cs.length > 0 && cs.every((c) => c.ok);
          const lv: Verdict = cs.length === 0 ? 'UNKNOWN' : okAll ? 'PASS' : 'FAIL';
          return (
            <div key={l.layer} style={S.card}>
              <div style={S.row}>
                <span style={S.label}>{l.layer}</span>
                <span style={S.mono}>{l.script}</span>
                <span style={{ marginLeft: 'auto' }} />
                <span style={badgeStyle(lv)}>{lv}</span>
              </div>
              {cs.length === 0 ? (
                <div style={S.hint}>这一层没有案例 —— 判不了（UNKNOWN）。</div>
              ) : (
                cs.map((c, i) => (
                  <div key={i} style={S.caseRow}>
                    <span style={c.ok ? S.ok : S.bad}>{c.ok ? '✓' : '✗'}</span>
                    <span>{c.name}</span>
                    {c.detail && <span style={S.detail}>{c.detail}</span>}
                  </div>
                ))
              )}
              {l.why && <div style={S.hint}>结论：{l.why}</div>}
            </div>
          );
        })
      )}

      {allGreen([verdict]) && (
        <div style={{ ...S.hint, color: '#2ea043' }}>✓ 五层四态贯通，全部案例通过（UNKNOWN 未并入通过）</div>
      )}
    </div>
  );
}
