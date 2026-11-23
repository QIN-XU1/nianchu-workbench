/**
 * 场景网格渲染器 + 面板类型注册表
 *
 * 规则出处见 ./config.ts 头部（luanyujia-workbench 01-场景模式）。
 * 本文件负责：把一份 SceneConfig 画成 CSS Grid，并按 `type` 找渲染器。
 *
 * ⚠ 诚实边界：注册表里每种 type 都必须**显示真实数据**或**如实说明它缺什么**，
 * 不允许「看起来有实际是空」。未注册的 type 显示灰字「未知面板类型」，不报错不崩
 * （这是照搬原文 §5 第 2 条的行为）。
 */
import { useEffect, useRef, useState } from 'react';
import type { PanelConfig, SceneConfig } from './config';
import { resolveCols, gridStyleOf } from './config';
// 六件套第 ⑥ 件：身份索引（由 tools/gen-scene-identity.py 从真实数据生成）
import identityJson from './identity.json';
import BenchmarkScene from '../../benchmark/BenchmarkScene';

type IdentityRow = {
  sceneId: string; panelId: string; panelTitle: string;
  sessionTitle: string; sessionId: string | null; contextCard: string; skill: string;
};
const IDENTITY: IdentityRow[] = (identityJson as { rows: IdentityRow[] }).rows;
const lookupIdentity = (sceneId: string, panelId: string) =>
  IDENTITY.find((r) => r.panelId === panelId) ?? IDENTITY.find((r) => r.sceneId === sceneId) ?? null;

/** 面板渲染器拿到的上下文（真实数据从这里来） */
export type PanelCtx = {
  scene: SceneConfig;
  panel: PanelConfig;
  /** 打开某个文件/对象（由外层决定去哪） */
  open?: (ref: string) => void;
};

export type PanelRenderer = (ctx: PanelCtx) => React.ReactNode;

const Gray = ({ children }: { children: React.ReactNode }) => (
  <div className="wb-pg__gray">{children}</div>
);

// ── 通用族：dash（KPI 卡片）──
const DashPanel: PanelRenderer = ({ panel }) => {
  const cards = (panel.cards as Array<{ label: string; value: string | number; hint?: string; tone?: string }>) ?? [];
  if (!cards.length) return <Gray>这个面板没配 cards</Gray>;
  return (
    <div className="wb-pg__dash">
      {cards.map((c) => (
        <div key={c.label} className="wb-pg__kpi" data-tone={c.tone ?? 'neutral'}>
          <div className="wb-pg__kpi-v">{c.value}</div>
          <div className="wb-pg__kpi-l">{c.label}</div>
          {c.hint && <div className="wb-pg__kpi-h">{c.hint}</div>}
        </div>
      ))}
    </div>
  );
};

// ── 通用族：view（阅读器）──
const ViewPanel: PanelRenderer = ({ panel }) => {
  const text = panel.text as string | undefined;
  if (!text) return <Gray>这个面板没配 text（阅读器需要有内容才显示）</Gray>;
  return <pre className="wb-pg__text">{text}</pre>;
};

// ── 通用族：list（列表）──
const ListPanel: PanelRenderer = ({ panel, open }) => {
  const items = (panel.items as Array<{ id: string; label: string; right?: string | number }>) ?? [];
  if (!items.length) return <Gray>这个面板没配 items</Gray>;
  return (
    <div className="wb-pg__list">
      {items.map((it) => (
        <button key={it.id} className="wb-pg__item" onClick={() => open?.(it.id)}>
          <span className="wb-pg__item-l">{it.label}</span>
          {it.right != null && <span className="wb-pg__item-r">{it.right}</span>}
        </button>
      ))}
    </div>
  );
};

// ── 通用族：reserved（预留占位）──
const ReservedPanel: PanelRenderer = ({ panel }) => (
  <Gray>{(panel.hint as string) ?? '预留位（版式先定，功能后补）'}</Gray>
);

