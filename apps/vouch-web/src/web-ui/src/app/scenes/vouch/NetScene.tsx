/**
 * NetScene — 联网（在 OpenBitFun 界面里）
 *
 * 显示的是**真实发生过的**搜索与抓取结果（tools/net/gen-ui-data.mjs 生成）。
 * 四态纪律照旧：连不上就显示「判不了」，不显示假结果。
 */
import { ScrollArea } from '@openbitfun/ui';
import netJson from './data/net.json';

/** 该场景数据的产生时间（供 FreshnessNotice 判定新旧） */
const DATA_AT: string | undefined = (netJson as unknown as Record<string, unknown>)?.['at'] as string | undefined;
import FreshnessNotice from './FreshnessNotice';
import { Globe } from 'lucide-react';
import './VouchShared.scss';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';

type Tr = (k: string, o?: Record<string, unknown>) => string;

type FourState = 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN';

interface NetData {
  at: string;
  rule: string;
  search: {
    state: FourState;
    query: string;
    endpoint: string;
    why: string;
    results: { url: string; title: string; snippet: string; host: string }[];
  };
  fetch: { state: FourState; url: string; why: string; title: string; chars: number; excerpt: string };
  backends: { name: string; url: string; state: FourState; note: string }[];
}

const net = netJson as unknown as NetData;

const LABEL_KEY: Record<FourState, string> = {
  PASS: 'statePass',
  WARN: 'stateWarn',
  FAIL: 'stateFail',
  UNKNOWN: 'stateUnknown',
};
const TONE: Record<FourState, string> = { PASS: 'pass', WARN: 'warn', FAIL: 'fail', UNKNOWN: 'unknown' };

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
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

export function NetScene() {
  const { t: tr } = useI18n('vouch');
  const s = net.search;
  const f = net.fetch;
  const reachable = net.backends.filter((b) => b.state === 'PASS').length;
  const host = s.endpoint.replace(/^https?:\/\//, '').split('/')[0];

  return (
    <div className="vouch-page">
      <header className="vouch-page__head">
        <div className="vouch-page__title">
          <Globe size={18} aria-hidden="true" />
          <h1>{tr('netTitle')}</h1>
        </div>
        <p className="vouch-page__sub">{net.rule}</p>
      </header>

            {/* 数据新鲜度：头部之外独占一行，不挤压标题 */}
            <FreshnessNotice
              at={DATA_AT}
              source="data/net.json"
              rerunCommand="node tools/net/collect.mjs"
            />

      <ScrollArea className="vouch-page__scroll">
        <section className="vouch-page__section">
          <h2 className="vouch-page__h2">
            {tr('netSectionOverview')}
            <span className="vouch-page__meta">{tr('netMetaCollected', { at: ageLabel(net.at, tr) })}</span>
          </h2>
          <div className="vouch-stats">
            <div className="vouch-stat" data-tone={TONE[s.state]}><span className="vouch-stat__n">{s.results.length}</span><span className="vouch-stat__l">{tr('netStatSearch')}</span></div>
            <div className="vouch-stat" data-tone={TONE[f.state]}><span className="vouch-stat__n">{f.chars}</span><span className="vouch-stat__l">{tr('netStatFetched')}</span></div>
            <div className="vouch-stat" data-tone="unknown"><span className="vouch-stat__n">{reachable}/{net.backends.length}</span><span className="vouch-stat__l">{tr('netStatBackends')}</span></div>
          </div>
        </section>

        <section className="vouch-page__section">
          <h2 className="vouch-page__h2">
            {tr('netSectionSearch')}
            <span className="vouch-page__meta">{tr('netMetaQuery', { q: s.query, host })}</span>
          </h2>
          <p className="vouch-note" data-tone={TONE[s.state]}>
            <strong>{tr(LABEL_KEY[s.state])}</strong> — {s.why}
          </p>
          {s.results.length === 0 ? (
            <p className="vouch-note" data-tone="warn">
              <strong>{tr('netNoResult')}</strong>
              <br />
              {s.state === 'UNKNOWN'
                ? tr('netUnreachable')
                : tr('netZeroParsed')}
            </p>
          ) : (
            <ul className="vouch-list">
              {s.results.map((r) => (
                <li className="vouch-list__item" key={r.url}>
                  <a className="vouch-hit__title" href={r.url} target="_blank" rel="noreferrer noopener">{r.title}</a>
                  <div className="vouch-hit__host">{hostOf(r.url)}</div>
                  {r.snippet && <p className="vouch-hit__snippet">{r.snippet}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="vouch-page__section">
          <h2 className="vouch-page__h2">
            {tr('netSectionFetch')}
            <span className="vouch-page__meta">{tr('netFetchHint')}</span>
          </h2>
          <p className="vouch-note" data-tone={TONE[f.state]}>
            <strong>{f.title || f.url}</strong>
            <br />
            {f.why} · {f.url}
          </p>
          {f.excerpt ? (
            <pre className="vouch-excerpt">{f.excerpt}</pre>
          ) : (
            <p className="vouch-note" data-tone="warn"><strong>{tr('netNoBody')}</strong> — {f.why}</p>
          )}
        </section>

        <section className="vouch-page__section">
          <h2 className="vouch-page__h2">
            {tr('netSectionBackend')}
            <span className="vouch-page__meta">{tr('netBackendHint')}</span>
          </h2>
          <div className="vouch-rows">
            {net.backends.map((b) => (
              <div className="vouch-row" data-state={b.state} key={b.name}>
                <span className="vouch-row__dot" aria-hidden="true" />
                <span className="vouch-row__name">{b.name}</span>
                <span className="vouch-row__val">{b.note}</span>
                <span className="vouch-row__tag">{tr(LABEL_KEY[b.state])}</span>
              </div>
            ))}
          </div>
        </section>
      </ScrollArea>
    </div>
  );
}

export default NetScene;
