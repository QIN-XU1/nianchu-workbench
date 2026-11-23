/**
 * VerifyScene — 我们的验收四态面板
 *
 * 这个场景回答一个问题：**哪些事真的验过，哪些判不了**。
 *
 * 数据来自 tools/gen-snapshot.mjs 跑真实验收器后的落盘（vouch/data/snapshot.json），
 * 不是示例数据。四态分开计数，**判不了单独一列**，永不并入通过 ——
 * 这是整个产品的主张：已写入 ≠ 已验证。
 */
import { useMemo } from 'react';
import { ScrollArea } from '@openbitfun/ui';
import { ShieldCheck, ShieldAlert, ShieldX, CircleHelp } from 'lucide-react';
import snapshotJson from './data/snapshot.json';
import './VerifyScene.scss';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { applyFreshness, canClaimCurrent, DEFAULT_STALE_MS } from '@/app/scenes/scene-memory/freshness';

type Tr = (k: string, o?: Record<string, unknown>) => string;

type FourState = 'pass' | 'warn' | 'fail' | 'unknown';

interface SuiteResult {
  id: string;
  name: string;
  path: string;
  state: FourState;
  pass: number;
  warn: number;
  fail: number;
  unknown: number;
  ms: number;
  notes?: string[];
}

interface Snapshot {
  generatedAt: string;
  generator: string;
  verify: { suites: SuiteResult[] };
  about?: { product?: string; version?: string; stage?: string };
}

const snapshot = snapshotJson as unknown as Snapshot;

const STATE_META: Record<FourState, { labelKey: string; icon: typeof ShieldCheck; tone: string }> = {
  pass: { labelKey: 'statePass', icon: ShieldCheck, tone: 'pass' },
  warn: { labelKey: 'stateWarn', icon: ShieldAlert, tone: 'warn' },
  fail: { labelKey: 'stateFail', icon: ShieldX, tone: 'fail' },
  unknown: { labelKey: 'stateUnknown', icon: CircleHelp, tone: 'unknown' },
};

function totals(suites: SuiteResult[]) {
  return suites.reduce(
    (a, s) => ({
      pass: a.pass + s.pass,
      warn: a.warn + s.warn,
      fail: a.fail + s.fail,
      unknown: a.unknown + s.unknown,
    }),
    { pass: 0, warn: 0, fail: 0, unknown: 0 },
  );
}

function suitesByState(suites: SuiteResult[]) {
  const out: Record<FourState, number> = { pass: 0, warn: 0, fail: 0, unknown: 0 };
  for (const s of suites) out[s.state] += 1;
  return out;
}

