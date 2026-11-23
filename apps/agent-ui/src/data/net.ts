/**
 * 联网数据（A3）：搜索与抓取的真实结果，供界面展示
 *
 * 数据来自 tools/net/search.mjs 与 tools/net/fetch.mjs，不是示例数据。
 * 生成：node tools/net/gen-ui-data.mjs
 */
export type FourState = 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN';

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  host: string;
}

export interface NetProbe {
  what: string;
  at: string;
  generator: string;
  rule: string;
  search: {
    state: FourState;
    query: string;
    endpoint: string;
    why: string;
    results: SearchResult[];
  };
  fetch: {
    state: FourState;
    url: string;
    why: string;
    title: string;
    chars: number;
    excerpt: string;
  };
  /** 后端可达性一览：说明为什么选这个后端 */
  backends: { name: string; url: string; state: FourState; note: string }[];
}

export const STATE_LABEL: Record<FourState, string> = {
  PASS: '通过',
  WARN: '待补',
  FAIL: '失败',
  UNKNOWN: '判不了',
};

export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}