// ── 通用族：harness（AI 会话面板）──
const HarnessPanel: PanelRenderer = ({ panel, scene }) => {
  // 六件套第 ⑥ 件：**查表认领身份**，不在提示词里写「你是 XX 场景」
  const row = lookupIdentity(scene.id, panel.id);
  const sessionId = row?.sessionId ?? (panel.sessionId as string | null) ?? null;
  const dash = '—（未绑定）';
  return (
    <div className="wb-pg__harness">
      <div className="wb-pg__kv"><span>场景 id</span><b>{row?.sceneId ?? scene.id}</b></div>
      <div className="wb-pg__kv"><span>面板 id</span><b>{row?.panelId ?? panel.id}</b></div>
      <div className="wb-pg__kv"><span>会话名</span><b>{row?.sessionTitle ?? scene.name}</b></div>
      <div className="wb-pg__kv"><span>会话 id</span><b>{sessionId ?? dash}</b></div>
      <div className="wb-pg__kv"><span>定位卡</span><b>{row?.contextCard ?? dash}</b></div>
      <div className="wb-pg__kv"><span>主技能</span><b>{row?.skill ?? dash}</b></div>
      <div className="wb-pg__note">
        以上六行来自 <b>scenes/_身份索引.md</b>（七列表，六件套第 ⑥ 件）。
        {sessionId
          ? '会话已绑定。真正的对话流在宿主里，这个面板只显示身份与绑定信息。'
          : '会话还没绑定 —— 所以「会话 id」如实显示未绑定，不编造 UUID。绑定后这里会显示该会话的对话流。'}
      </div>
    </div>
  );
};

// ── 数据族：table（真表格）──
const TablePanel: PanelRenderer = ({ panel }) => {
  const cols = (panel.columns as string[]) ?? [];
  const rows = (panel.rows as Array<Array<string | number>>) ?? [];
  if (!cols.length) return <Gray>这个面板没配 columns</Gray>;
  return (
    <div className="wb-pg__table-wrap">
      <table className="wb-pg__table">
        <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <Gray>还没有数据行</Gray>}
    </div>
  );
};

// ══════════════════════════════════════════════════════════
// 以下 4 种照搬 luanyujia-workbench 的面板族
//   D:/refs/luanyujia/luanyujia-workbench-main/01-场景模式/面板类型总览.md
//   · file  —— 文件管理（通用族，与 view 天然一对：file.viewPanel 指向 view 的 id）
//   · chart —— 趋势图（数据族）
//   · embed —— 嵌一个网页（通用族）
//   · flow  —— 节点画布（流程图族）
// 原文强调：view + file 是**整套壳里复用率最高的搭配**，所以优先补这一对。
// ══════════════════════════════════════════════════════════

// ── 通用族：file（文件管理）──
const FilePanel: PanelRenderer = ({ panel, open }) => {
  const rows = (panel.rows as Array<{ name: string; size?: string; kind?: 'dir' | 'file' }>) ?? [];
  if (!rows.length) return <Gray>这个面板没配 rows（文件树需要真实条目）</Gray>;
  return (
    <div className="wb-pg__list">
      {rows.map((r) => (
        <button key={r.name} className="wb-pg__item" onClick={() => open?.(r.name)}>
          <span className="wb-pg__item-l">
            <span className="wb-pg__fileicon" data-kind={r.kind ?? 'file'}>{r.kind === 'dir' ? '▸' : '·'}</span>
            {r.name}
          </span>
          {r.size && <span className="wb-pg__item-r">{r.size}</span>}
        </button>
      ))}
    </div>
  );
};

// ── 数据族：chart（趋势图，纯 SVG，无依赖）──
const ChartPanel: PanelRenderer = ({ panel }) => {
  const series = (panel.series as number[]) ?? [];
  const labels = (panel.labels as string[]) ?? [];
  if (series.length < 2) return <Gray>这个面板没配 series（至少 2 个点才画得出趋势）</Gray>;
  const w = 320;
  const h = 96;
  const max = Math.max(...series);
  const min = Math.min(...series);
  const span = max - min || 1;
  const pts = series.map((v, i) => {
    const x = (i / (series.length - 1)) * (w - 8) + 4;
    const y = h - 6 - ((v - min) / span) * (h - 18);
    return [x, y] as const;
  });
  const d = pts.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)).join(' ');
  return (
    <div className="wb-pg__chart">
      <svg viewBox={'0 0 ' + w + ' ' + h} preserveAspectRatio="none" className="wb-pg__chart-svg">
        <path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        {pts.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="2" fill="currentColor" />
        ))}
      </svg>
      <div className="wb-pg__chart-foot">
        <span>{labels[0] ?? '起点'}</span>
        <span className="wb-pg__chart-range">{min} → {max}</span>
        <span>{labels[labels.length - 1] ?? '现在'}</span>
      </div>
    </div>
  );
};

