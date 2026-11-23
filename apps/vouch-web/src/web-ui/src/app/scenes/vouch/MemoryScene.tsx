/**
 * MemoryScene — 记忆治理（在 OpenBitFun 界面里）
 *
 * 显示真实存储的状态：每条记忆的来源、有效状态、TTL 剩余。
 * 「被推翻」和「已过期」都留着可见 —— 历史是信息，静默覆盖会让记忆变得不可信。
 */
import { ScrollArea } from '@openbitfun/ui';
import memoryJson from './data/memory.json';

/** 该场景数据的产生时间（供 FreshnessNotice 判定新旧） */
const DATA_AT: string | undefined = (memoryJson as unknown as Record<string, unknown>)?.['at'] as string | undefined;
import FreshnessNotice from './FreshnessNotice';
import { BrainCircuit } from 'lucide-react';
import './VouchShared.scss';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';

type Tr = (k: string, o?: Record<string, unknown>) => string;

type MemState = 'fresh' | 'superseded' | 'expired' | 'conflicted';

interface MemEntry {
  id: string;
  key: string;
  value: string;
  source: string;
  state: MemState;
  createdAt: string;
  touchCount: number;
  ttlSec: number | null;
  expiresAt: string | null;
  msLeft: number | null;
}

interface MemData {
  at: string;
  rule: string;
  totals: { total: number; fresh: number; expired: number; superseded: number; noSource: number; unresolvedConflict: number };
  audit: { ok: boolean; issues: string[] };
  entries: MemEntry[];
}

const mem = memoryJson as unknown as MemData;

// 状态标签改由 i18n 提供（locales/*/vouch.json 的 stateFresh 等 key）
const STATE_LABEL_KEY: Record<MemState, string> = {
  fresh: 'stateFresh',
  superseded: 'stateSuperseded',
  expired: 'stateExpired',
  conflicted: 'stateConflicted',
};

const STATE_TONE: Record<MemState, string> = {
  fresh: 'pass',
  superseded: 'unknown',
  expired: 'warn',
  conflicted: 'fail',
};

function ttlLabel(e: MemEntry, tr: Tr): string {
  if (e.ttlSec === null) return tr('ttlNone');
  if (e.msLeft === null) return tr('ttlFixed', { s: e.ttlSec });
  if (e.msLeft <= 0) return tr('ttlExpired', { s: Math.round(-e.msLeft / 1000) });
  return tr('ttlLeft', { s: Math.round(e.msLeft / 1000) });
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

export function MemoryScene() {
  const { t: tr } = useI18n('vouch');
  const t = mem.totals;
  const live = mem.entries.filter((e) => e.state === 'fresh');
  const dead = mem.entries.filter((e) => e.state !== 'fresh');

  return (
    <div className="vouch-page">
      <header className="vouch-page__head">
        <div className="vouch-page__title">
          <BrainCircuit size={18} aria-hidden="true" />
          <h1>{tr('pageTitle')}</h1>
        </div>
        <p className="vouch-page__sub">{mem.rule}</p>
      </header>

            {/* 数据新鲜度：头部之外独占一行，不挤压标题 */}
            <FreshnessNotice
              at={DATA_AT}
              source="data/memory.json"
              rerunCommand="node tools/memory/gen-ui-data.mjs"
            />

      <ScrollArea className="vouch-page__scroll">
        <section className="vouch-page__section">
          <h2 className="vouch-page__h2">
            {tr('sectionFourState')}
            <span className="vouch-page__meta">{tr('metaTotal', { total: t.total, at: ageLabel(mem.at, tr) })}</span>
          </h2>
          <div className="vouch-stats">
            <div className="vouch-stat" data-tone="pass"><span className="vouch-stat__n">{t.fresh}</span><span className="vouch-stat__l">{tr('statFresh')}</span></div>
            <div className="vouch-stat" data-tone="unknown"><span className="vouch-stat__n">{t.superseded}</span><span className="vouch-stat__l">{tr('statSuperseded')}</span></div>
            <div className="vouch-stat" data-tone="warn"><span className="vouch-stat__n">{t.expired}</span><span className="vouch-stat__l">{tr('statExpired')}</span></div>
            <div className="vouch-stat" data-tone={t.noSource ? 'fail' : 'unknown'}><span className="vouch-stat__n">{t.noSource}</span><span className="vouch-stat__l">{tr('statNoSource')}</span></div>
            <div className="vouch-stat" data-tone={t.unresolvedConflict ? 'fail' : 'unknown'}><span className="vouch-stat__n">{t.unresolvedConflict}</span><span className="vouch-stat__l">{tr('statConflict')}</span></div>
          </div>
          <p className="vouch-note" data-tone={mem.audit.ok ? 'ok' : 'fail'}>
            <strong>{mem.audit.ok ? tr('auditOk') : tr('auditFail')}</strong>
            <br />
            {tr('principle1')}
            {tr('principle2')}
            {mem.audit.issues.length > 0 && <><br />{mem.audit.issues.join('；')}</>}
          </p>
        </section>

        <section className="vouch-page__section">
          <h2 className="vouch-page__h2">
            {tr('sectionLive')}
            <span className="vouch-page__meta">{tr('metaLive', { n: live.length })}</span>
          </h2>
          {live.length === 0 ? (
            <p className="vouch-note"><strong>{tr('emptyLive')}</strong></p>
          ) : (
            <ul className="vouch-list">
              {live.map((e) => (
                <li className="vouch-list__item" key={e.id}>
                  <div>
                    <span className="vouch-list__key">{e.key}</span>
                    <div className="vouch-list__val">{e.value}</div>
                  </div>
                  <div className="vouch-list__meta">
                    <span className="vouch-list__src" title={e.source}>{e.source}</span>
                    <span style={{ display: 'flex', gap: 10, flex: '0 0 auto' }}>
                      <span>{ttlLabel(e, tr)}</span>
                      <span>{ageLabel(e.createdAt, tr)}</span>
                      {e.touchCount > 1 && <span>{tr('confirmCount', { n: e.touchCount })}</span>}
                      <span className="vouch-tag" data-tone="pass">{tr(STATE_LABEL_KEY[e.state])}</span>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="vouch-page__section">
          <h2 className="vouch-page__h2">
            {tr('sectionHistory')}
            <span className="vouch-page__meta">{tr('metaHistory')}</span>
          </h2>
          {dead.length === 0 ? (
            <p className="vouch-note"><strong>{tr('emptyHistory')}</strong></p>
          ) : (
            <ul className="vouch-list">
              {dead.map((e) => (
                <li className="vouch-list__item" key={e.id}>
                  <div>
                    <span className="vouch-list__key">{e.key}</span>
                    <div className="vouch-list__val" style={{ color: 'var(--openbitfun-color-content-muted)', textDecoration: 'line-through' }}>
                      {e.value}
                    </div>
                  </div>
                  <div className="vouch-list__meta">
                    <span className="vouch-list__src" title={e.source}>{e.source}</span>
                    <span style={{ display: 'flex', gap: 10, flex: '0 0 auto' }}>
                      <span className="vouch-tag" data-tone={STATE_TONE[e.state]}>{tr(STATE_LABEL_KEY[e.state])}</span>
                      <span>{ttlLabel(e, tr)}</span>
                      <span>{ageLabel(e.createdAt, tr)}</span>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </ScrollArea>
    </div>
  );
}

export default MemoryScene;
