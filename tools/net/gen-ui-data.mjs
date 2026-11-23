#!/usr/bin/env node
/**
 * 生成界面的联网数据（A3）
 *
 * 真跑一次搜索 + 一次抓取，把结果落成 apps/agent-ui/src/data/net.json，
 * 界面 import 它。这样界面显示的是**真实发生过的联网结果**，不是示例数据。
 *
 * 也顺带记录后端可达性（实测），解释为什么默认后端是 Bing 而不是 DuckDuckGo。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { search, capture, selfTest, S } from './search.mjs';

const execFileAsync = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(REPO, 'apps/agent-ui/src/data/net.json');

const QUERY = process.env.VOUCH_NET_QUERY || 'DeepSeek Harness 插件';
const CAPTURE_URL = process.env.VOUCH_NET_CAPTURE || 'https://www.deepseek.com/harness/';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BACKENDS = [
  ['DuckDuckGo HTML', 'https://html.duckduckgo.com/html/?q=test', '不可达时自动回退'],
  ['Bing', 'https://www.bing.com/search?q=test', '默认后端（实测可达）'],
  ['GitHub API', 'https://api.github.com/search/repositories?q=test&per_page=1', 'JSON API，代码仓库检索'],
  ['npm registry', 'https://registry.npmmirror.com/-/v1/search?text=test&size=1', 'JSON API，包检索'],
  ['searx.be', 'https://searx.be/search?q=test&format=json', '社区实例，可达性不稳定'],
];

async function probeBackend(url) {
  try {
    const { stdout } = await execFileAsync('curl', [
      '-sL', '-o', '-', '--max-time', '20', '-w', '\n@@%{http_code}', '-A', UA, url,
    ], { maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', timeout: 25000 });
    const idx = stdout.lastIndexOf('@@');
    const code = idx >= 0 ? Number(stdout.slice(idx + 2).trim()) : 0;
    const body = idx >= 0 ? stdout.slice(0, idx) : stdout;
    if (!code) return { state: S.UNKNOWN, note: '连不上（本机网络不可达）' };
    if (code >= 200 && code < 300) return { state: body.length > 200 ? S.PASS : S.WARN, note: 'http ' + code + ' / ' + Math.round(body.length / 1024) + 'KB' };
    return { state: S.FAIL, note: 'http ' + code };
  } catch (e) {
    return { state: S.UNKNOWN, note: '连不上（' + String(e.message).slice(0, 40) + '）' };
  }
}

console.log('');
console.log('  生成界面联网数据（真跑，不是示例）');
console.log('  ' + '─'.repeat(66));

// 0) 解析器自检
const st = selfTest();
console.log('  解析器自检: ' + (st.ok ? '✓ ' + st.pass + '/' + st.total : '✗ ' + (st.total - st.pass) + ' 项不成立'));

// 1) 搜索
console.log('  搜索「' + QUERY + '」…');
const sr = await search(QUERY, { limit: 5 });
console.log('    ' + sr.state + '  ' + sr.why);

// 2) 抓取
console.log('  抓取 ' + CAPTURE_URL + ' …');
const cp = await capture(CAPTURE_URL);
console.log('    ' + cp.state + '  ' + cp.why);

// 3) 后端可达性
const backends = [];
for (const [name, url, note] of BACKENDS) {
  const r = await probeBackend(url);
  backends.push({ name, url, state: r.state, note: r.note + ' · ' + note });
  console.log('    ' + (r.state === S.PASS ? '✓' : r.state === S.FAIL ? '✗' : '?') + ' ' + name.padEnd(18) + r.state.padEnd(8) + r.note);
}

const data = {
  what: '联网能力实测结果（A3）',
  at: new Date().toISOString(),
  generator: 'tools/net/gen-ui-data.mjs',
  rule: '界面显示的是真实发生过的搜索与抓取；UNKNOWN 表示本机连不上，不等于目标不存在',
  search: {
    state: sr.state,
    query: sr.query,
    endpoint: sr.endpoint,
    why: sr.why,
    results: (sr.results || []).map((r) => ({
      url: r.url, title: r.title, snippet: r.snippet, host: r.host,
    })),
  },
  fetch: {
    state: cp.state,
    url: cp.url,
    why: cp.why,
    title: cp.title || '',
    chars: cp.chars || 0,
    excerpt: (cp.text || '').slice(0, 700),
  },
  backends,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n', 'utf8');

console.log('');
console.log('  → ' + path.relative(REPO, OUT));
console.log('  搜索 ' + data.search.results.length + ' 条 · 抓取 ' + data.fetch.chars + ' 字 · 后端 ' +
  backends.filter((b) => b.state === 'PASS').length + '/' + backends.length + ' 可达');
console.log('');

process.exit(data.search.state === 'PASS' ? 0 : data.search.state === 'WARN' ? 3 : data.search.state === 'FAIL' ? 1 : 2);