// ── 通用族：embed（嵌一个网页）──
const EmbedPanel: PanelRenderer = ({ panel }) => {
  const url = panel.url as string | undefined;
  if (!url) return <Gray>这个面板没配 url</Gray>;
  return (
    <div className="wb-pg__embed">
      <div className="wb-pg__embed-bar">
        <span className="wb-pg__embed-url">{url}</span>
        <a className="wb-pg__embed-open" href={url} target="_blank" rel="noreferrer">在浏览器中打开</a>
      </div>
      <iframe className="wb-pg__embed-frame" src={url} title={url} sandbox="allow-same-origin allow-scripts allow-popups" />
    </div>
  );
};

// ── 流程图族：flow（节点画布）──
const FlowPanel: PanelRenderer = ({ panel, open }) => {
  const nodes = (panel.nodes as Array<{ id: string; label: string; x: number; y: number; tone?: string }>) ?? [];
  const edges = (panel.edges as Array<{ from: string; to: string }>) ?? [];
  if (!nodes.length) return <Gray>这个面板没配 nodes</Gray>;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (
    <div className="wb-pg__flow">
      <svg viewBox="0 0 320 160" className="wb-pg__flow-svg">
        {edges.map((e, i) => {
          const a = byId.get(e.from);
          const b = byId.get(e.to);
          if (!a || !b) return null;
          return (
            <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke="currentColor" strokeOpacity="0.28" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          );
        })}
        {nodes.map((n) => (
          <g key={n.id} className="wb-pg__flow-node" data-tone={n.tone ?? 'neutral'}
            onClick={() => open?.(n.id)} role="button">
            <circle cx={n.x} cy={n.y} r="5" fill="currentColor" />
            <text x={n.x} y={n.y - 9} textAnchor="middle" fontSize="var(--openbitfun-type-micro-font-size)" fill="currentColor">{n.label}</text>
          </g>
        ))}
      </svg>
    </div>
  );
};

// ══════════════════════════════════════════════════════════
// 电脑族四件套 —— 照搬 luanyujia 面板类型总览.md
//   pc-drives / pc-toplarge / pc-junk / pc-ledger
// 原文：「这一族的价值不在'好看'，在于把'该不该清'从口头判断变成看板数字。」
// 数据来自 tools/pc/scan.mjs（只读，不删任何东西）。
// ══════════════════════════════════════════════════════════

type DriveRow = { root: string; totalGB: number | null; usedGB: number | null; ratio: number | null; tone: string };

// ── pc-drives（各盘容量，按危险度变色）──
const PcDrivesPanel: PanelRenderer = ({ panel }) => {
  const rows = (panel.drives as DriveRow[]) ?? [];
  if (!rows.length) return <Gray>没配 drives（跑 node tools/pc/scan.mjs 生成）</Gray>;
  return (
    <div className="wb-pg__drives">
      {rows.map((d) => {
        const pct = d.ratio == null ? 0 : Math.round(d.ratio * 100);
        return (
          <div key={d.root} className="wb-pg__drive" data-tone={d.tone}>
            <div className="wb-pg__drive-head">
              <span className="wb-pg__drive-root">{d.root}</span>
              <span className="wb-pg__drive-gb">{d.usedGB == null ? '读不到' : d.usedGB + ' / ' + d.totalGB + ' GB'}</span>
              <span className="wb-pg__drive-pct">{d.ratio == null ? '—' : pct + '%'}</span>
            </div>
            <div className="wb-pg__drive-bar"><i style={{ width: pct + '%' }} /></div>
          </div>
        );
      })}
    </div>
  );
};

// ── pc-toplarge（大户排行）──
const PcTopLargePanel: PanelRenderer = ({ panel }) => {
  const rows = (panel.rows as Array<{ path: string; mb: number; files: number }>) ?? [];
  if (!rows.length) return <Gray>没配 rows</Gray>;
  const max = Math.max(...rows.map((r) => r.mb), 1);
  return (
    <div className="wb-pg__toplarge">
      {rows.map((r) => (
        <div key={r.path} className="wb-pg__toplarge-row">
          <span className="wb-pg__toplarge-name" title={r.path}>{r.path}</span>
          <span className="wb-pg__toplarge-bar"><i style={{ width: Math.round((r.mb / max) * 100) + '%' }} /></span>
          <span className="wb-pg__toplarge-mb">{r.mb} MB</span>
        </div>
      ))}
    </div>
  );
};

