/**
 * BenchmarkScene — 标杆盘点：22 个参照项目的拆解
 *
 * 这个场景回答一个问题：**我们要超过的是什么，凭什么超过**。
 *
 * 数据分两层：
 *   measured  本地源码实测（文件数/体量/语言/目录骨架）—— tools/benchmark/survey.mjs 自己数出来的
 *   analysis  人写的拆解（优势/缺点/可照搬/要超过）—— 必须建立在看过源码之上
 *
 * 为什么把「缺点」和「要超过」放在显眼位置：
 * 只列别人的优点会变成抄作业。要看清它的局限，才知道我们的机会在哪。
 *
 * 【2026-11-23 批次 Z.29】两类东西被混在一页里，是这一页一直不好看的根因：
 *   ① 「单个项目」的详情 —— 一次只看一个，需要列表 + 详情两栏；
 *   ② 「项目之间」的横向对比 —— 4 张表天生要整宽，塞进详情栏只能横向滚。
 *   上一版把这 4 张表**塞进了左侧项目列表的滚动区**（结构性错误：列表越滚越长，
 *   详情栏被挤成 300px），所以拆成两个视图，各用各的版式。
 */
import { useMemo, useState } from 'react';
import { ScrollArea } from '@openbitfun/ui';
import { Search, Layers, ExternalLink, AlertTriangle, Target, Copy, FolderOpen, Table2 } from 'lucide-react';
import projectsJson from './data/projects.json';
import FreshnessNotice from '@/app/scenes/vouch/FreshnessNotice';
import analysisJson from './data/analysis.json';
import timelineJson from './data/repo-timeline.json';
import fixJson from './data/fix-anatomy.json';
import docsJson from './data/docs.json';
import rdJson from './data/commit-readability.json';
import './BenchmarkScene.scss';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';

interface Measured {
  files: number;
  mb: number;
  languages: { lang: string; files: number }[];
  mainLang: string | null;
  topDirs: { dir: string; files: number }[];
  keyFiles: { name: string; bytes: number }[];
  truncated: boolean;
}

interface AnalysisBlock {
  arch?: string[];
  exec?: string[];
  features?: string[];
  ui?: string[];
  strengths?: string[];
  weaknesses?: string[];
  borrow?: string[];
  surpass?: string[];
}

interface Project {
  id: string;
  name: string;
  repo: string;
  local: string | null;
  kind: 'oss' | 'closed' | 'spec';
  tier: 'fork' | 'learn' | 'study';
  tagline: string;
  note: string;
  measured: Measured | null;
  analysis?: AnalysisBlock;
}

const PROJECTS_META = projectsJson as unknown as { at?: string };
const projects = (projectsJson as unknown as { projects: Project[] }).projects;
const analysis = analysisJson as unknown as { byId: Record<string, AnalysisBlock> };
// Iteration timeline (real fetch result from tools/benchmark/repo-timeline.mjs)
interface TlSummary { count: number; spanDays: number; byKind: Record<string, number>; last: string | null }
interface TlRepo { id: string; label: string; state: string; why?: string; stale?: boolean; summary?: TlSummary }
const timelineRepos = (timelineJson as unknown as { repos: TlRepo[] }).repos || [];
// Fix content breakdown (tools/benchmark/fix-anatomy.mjs)
interface FaDist { n: number; pct: number }
interface FaConc { scopeKinds: number; topScope: string; topPct: number; entropy: number }
interface FaRepo { slug: string; ok: boolean; total?: number; dist?: Record<string, FaDist>; conc?: FaConc; why?: string }
const fixRepos = (fixJson as unknown as { repos: Record<string, FaRepo> }).repos || {};
// Deep-read documents inventory (generated alongside the analysis)
interface DocEntry { name: string; kb: number }
const docsInv = docsJson as unknown as { total: number; totalKB: number; docs: DocEntry[] };
// Commit format (project property) vs classifier coverage (tool property)
interface RdRepo { id: string; label: string; state: string; ccRate?: number; scopeRate?: number; formatLabel?: string; covLabel?: string; covNote?: string }
const rdRepos = (rdJson as unknown as { repos: RdRepo[] }).repos || [];

const TIER_LABEL_KEY: Record<string, string> = {
  fork: 'tierFork',
  learn: 'tierLearn',
  study: 'tierStudy',
};

const KIND_LABEL_KEY: Record<string, string> = {
  oss: 'kindOss',
  closed: 'kindClosed',
  spec: 'kindSpec',
};