function ageLabel(iso: string, tr: Tr): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return tr('justNow');
  const s = Math.round(ms / 1000);
  if (s < 60) return tr('secondsAgo', { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return tr('minutesAgo', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return tr('hoursAgo', { n: h });
  return tr('daysAgo', { n: Math.round(h / 24) });
}

export function VerifyScene() {
  const { t: tr } = useI18n('vouch');
  const suites = snapshot.verify?.suites ?? [];
  // 【2026-11-17 加】数据新鲜度：54 小时前的快照不能当「此刻通过」。
  // 复用 scene-memory/freshness（有 11 项测试，含「34.9 小时前必须降为 WARN」反例）。
  const freshness = applyFreshness('PASS', snapshot.generatedAt, Date.now(), DEFAULT_STALE_MS);
  const staleSnapshot = freshness.stale;
  const t = useMemo(() => totals(suites), [suites]);
  const byState = useMemo(() => suitesByState(suites), [suites]);

  return (
    <div className="vouch-verify">
      <header className="vouch-verify__head">
        <div className="vouch-verify__title">
          <ShieldCheck size={18} aria-hidden="true" />
          <h1>{tr('verifyTitle')}</h1>
        </div>
        <p className="vouch-verify__sub">
          {tr('verifyDesc')}
        </p>
      </header>

      <ScrollArea className="vouch-verify__scroll">
        {/* 断言四态 */}
        <section className="vouch-verify__section">
          <h2 className="vouch-verify__h2">
            {tr('sectionAssertions')}
            <span className="vouch-verify__meta">
              {tr('metaAssertions', { total: t.pass + t.warn + t.fail + t.unknown, suites: suites.length })}
            </span>
          </h2>
          <div className="vouch-verify__stats">
            {(['pass', 'warn', 'fail', 'unknown'] as FourState[]).map((k) => {
              const M = STATE_META[k];
              const I = M.icon;
              return (
                <div className="vouch-verify__stat" data-tone={M.tone} key={k}>
                  <span className="vouch-verify__stat-num">{t[k]}</span>
                  <span className="vouch-verify__stat-label">
                    <I size={14} aria-hidden="true" />
                    {tr(M.labelKey)}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="vouch-verify__note">
            {tr('suiteSummary', {
              suites: suites.length,
              pass: byState.pass,
              warn: byState.warn,
              fail: byState.fail,
              unknown: byState.unknown,
            })}
            <br />
            {tr('suiteCaveat')}
          </p>
          {staleSnapshot && (
            <p className="vouch-verify__note" data-tone="warn" style={{ marginTop: 10 }}>
              ⚠ 这份数据是 {freshness.ageHours !== null ? freshness.ageHours.toFixed(1) : '?'} 小时前的快照
              （阈值 {(DEFAULT_STALE_MS / 3600000).toFixed(0)}h）—— <b>不等于此刻状态</b>。
              要声称「现在通过」，请重跑：<code>node tools/gen-snapshot.mjs</code> 后刷新。
              {!canClaimCurrent(freshness) && ' 四态数字仍是当时的真实结果，但已过期。'}
            </p>
          )}
        </section>

        {/* 套件明细 */}
        <section className="vouch-verify__section">
          <h2 className="vouch-verify__h2">
            {tr('sectionSuites')}
            <span className="vouch-verify__meta">
              {tr('metaSource', { gen: snapshot.generator, at: ageLabel(snapshot.generatedAt, tr) })}
            </span>
          </h2>
          <div className="vouch-verify__table" role="table">
            <div className="vouch-verify__row vouch-verify__row--head" role="row">
              <span role="columnheader">{tr('colSuite')}</span>
              <span role="columnheader">{tr('colState')}</span>
              <span role="columnheader">{tr('colPass')}</span>
              <span role="columnheader">{tr('colFail')}</span>
              <span role="columnheader">{tr('colUnknown')}</span>
              <span role="columnheader">{tr('colTime')}</span>
            </div>
            {suites.map((s) => {
              const M = STATE_META[s.state];
              const I = M.icon;
              return (
                <div className="vouch-verify__row" role="row" data-tone={M.tone} key={s.id}>
                  <span className="vouch-verify__name" role="cell">
                    <strong>{s.name}</strong>
                    <code>{s.path}</code>
                  </span>
                  <span className="vouch-verify__chip" role="cell" data-tone={M.tone}>
                    <I size={12} aria-hidden="true" />
                    {tr(M.labelKey)}
                  </span>
                  <span role="cell">{s.pass}</span>
                  <span role="cell">{s.fail}</span>
                  <span role="cell">{s.unknown}</span>
                  <span role="cell">{s.ms}ms</span>
                </div>
              );
            })}
          </div>
        </section>

        {/* 判不了的单独拎出来 */}
        {suites.filter((s) => s.state === 'unknown' || s.state === 'fail').length > 0 && (
          <section className="vouch-verify__section">
            <h2 className="vouch-verify__h2">{tr('sectionNotAllGreen')}</h2>
            <ul className="vouch-verify__bad">
              {suites
                .filter((s) => s.state === 'unknown' || s.state === 'fail')
                .map((s) => (
                  <li key={s.id} data-tone={STATE_META[s.state].tone}>
                    <strong>{s.name}</strong>
                    <span>
                      {tr(STATE_META[s.state].labelKey)}
                      {s.notes?.length ? ' — ' + s.notes.join('; ') : ''}
                    </span>
                  </li>
                ))}
            </ul>
          </section>
        )}
      </ScrollArea>
    </div>
  );
}

export default VerifyScene;
