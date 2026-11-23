import raw from './snapshot.json';

export type FourState = 'pass' | 'warn' | 'fail' | 'unknown';

export interface Check { ok: FourState; text: string }
export interface Suite {
  id: string; name: string; file: string; state: FourState;
  pass: number; warn?: number; fail: number; unknown: number;
  exit: number; ms: number; checks: Check[];
}
export interface Snapshot {
  schemaVersion: number;
  generatedAt: string;
  generator: string;
  source: { kind: string; label: string; detail: string };
  verify: {
    suites: Suite[];
    totals: { pass: number; fail: number; unknown: number; suitesPass: number; suitesFail: number; suitesUnknown: number };
  };
  capabilities: {
    source: string;
    skills: { name: string; source: string }[];
    mcp: { name: string; source: string }[];
    tools: { name: string; source: string }[];
    patches: { files: string[]; targets: string[] };
    models: { name: string; source: string }[];
    note: string;
  };
  sessions: unknown[];
  tasks: unknown[];
  memory: unknown[];
  about: { product: string; version: string; stage: string; repo: string; node: string };
}

export const snapshot = raw as unknown as Snapshot;

/**
 * 四态总览。
 *
 * 第一版只统计**断言级**的 unknown，结果顶部显示「判不了 0」，
 * 而下面的「目标达成」套件明明是判不了 —— 这就是假绿。
 * 现在把**套件级**的未知/失败也计入：只要有一个套件判不了，总览里的 unknown 就不为 0。
 */
export function fourStateTotals() {
  const t = snapshot.verify.totals;
  const suites = snapshot.verify.suites;
  const suiteUnknown = suites.filter((s) => s.state === 'unknown').length;
  const suiteFail = suites.filter((s) => s.state === 'fail').length;
  return {
    pass: t.pass,
    warn: 0,
    fail: Math.max(t.fail, suiteFail),
    unknown: Math.max(t.unknown, suiteUnknown),
  };
}

/** 套件级计数，单独展示（不混进断言总数） */
export function suiteTotals() {
  const s = snapshot.verify.suites;
  return {
    total: s.length,
    pass: s.filter((x) => x.state === 'pass').length,
    warn: s.filter((x) => x.state === 'warn').length,
    fail: s.filter((x) => x.state === 'fail').length,
    unknown: s.filter((x) => x.state === 'unknown').length,
  };
}

export function dataSource() {
  return snapshot.source;
}

export function generatedAtLabel(): string {
  try {
    return new Date(snapshot.generatedAt).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return snapshot.generatedAt;
  }
}