// ── pc-junk（可清理项，只报不动手）──
const PcJunkPanel: PanelRenderer = ({ panel }) => {
  const rows = (panel.rows as Array<{ name: string; mb: number; files: number; kind: string }>) ?? [];
  if (!rows.length) return <Gray>没有发现已知缓存型目录</Gray>;
  return (
    <div className="wb-pg__junk">
      {rows.map((r) => (
        <div key={r.name} className="wb-pg__junk-row">
          <span className="wb-pg__junk-name">{r.name}</span>
          <span className="wb-pg__junk-mb">{r.mb} MB</span>
          <span className="wb-pg__junk-kind">{r.kind}</span>
        </div>
      ))}
      <div className="wb-pg__note">本工具**只报大小，不删任何东西** —— 真清理由「本地电脑」场景经跨场景派单执行。</div>
    </div>
  );
};

// ── pc-ledger（清理台账，只追加）──
const PcLedgerPanel: PanelRenderer = ({ panel }) => {
  const rows = (panel.rows as Array<{ at: string; what: string; mb?: number }>) ?? [];
  if (!rows.length) return <Gray>清理台账还是空的（记录只追加，不改历史）</Gray>;
  return (
    <div className="wb-pg__ledger">
      {rows.map((r, i) => (
        <div key={i} className="wb-pg__ledger-row">
          <span className="wb-pg__ledger-at">{String(r.at).slice(0, 10)}</span>
          <span className="wb-pg__ledger-what">{r.what}</span>
          {r.mb != null && <span className="wb-pg__ledger-mb">{r.mb} MB</span>}
        </div>
      ))}
    </div>
  );
};

// ── 协作族：requests（跨场景请求）──
// 照搬 luanyujia 05-协作与规矩/三-跨场景协作.md 的「跨场景派单与回执」。
// 原文规矩：「你只管提请求，别动手」—— 所以这个面板**只读**，不提供任何执行按钮。
const RequestsPanel: PanelRenderer = ({ panel }) => {
  const rows = (panel.rows as Array<{ from: string; to: string; content: string; delivered: string; at: string; parts?: { want?: string; why?: string; when?: string } }>) ?? [];
  if (!rows.length) return <Gray>还没有跨场景请求（tools/collab/request.mjs 会写进 evidence/collab/requests.jsonl）</Gray>;
  return (
    <div className="wb-pg__reqs">
      {rows.map((r, i) => (
        <div key={i} className="wb-pg__req" data-delivered={r.delivered}>
          <div className="wb-pg__req-head">
            <span className="wb-pg__req-route">{r.from} → {r.to}</span>
            <span className="wb-pg__req-state">{r.delivered === 'degraded' ? '已入队·未直达' : r.delivered}</span>
          </div>
          <div className="wb-pg__req-body">{r.content}</div>
          {r.parts && (
            <div className="wb-pg__req-parts">
              <span>要什么：{r.parts?.want || '—'}</span>
              <span>为什么：{r.parts?.why || '—'}</span>
              <span>何时：{r.parts?.when || '—'}</span>
            </div>
          )}
          <div className="wb-pg__req-at">{String(r.at).slice(0, 16).replace('T', ' ')}</div>
        </div>
      ))}
    </div>
  );
};

// ── 协作族：notices（通知看板，超级通道）──
// 照搬 luanyujia §四 ★：「做底层改动的人不必再逐个场景打招呼；被影响的人先看这个看板。」
const NoticesPanel: PanelRenderer = ({ panel }) => {
  const rows = (panel.rows as Array<{ content: string; affected: string[]; at: string; delivered: string }>) ?? [];
  if (!rows.length) return <Gray>还没有通知（tools/collab/notify.mjs 会写进 notice-board.json）</Gray>;
  return (
    <div className="wb-pg__notices">
      {rows.map((r, i) => (
        <div key={i} className="wb-pg__notice" data-delivered={r.delivered}>
          <div className="wb-pg__notice-body">{r.content}</div>
          <div className="wb-pg__notice-foot">
            <span className="wb-pg__notice-to">{r.affected.join('、')}</span>
            <span className="wb-pg__notice-at">{String(r.at).slice(5, 16).replace('T', ' ')}</span>
          </div>
        </div>
      ))}
    </div>
  );
};

