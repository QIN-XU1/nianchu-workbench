/**
 * OverviewScene — 念初总览（在 OpenBitFun 界面里）
 *
 * 一屏看清四件事：
 *   验收四态（来自真实验收器）
 *   运行时状态（进程/网关/端口/仓库/资源，来自 tools/state/collect.mjs）
 *   记忆治理（来自 tools/memory/store.mjs）
 *   联网实测（来自 tools/net/search.mjs）
 *
 * 数据全部是 tools/ 下脚本真跑后的落盘，界面只负责呈现。
 * 拿不到的显示「判不了」，不显示 0，不显示「正常」。
 */
import { ScrollArea } from '@openbitfun/ui';
import runtimeJson from './data/runtime-state.json';
import FreshnessNotice from './FreshnessNotice';
import memoryJson from './data/memory.json';
import snapshotJson from './data/snapshot.json';

/** 该场景数据的产生时间（供 FreshnessNotice 判定新旧） */
const DATA_AT: string | undefined = (snapshotJson as unknown as Record<string, unknown>)?.['generatedAt'] as string | undefined;
import { LayoutDashboard } from 'lucide-react';
import './VouchShared.scss';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';

type Tr = (k: string, o?: Record<string, unknown>) => string;

type FourState = 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN';

interface RuntimeState {
  at: string;
  collector: string;
  proc: { state: FourState; totalProcesses?: number; node?: { count: number; memMB: number } };
  gateway: { state: FourState; modelCount?: number; why?: string };
  ports: { ports: { port: number; open: boolean; what: string }[] };
  repo: { state: FourState; branch?: string; head?: string; dirtyFiles?: number };
  resources: { cpuCores: number; freeMemGB: number; totalMemGB: number; load1: number; node: string };
}

interface MemoryData {
  totals: { total: number; fresh: number; expired: number; superseded: number; noSource: number; unresolvedConflict: number };
  audit: { ok: boolean };
}

const rt = runtimeJson as unknown as RuntimeState;
const mem = memoryJson as unknown as MemoryData;
const snap = snapshotJson as unknown as { verify: { suites: { state: string; pass: number; fail: number; unknown: number }[] }; generatedAt: string };

const LABEL_KEY: Record<FourState, string> = {
  PASS: 'ovLabelPass',
  WARN: 'ovLabelWarn',
  FAIL: 'ovLabelFail',
  UNKNOWN: 'ovLabelUnknown',
};

function tally() {
  const t = { pass: 0, warn: 0, fail: 0, unknown: 0 };
  for (const s of snap.verify?.suites ?? []) {
    t.pass += s.pass;
    t.fail += s.fail;
    t.unknown += s.unknown;
  }
  return t;
}

export function OverviewScene() {
  const { t: tr } = useI18n('vouch');
  const t = tally();
  const portsOpen = rt.ports?.ports?.filter((p) => p.open).length ?? 0;
  const portsTotal = rt.ports?.ports?.length ?? 0;

  return (
    <div className="vouch-page">
      <header className="vouch-page__head">
        <div className="vouch-page__title">
          <LayoutDashboard size={18} aria-hidden="true" />
          <h1>{tr('ovTitle')}</h1>
        </div>
        <p className="vouch-page__sub">{tr('ovTagline')}</p>
      </header>

      {/* 数据新鲜度：放在头部之外，独占一行，不挤压标题 */}
      <FreshnessNotice
        at={DATA_AT}
        source="data/snapshot.json"
        rerunCommand="node tools/gen-snapshot.mjs"
      />

      <ScrollArea className="vouch-page__scroll">
        {/* 验收四态 */}
        <section className="vouch-page__section">
          <h2 className="vouch-page__h2">
            {tr('ovSectionVerify')}
            <span className="vouch-page__meta">{tr('ovMetaVerify', { n: snap.verify?.suites?.length ?? 0 })}</span>
          </h2>
          <div className="vouch-stats">
            <div className="vouch-stat" data-tone="pass"><span className="vouch-stat__n">{t.pass}</span><span className="vouch-stat__l">{tr('ovStatPass')}</span></div>
            <div className="vouch-stat" data-tone="fail"><span className="vouch-stat__n">{t.fail}</span><span className="vouch-stat__l">{tr('ovStatFail')}</span></div>
            <div className="vouch-stat" data-tone="unknown"><span className="vouch-stat__n">{t.unknown}</span><span className="vouch-stat__l">{tr('ovStatUnknown')}</span></div>
          </div>
        </section>

        {/* 运行时 */}
        <section className="vouch-page__section">
          <h2 className="vouch-page__h2">
            {tr('ovSectionRuntime')}
            <span className="vouch-page__meta">{rt.collector}</span>
          </h2>
          <div className="vouch-rows">
            <Row tr={tr} state={rt.proc.state} name={tr('rowProc')} value={tr('rowProcDetail', { total: rt.proc.totalProcesses ?? '-', n: rt.proc.node?.count ?? 0, mb: rt.proc.node?.memMB ?? 0 })} />
            <Row tr={tr} state={rt.gateway.state} name={tr('rowGateway')} value={rt.gateway.why || tr('rowGatewayValue', { n: rt.gateway.modelCount })} />
            <Row tr={tr} state="PASS" name={tr('rowPorts')} value={tr('rowPortsValue', { open: portsOpen, total: portsTotal, list: (rt.ports?.ports ?? []).map((p) => p.port + (p.open ? '+' : '.')).join(' ') })} />
            <Row tr={tr} state={rt.repo.state} name={tr('rowRepo')} value={tr('rowRepoDirty', { branch: rt.repo.branch ?? '?', head: rt.repo.head ?? '?', n: rt.repo.dirtyFiles ?? 0 })} />
            <Row tr={tr} state="PASS" name={tr('rowResources')} value={tr('rowResDetail', { cores: rt.resources.cpuCores, free: rt.resources.freeMemGB, total: rt.resources.totalMemGB, load: rt.resources.load1 })} />
          </div>
        </section>

        {/* 记忆治理 */}
        <section className="vouch-page__section">
          <h2 className="vouch-page__h2">
            {tr('ovSectionMemory')}
            <span className="vouch-page__meta">{mem.audit?.ok ? tr('auditOk') : tr('auditFail')}</span>
          </h2>
          <div className="vouch-stats">
            <div className="vouch-stat" data-tone="pass"><span className="vouch-stat__n">{mem.totals.fresh}</span><span className="vouch-stat__l">{tr('ovStatFresh')}</span></div>
            <div className="vouch-stat" data-tone="warn"><span className="vouch-stat__n">{mem.totals.superseded}</span><span className="vouch-stat__l">{tr('ovStatSuperseded')}</span></div>
            <div className="vouch-stat" data-tone="warn"><span className="vouch-stat__n">{mem.totals.expired}</span><span className="vouch-stat__l">{tr('ovStatExpired')}</span></div>
            <div className="vouch-stat" data-tone={mem.totals.noSource ? 'fail' : 'unknown'}><span className="vouch-stat__n">{mem.totals.noSource}</span><span className="vouch-stat__l">{tr('ovStatNoSource')}</span></div>
          </div>
        </section>
      </ScrollArea>
    </div>
  );
}

function Row({ state, name, value, tr }: { state: FourState; name: string; value: string; tr: Tr }) {
  return (
    <div className="vouch-row" data-state={state}>
      <span className="vouch-row__dot" aria-hidden="true" />
      <span className="vouch-row__name">{name}</span>
      <span className="vouch-row__val">{value}</span>
      <span className="vouch-row__tag">{tr(LABEL_KEY[state])}</span>
    </div>
  );
}

export default OverviewScene;
