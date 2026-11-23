/**
 * D3 运行时状态：把 tools/state/collect.mjs 的真实采集结果显示到界面上
 *
 * 这一层是「自研」的关键证明：之前 D3 记「部分」，因为状态只能从 hermes insights 看。
 * 现在有两条数据通路：
 *   1. 构建期快照  src/data/snapshot.json      （验收侧四态，gen-snapshot.mjs 生成）
 *   2. 运行时状态  src/data/runtime-state.json （进程/网关/端口/仓库/资源，collect.mjs 生成）
 *
 * 纪律：拿不到就显示「判不了」，不显示 0，不显示「正常」。
 */

export type FourState = 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN';

export interface RuntimeState {
  what: string;
  rule: string;
  at: string;
  collector: string;
  proc: {
    state: FourState; why?: string; source?: string;
    totalProcesses?: number;
    node?: { count: number; memMB: number };
    python?: { count: number; memMB: number };
    topMem?: { name: string; memMB: number }[];
  };
  ports: {
    state: FourState;
    ports: { port: number; what: string; open: boolean; state: FourState; why: string }[];
  };
  gateway: {
    state: FourState; why?: string; httpCode?: number;
    modelCount?: number; models?: string[];
  };
  repo: {
    state: FourState; why?: string;
    branch?: string; head?: string; dirtyFiles?: number; lastCommits?: string[];
  };
  suites: {
    state: FourState; why?: string;
    suites?: { name: string; state: FourState; pass?: number; fail?: number; unknown?: number; ms?: number; why?: string }[];
  };
  resources: {
    state: FourState;
    cpuCores: number; cpuModel: string; load1: number;
    totalMemGB: number; freeMemGB: number; uptimeHours: number; node: string;
  };
  summary: {
    proc: FourState; gateway: FourState; repo: FourState; suites: FourState;
    portsOpen: string; suitesPass: number; suitesTotal: number;
  };
}

const STATE_LABEL: Record<FourState, string> = {
  PASS: '正常', WARN: '注意', FAIL: '异常', UNKNOWN: '判不了',
};

export function stateLabel(s: FourState): string {
  return STATE_LABEL[s] ?? '判不了';
}

/** 一行摘要，给顶部状态条用 */
export function headline(r: RuntimeState): string {
  const g = r.gateway.state === 'PASS' ? r.gateway.modelCount + ' 个模型' : stateLabel(r.gateway.state);
  return `验收 ${r.summary.suitesPass}/${r.summary.suitesTotal} 通过 · 网关 ${g} · 端口 ${r.summary.portsOpen} · 未提交 ${r.repo.dirtyFiles ?? '?'}`;
}

export function ageLabel(at: string): string {
  const ms = Date.now() - new Date(at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '刚采集';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' 秒前';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' 分钟前';
  return Math.round(m / 60) + ' 小时前';
}