// ── 协作族：receipts（回执）──
// 照搬 §四「干完活必须写回」：新决策 / 进度 / 新坑 三类。
const ReceiptsPanel: PanelRenderer = ({ panel }) => {
  const rows = (panel.rows as Array<{ reqId?: string; from?: string; kind?: string; note?: string; at?: string }>) ?? [];
  if (!rows.length) {
    return (
      <Gray>
        还没有回执。照搬原文「干完活必须写回」：承接方干完要追加一条
        （decision 新决策 / progress 进度 / pitfall 新坑）。
      </Gray>
    );
  }
  return (
    <div className="wb-pg__receipts">
      {rows.map((r, i) => (
        <div key={i} className="wb-pg__receipt" data-kind={r.kind ?? 'progress'}>
          <span className="wb-pg__receipt-kind">{r.kind ?? 'progress'}</span>
          <span className="wb-pg__receipt-note">{r.note ?? r.reqId ?? ''}</span>
        </div>
      ))}
    </div>
  );
};

// ── 标杆族：benchmark（22 个参照项目的拆解）──
// 【2026-11-18 用户要求】标杆从独立场景标签移进「场景」里，
// 作为某个场景的一整块面板显示，而不是再占一个顶层标签。
const BenchmarkPanel: PanelRenderer = () => (
  <div className="wb-pg__bench">
    <BenchmarkScene />
  </div>
);

/** 面板类型注册表 —— 没注册的 type 走 UnknownPanel（照搬原文行为） */
export const PANEL_TYPES: Record<string, PanelRenderer> = {
  dash: DashPanel,
  view: ViewPanel,
  list: ListPanel,
  reserved: ReservedPanel,
  harness: HarnessPanel,
  table: TablePanel,
  // 照搬 luanyujia 的 4 族
  file: FilePanel,
  chart: ChartPanel,
  embed: EmbedPanel,
  flow: FlowPanel,
  // 协作族
  requests: RequestsPanel,
  notices: NoticesPanel,
  receipts: ReceiptsPanel,
  // 标杆族
  benchmark: BenchmarkPanel,
  // 电脑族四件套（照搬 luanyujia）
  'pc-drives': PcDrivesPanel,
  'pc-toplarge': PcTopLargePanel,
  'pc-junk': PcJunkPanel,
  'pc-ledger': PcLedgerPanel,
};

const UnknownPanel: PanelRenderer = ({ panel }) => (
  <Gray>未知面板类型: {panel.type}（在 PANEL_TYPES 里注册一个渲染器即可）</Gray>
);

// ══════════════════════════════════════════════════════════
// 网格
// ══════════════════════════════════════════════════════════

type GridProps = {
  scene: SceneConfig;
  open?: (ref: string) => void;
  /** 把越界告警抛给外层（外层负责 console.warn / 显示） */
  onWarnings?: (w: string[]) => void;
};

export function SceneGrid({ scene, open, onWarnings }: GridProps) {
  const { cols, warnings } = resolveCols(scene);
  const [expanded, setExpanded] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    onWarnings?.(warnings);
    if (warnings.length) for (const w of warnings) console.warn('[scene] ' + w);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene.id]);

  // ESC 收起（照搬「再点一次收起，ESC 也能收」）
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  return (
    <div
      className="wb-pg"
      ref={gridRef}
      data-scene={scene.id}
      data-cols={cols}
      style={{ ['--wb-pg-cols' as string]: String(cols) }}
    >
      {scene.panels.map((p, index) => {
        const Renderer = PANEL_TYPES[p.type] ?? UnknownPanel;
        const isExpanded = expanded === p.id;
        const canExpand = p.expand === true || p.type === 'harness';
        return (
          <section
            key={p.id}
            className={'wb-pg__panel' + (isExpanded ? ' is-expanded' : '')}
            style={gridStyleOf(p)}
            data-panel={p.id}
            data-type={p.type}
          >
            <header className="wb-pg__head">
              <span className="wb-pg__no">{String(index + 1).padStart(2, '0')}</span>
              <span className="wb-pg__title">{p.title}</span>
              {p.sub && <span className="wb-pg__sub">{p.sub}</span>}
              {canExpand && (
                <button
                  className="wb-pg__expand"
                  onClick={() => setExpanded(isExpanded ? null : p.id)}
                  title={isExpanded ? '收起（ESC）' : '展开到最高'}
                >
                  {isExpanded ? '▼' : '▲'}
                </button>
              )}
            </header>
            <div className="wb-pg__body">
              <Renderer scene={scene} panel={p} open={open} />
            </div>
          </section>
        );
      })}
    </div>
  );
}

export default SceneGrid;