const SECTIONS: { key: keyof AnalysisBlock; labelKey: string; tone: string; icon: typeof Layers }[] = [
  { key: 'arch', labelKey: 'secArch', tone: 'neutral', icon: Layers },
  { key: 'exec', labelKey: 'secExec', tone: 'neutral', icon: Layers },
  { key: 'features', labelKey: 'secFeatures', tone: 'neutral', icon: Layers },
  { key: 'ui', labelKey: 'secUi', tone: 'neutral', icon: Layers },
  { key: 'strengths', labelKey: 'secStrengths', tone: 'pass', icon: Target },
  { key: 'weaknesses', labelKey: 'secWeaknesses', tone: 'fail', icon: AlertTriangle },
  { key: 'borrow', labelKey: 'secBorrow', tone: 'warn', icon: Copy },
  { key: 'surpass', labelKey: 'secSurpass', tone: 'accent', icon: Target },
];

/** 一页里的两个视图：看单个项目，还是横着比 */
type BenchView = 'projects' | 'compare';

export function BenchmarkScene() {
  const { t: tt } = useI18n('vouch');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string>('openbitfun');
  const [view, setView] = useState<BenchView>('projects');

  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return projects;
    return projects.filter((p) =>
      p.name.toLowerCase().includes(k) ||
      p.tagline.toLowerCase().includes(k) ||
      p.note.toLowerCase().includes(k) ||
      (p.measured?.mainLang ?? '').toLowerCase().includes(k),
    );
  }, [q]);

  const cur = projects.find((p) => p.id === selected) ?? projects[0];
  const a = analysis.byId?.[cur.id] ?? cur.analysis ?? {};

  return (
    <div className="bench">
      <header className="bench__head">
        <div className="bench__title">
          <Layers size={18} aria-hidden="true" />
          <h1>{tt('title')}</h1>
          <FreshnessNotice at={PROJECTS_META.at} source="data/projects.json" rerunCommand="node tools/benchmark/survey.mjs" />
        </div>
        <div className="bench__head-row">
          <p className="bench__sub">
            {tt('metaSummary', {
              total: projects.length,
              measured: projects.filter((p) => p.measured).length,
              closed: projects.filter((p) => p.kind === 'closed').length,
            })}
          </p>
          <div className="bench__views" role="tablist" aria-label={tt('viewsAria')}>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'projects'}
              data-on={view === 'projects' ? '1' : '0'}
              data-bench-view="projects"
              onClick={() => setView('projects')}
            >
              <FolderOpen size={13} aria-hidden="true" />
              {tt('viewProjects')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'compare'}
              data-on={view === 'compare' ? '1' : '0'}
              data-bench-view="compare"
              onClick={() => setView('compare')}
            >
              <Table2 size={13} aria-hidden="true" />
              {tt('viewCompare')}
            </button>
          </div>
        </div>
      </header>

      {view === 'projects' ? (
        <div className="bench__body">
          {/* 左：项目列表 */}
          <aside className="bench__list">
            <label className="bench__search">
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={tt('searchPlaceholder')}
                aria-label={tt('searchAria')}
              />
            </label>
            <ScrollArea className="bench__list-scroll">
              {filtered.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="bench__item"
                  data-active={p.id === cur.id}
                  onClick={() => setSelected(p.id)}
                >
                  <span className="bench__item-name">{p.name}</span>
                  <span className="bench__item-meta">
                    <span className="bench-tag" data-tone={p.kind === 'oss' ? 'pass' : p.kind === 'closed' ? 'unknown' : 'warn'}>
                      {tt(KIND_LABEL_KEY[p.kind])}
                    </span>
                    <span className="bench-tag" data-tone="accent">{tt(TIER_LABEL_KEY[p.tier])}</span>
                    {p.measured && <span className="bench__item-num">{tt('filesCount', { n: p.measured.files })}</span>}
                  </span>
                  <span className="bench__item-tag">{p.tagline}</span>
                </button>
              ))}
              {filtered.length === 0 && <p className="bench__empty">{tt('emptyNoMatch')}</p>}
            </ScrollArea>
          </aside>

          {/* 右：详情 */}
          <ScrollArea className="bench__detail">
            <div className="bench__detail-head">
              <div>
                <h2 className="bench__h2">{cur.name}</h2>
                <p className="bench__tagline">{cur.tagline}</p>
              </div>
              {cur.repo && (
                <a className="bench__repo" href={cur.repo} target="_blank" rel="noreferrer noopener">
                  {cur.repo.replace(/^https?:\/\/(github\.com\/)?/, '')}
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
              )}
            </div>

            {cur.note && <p className="bench__note">{cur.note}</p>}

            {/* 实测数据 */}
            {cur.measured ? (
              <section className="bench__section">
                <h3 className="bench__h3">
                  {tt('measuredTitle')}
                  <span className="bench__meta">{tt('measuredHint')}</span>
                </h3>
                <div className="bench__stats">
                  <div className="bench__stat">
                    <span className="bench__stat-n">{cur.measured.files}</span>
                    <span className="bench__stat-l">{tt('lblFiles')}</span>
                  </div>
                  <div className="bench__stat">
                    <span className="bench__stat-n">{cur.measured.mb}</span>
                    <span className="bench__stat-l">MB</span>
                  </div>
                  <div className="bench__stat">
                    <span className="bench__stat-n">{cur.measured.mainLang ?? '—'}</span>
                    <span className="bench__stat-l">{tt('lblMainLang')}</span>
                  </div>
                  <div className="bench__stat">
                    <span className="bench__stat-n">{cur.measured.topDirs.length}</span>
                    <span className="bench__stat-l">{tt('lblTopDirs')}</span>
                  </div>
                </div>

                <div className="bench__split">
                  <div>
                    <h4 className="bench__h4">{tt('h4Langs')}</h4>
                    <ul className="bench__bars">
                      {cur.measured.languages.map((l) => {
                        const pct = Math.round((l.files / cur.measured!.files) * 100);
                        return (
                          <li key={l.lang}>
                            <span className="bench__bar-label">{l.lang}</span>
                            <span className="bench__bar"><i style={{ width: pct + '%' }} /></span>
                            <span className="bench__bar-num">{l.files} · {pct}%</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                  <div>
                    <h4 className="bench__h4">{tt('h4Top')}</h4>
                    <ul className="bench__dirs">
                      {cur.measured.topDirs.map((d) => (
                        <li key={d.dir}>
                          <code>{d.dir}</code>
                          <span>{d.files}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {cur.measured.keyFiles.length > 0 && (
                  <>
                    <h4 className="bench__h4">{tt('h4KeyFiles')}</h4>
                    <div className="bench__keys">
                      {cur.measured.keyFiles.map((f) => (
                        <span className="bench__key" key={f.name}>{f.name}</span>
                      ))}
                    </div>
                  </>
                )}
              </section>
            ) : (
              <p className="bench__closed">
                {cur.kind === 'closed'
                  ? tt('noSourceClosed')
                  : tt('noSourceMissing')}
              </p>
            )}

            {/* 拆解 */}
            <section className="bench__section">
              <h3 className="bench__h3">
                {tt('analysisTitle')}
                <span className="bench__meta">{tt('analysisHint')}</span>
              </h3>
              {SECTIONS.map((s) => {
                const items = a[s.key];
                if (!items || items.length === 0) return null;
                const I = s.icon;
                return (
                  <div className="bench__block" data-tone={s.tone} key={s.key}>
                    <h4 className="bench__block-h">
                      <I size={13} aria-hidden="true" />
                      {tt(s.labelKey)}
                    </h4>
                    <ul className="bench__block-list">
                      {items.map((it, i) => <li key={i}>{it}</li>)}
                    </ul>
                  </div>
                );
              })}
              {SECTIONS.every((s) => !a[s.key]?.length) && (
                <p className="bench__pending">
                  {tt('analysisEmpty1')}
                  {tt('analysisEmpty2')}
                </p>
              )}
            </section>
          </ScrollArea>
        </div>
      ) : (
        /* 横向对比：4 张表天生要整宽，单独一屏，不再挤在详情栏里横向滚 */
        <ScrollArea className="bench__compare">
          <div className="bench__compare-inner">
            <p className="bench__compare-hint">{tt('compareHint')}</p>

            {/* Iteration cadence (timeline) -- not a snapshot; what each project is doing now */}
            <section className="bench__section">
              <h3 className="bench__h3">
                {tt('timelineTitle')}
                <span className="bench__meta">{tt('timelineHint')}</span>
              </h3>
              <div className="bench__table-wrap">
                <table className="bench__table">
                  <thead>
                    <tr>
                      <th>{tt('tlRepo')}</th>
                      <th>{tt('tlCount')}</th>
                      <th>{tt('tlSpan')}</th>
                      <th>{tt('tlFix')}</th>
                      <th>{tt('tlFeat')}</th>
                      <th>{tt('tlRefactor')}</th>
                      <th>{tt('tlTest')}</th>
                      <th>{tt('tlOther')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {timelineRepos.map((r) => {
                      const s = r.summary;
                      const pctOf = (k: string) => (s && s.count ? Math.round(((s.byKind[k] || 0) / s.count) * 100) + '%' : '—');
                      return (
                        <tr key={r.id}>
                          <td>{r.label}{r.stale ? ' ⚠' : ''}</td>
                          {s ? (
                            <>
                              <td>{s.count}</td>
                              <td>{s.spanDays}d</td>
                              <td>{pctOf('fix')}</td>
                              <td>{pctOf('feat')}</td>
                              <td>{pctOf('refactor')}</td>
                              <td>{pctOf('test')}</td>
                              <td>{pctOf('other')}</td>
                            </>
                          ) : (
                            <td colSpan={7}>{r.stale ? tt('tlStale') : tt('tlUnknown')}</td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="bench__meta bench__caveat">{tt('tlCaveat')}</p>
            </section>

            {/* What the fixes touch -- fix count alone cannot separate maturity from stagnation */}
            <section className="bench__section">
              <h3 className="bench__h3">
                {tt('fixTitle')}
                <span className="bench__meta">{tt('fixHint')}</span>
              </h3>
              <div className="bench__table-wrap">
                <table className="bench__table">
                  <thead>
                    <tr>
                      <th>{tt('tlRepo')}</th>
                      <th>{tt('tlFix')}</th>
                      <th>{tt('faPolish')}</th>
                      <th>{tt('faRobust')}</th>
                      <th>{tt('faStruct')}</th>
                      <th>{tt('faFeature')}</th>
                      <th>{tt('faOther')}</th>
                      <th>{tt('faScopeKinds')}</th>
                      <th>{tt('faTopShare')}</th>
                      <th>{tt('faConfidence')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(fixRepos).map(([id, r]) => {
                      if (!r.ok || !r.dist) {
                        return (
                          <tr key={id}>
                            <td>{id}</td>
                            <td colSpan={9}>{tt('tlUnknown')}</td>
                          </tr>
                        );
                      }
                      const other = r.dist.other?.pct ?? 0;
                      const conf = other <= 15 ? tt('faConfHigh') : other <= 30 ? tt('faConfLow') : tt('faConfBad');
                      const pc = (k: string) => (r.dist && r.dist[k] ? r.dist[k].pct + '%' : '—');
                      return (
                        <tr key={id}>
                          <td>{id}</td>
                          <td>{r.total}</td>
                          <td>{pc('polish')}</td>
                          <td>{pc('robustness')}</td>
                          <td>{pc('structure')}</td>
                          <td>{pc('featureish')}</td>
                          <td>{pc('other')}</td>
                          <td>{r.conc ? r.conc.scopeKinds : '—'}</td>
                          <td>{r.conc ? r.conc.topPct + '%' : '—'}</td>
                          <td>{conf}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="bench__meta bench__caveat">{tt('faCaveat')}</p>
              <p className="bench__meta bench__caveat">{tt('faConcHint')}</p>
            </section>

            {/* Deep-read documents inventory */}
            <section className="bench__section">
              <h3 className="bench__h3">
                {tt('docTitle')}
                <span className="bench__meta">
                  {tt('docCount', { n: docsInv.total, kb: docsInv.totalKB })} · {tt('docHint')}
                </span>
              </h3>
              <div className="bench__docs">
                {docsInv.docs.map((d) => (
                  <span key={d.name} className="bench__doc">
                    {d.name} <span className="bench__doc-kb">{d.kb}KB</span>
                  </span>
                ))}
              </div>
            </section>

            {/* Commit format vs classifier coverage -- deliberately two separate columns */}
            <section className="bench__section">
              <h3 className="bench__h3">
                {tt('rdTitle')}
                <span className="bench__meta">{tt('rdHint')}</span>
              </h3>
              <div className="bench__table-wrap">
                <table className="bench__table">
                  <thead>
                    <tr>
                      <th>{tt('tlRepo')}</th>
                      <th>{tt('rdCC')}</th>
                      <th>{tt('rdScope')}</th>
                      <th>{tt('rdFormat')}</th>
                      <th>{tt('rdCoverage')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rdRepos.map((r) => (
                      <tr key={r.id}>
                        <td>{r.label}</td>
                        {r.state === 'PASS' ? (
                          <>
                            <td>{r.ccRate}%</td>
                            <td>{r.scopeRate}%</td>
                            <td>{r.formatLabel}</td>
                            <td>{r.covLabel}（{r.covNote}）</td>
                          </>
                        ) : (
                          <td colSpan={4}>{tt('tlUnknown')}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

export default BenchmarkScene;
