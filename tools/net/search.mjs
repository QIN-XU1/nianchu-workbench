#!/usr/bin/env node
/**
 * A3 联网：搜索 + 抓取（自研）
 *
 * 之前 A3 记「部分」，证据写得很清楚：
 *   「联网能力来自 hermes 基线（tools/ 内建 web 搜索与抓取），我们没有自己的实现。
 *     我们自研的只有取证用途的抓取脚本。」
 *
 * 本轮补上产品级的两件事：
 *   1. **搜索** —— 之前完全没有。走可配置的搜索后端，按结果解析出 title/url/snippet
 *   2. **抓取 + 正文提取** —— 把 HTML 压成可读正文（去掉 script/style/标签），
 *      而不是丢一大坨 HTML 给上游
 *
 * 并接进界面（Capabilities → 联网面板），让它是产品的一部分而不是命令行脚本。
 *
 * 四态纪律（贯穿）：
 *   PASS    拿到结果且内容非空
 *   WARN    拿到但内容极少（空壳）
 *   FAIL    上游明确拒绝（4xx/5xx）
 *   UNKNOWN 连不上 —— 「没连上」不等于「没有内容」
 *
 * 搜索后端：
 *   默认用 DuckDuckGo 的 HTML 端点（无需 key，返回可直接解析）。
 *   可用环境变量 VOUCH_SEARCH_ENDPOINT 换成自建/其他后端。
 *   后端不可达时记 UNKNOWN 并**明确告知**，不返回伪造结果。
 *
 * 用法：
 *   node tools/net/search.mjs "查询词" [--limit=5] [--json]
 *   node tools/net/search.mjs --selftest           # 离线自检（解析器）
 *   node tools/net/search.mjs --capture=<url>      # 只抓正文
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(REPO, 'evidence/net/search.json');

export const S = { PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL', UNKNOWN: 'UNKNOWN' };
const DEFAULT_ENDPOINT = 'https://www.bing.com/search';

function arg(name, dflt = null) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
}
function positional(n) {
  return process.argv.slice(2).filter((a) => !a.startsWith('--'))[n];
}

// ── HTTP（带重试，四态）──
/**
 * HTTP GET —— 用 curl 而不是 Node fetch
 *
 * 实测：本机 `fetch()` 到 https://html.duckduckgo.com 直接 "fetch failed"，
 * 但 curl 能拿到 200。Node 的 fetch 不吃系统代理设置，curl 会。
 * 所以这一层用 curl（与 tools/net/fetch.mjs 保持一致的选择）。
 */
async function httpGet(url, { timeoutSec = 25, retries = 2, proxy = process.env.VOUCH_PROXY || null } = {}) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  const attempts = [];
  for (let i = 0; i < retries; i++) {
    const args = ['-sL', '--max-time', String(timeoutSec), '-A', UA,
      '-H', 'accept-language: zh-CN,zh;q=0.9,en;q=0.8',
      '-o', '-', '-w', '\n@@META@@%{http_code}', url];
    if (proxy) args.unshift('-x', proxy);
    let body = '', code = 0, err = null;
    try {
      const { stdout } = await execFileAsync('curl', args, { maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' });
      const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
      const idx = buf.lastIndexOf('@@META@@');
      if (idx >= 0) { body = buf.slice(0, idx - 1).toString('utf8'); code = Number(buf.slice(idx + 8).toString('utf8').trim()); }
      else body = buf.toString('utf8');
    } catch (e) {
      err = (e.stderr && e.stderr.toString()) || e.message;
    }
    const ok = code >= 200 && code < 300;
    const state = err ? S.UNKNOWN : ok ? (body.length > 200 ? S.PASS : S.WARN) : S.FAIL;
    attempts.push({ n: i + 1, code, bytes: body.length, state, ...(err ? { error: String(err).replace(/\s+/g, ' ').slice(0, 80) } : {}) });
    if (ok) return { state, httpCode: code, body, attempts };
    if (err) {
      if (i < retries - 1) { await new Promise((r) => setTimeout(r, 500 * Math.pow(2, i))); continue; }
      return { state: S.UNKNOWN, httpCode: 0, body: '', why: '连不上（' + String(err).replace(/\s+/g, ' ').slice(0, 80) + '）—— 判不了，不等于没有结果', attempts };
    }
    if (code >= 400 && code < 500) return { state: S.FAIL, httpCode: code, body, attempts };
  }
  return { state: S.UNKNOWN, httpCode: 0, body: '', why: '重试耗尽', attempts };
}

async function __unusedFetchImpl(url, { timeoutSec = 25, retries = 2 } = {}) {
  const attempts = [];
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutSec * 1000),
        headers: {
          // 有些搜索端点对默认 Node UA 直接 403；用普通浏览器 UA
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
          'accept': 'text/html,application/xhtml+xml',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      });
      const body = await r.text();
      const state = r.ok ? (body.length > 200 ? S.PASS : S.WARN) : S.FAIL;
      attempts.push({ n: i + 1, code: r.status, bytes: body.length, state });
      if (r.ok) return { state, httpCode: r.status, body, attempts };
      if (r.status < 500) return { state: S.FAIL, httpCode: r.status, body, attempts };
    } catch (e) {
      const transient = /timeout|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed|abort/i.test(String(e.message));
      attempts.push({ n: i + 1, error: String(e.message).slice(0, 80), state: transient ? S.UNKNOWN : S.FAIL });
      if (!transient) return { state: S.FAIL, httpCode: 0, body: '', error: e.message, attempts };
      if (i < retries - 1) await new Promise((res) => setTimeout(res, 500 * Math.pow(2, i)));
    }
  }
  return {
    state: S.UNKNOWN, httpCode: 0, body: '',
    why: '连不上（' + (attempts[attempts.length - 1]?.error || '') + '）—— 判不了，不等于没有结果',
    attempts,
  };
}

// ── HTML → 纯文本正文（自研，不引第三方）──
export function extractReadable(html) {
  if (!html) return { text: '', title: '', ok: false };
  // 1) 去掉 script / style / noscript / svg / iframe
  let s = html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  // 2) 抽 title
  const tm = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = tm ? decodeEntities(stripTags(tm[1])).trim() : '';

  // 3) 块级标签 → 换行，避免正文粘成一坨
  s = s.replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' ');

  // 4) 去标签 + 解实体
  let text = decodeEntities(stripTags(s));

  // 5) 空白规范化：合并连续空格，保留段落换行，压缩超过 2 个的空行
  text = text.replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, title, ok: text.length > 0 };
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ');
}
function decodeEntities(s) {
  const MAP = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ensp: ' ', emsp: ' ', thinsp: ' ', ndash: '–', mdash: '—',
    hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
    middot: '·', bull: '•', times: '×', divide: '÷', deg: '°', copy: '©',
  };
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (m, k) => {
    if (MAP[k] !== undefined) return MAP[k];
    // 数字实体：&#123; 或 &#x1F600;
    if (k[0] === '#') {
      const code = k[1] === 'x' || k[1] === 'X' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return m; }
      }
    }
    return m;
  });
}

/**
 * 搜索结果解析 —— 支持两种 HTML 结构
 *
 * 后端选择是实测决定的，不是拍脑袋：
 *   ddg-html / ddg-lite / searx.be / brave / zh.wikipedia   → 本机全部 http=000（不可达）
 *   bing                                                    → http=200 / 100KB（可达）
 *   api.github.com、registry.npmmirror.com                  → 200（JSON API，另走）
 * 所以默认后端是 Bing；DuckDuckGo 的结构保留作备选（换网络环境可能反过来）。
 *
 * Bing 结构（实测）：
 *   <li class="b_algo"> … <h2><a href="真实URL">标题</a></h2> … <p>摘要</p> … </li>
 * DuckDuckGo 结构：
 *   <a class="result__a" href="//duckduckgo.com/l/?uddg=<编码后的真实URL>">标题</a>
 *   <a class="result__snippet">摘要</a>
 */
export function parseSearchResults(html, limit = 8) {
  if (!html) return [];
  const out = [];
  const seen = new Set();

  const push = (url, title, snippet) => {
    if (out.length >= limit) return;
    if (!/^https?:/i.test(url)) return;
    if (seen.has(url)) return;
    if (!title) return;
    seen.add(url);
    out.push({ url, title: title.slice(0, 200), snippet: snippet.slice(0, 400), host: safeHost(url) });
  };

  /**
   * ── Bing ──
   *
   * 【2026-11-19 修三个真 bug】原来经常一条都解析不出来（HTTP 200、93KB 页面，结果 0 条）：
   *
   * bug 1：**用 `<li ...>...</li>` 匹配抓不到块**。真实 Bing 的 `<li class="b_algo">`
   *        内部先塞几千字节的 `<link rel=stylesheet ...>`，`</li>` 远在 4000 字符之后；
   *        实测把上限调到 60000 仍然 0 块（因为嵌套的 li）。正确做法：
   *        **按 li 起点切片到下一条 li 起点**，不依赖 `</li>`。
   * bug 2：Bing 的 href 是**重定向包装** `bing.com/ck/a?...&u=a1<base64url>`，
   *        且 `&` 被转义成 `&amp;`。不处理就全是 bing.com 的跳转器，不是结果。
   * bug 3：抓不到真实 URL 时应退到 `<cite>` 里的展示域名，而不是直接跳过。
   */
  function bingRealUrl(rawHref) {
    const href = decodeEntities(String(rawHref || ''));
    const m = /[?&]u=a1([A-Za-z0-9_\-]+)/.exec(href);
    if (!m) return null;
    try {
      let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const dec = Buffer.from(b64, 'base64').toString('utf8');
      return /^https?:\/\//i.test(dec) ? dec : null;
    } catch { return null; }
  }

  function citeUrl(block) {
    const c = /<cite[^>]*>([\s\S]*?)<\/cite>/i.exec(block);
    if (!c) return null;
    const host = decodeEntities(stripTags(c[1])).replace(/\s+/g, '').replace(/^https?:\/\//i, '');
    if (!host || !/\.[a-z]{2,}/i.test(host)) return null;
    return 'https://' + host + '/';
  }

  const bingStarts = [...html.matchAll(/<li class="b_algo"/g)].map((m) => m.index);
  for (let i = 0; i < bingStarts.length && out.length < limit; i++) {
    const s = bingStarts[i];
    const e = i + 1 < bingStarts.length ? bingStarts[i + 1] : Math.min(html.length, s + 30000);
    const b = html.slice(s, e);

    const a = b.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;

    const realUrl = bingRealUrl(a[1]) || citeUrl(b);
    if (!realUrl) continue;

    const p = b.match(/<p[^>]*>([\s\S]{0,600}?)<\/p>/i);
    const title = decodeEntities(stripTags(a[2])).replace(/\s+/g, ' ').trim();
    const snippet = p ? decodeEntities(stripTags(p[1])).replace(/\s+/g, ' ').trim() : '';
    push(realUrl, title, snippet);
  }
  if (out.length) return out;

  // ── DuckDuckGo（备选）──
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    let url = m[1];
    const title = decodeEntities(stripTags(m[2])).trim();
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch { /* 保持原样 */ } }
    const after = html.slice(m.index, m.index + 3000);
    const sm = after.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = sm ? decodeEntities(stripTags(sm[1])).replace(/\s+/g, ' ').trim() : '';
    push(url, title, snippet);
  }
  return out;
}

function safeHost(u) {
  try { return new URL(u).host; } catch { return ''; }
}

/** 一次完整搜索：查 → 解析 → 可选抓首条正文 */
export async function search(query, opts = {}) {
  const endpoint = opts.endpoint || process.env.VOUCH_SEARCH_ENDPOINT || DEFAULT_ENDPOINT;
  const limit = opts.limit || 8;
  const url = endpoint + (endpoint.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(query);
  const r = await httpGet(url, { timeoutSec: opts.timeoutSec || 25, retries: 2 });
  if (r.state !== S.PASS && r.state !== S.WARN) {
    return {
      state: r.state, query, endpoint,
      why: r.state === S.UNKNOWN ? (r.why || '连不上') : 'HTTP ' + r.httpCode,
      results: [], attempts: r.attempts, at: new Date().toISOString(),
    };
  }
  const results = parseSearchResults(r.body, limit);
  const state = results.length ? S.PASS : S.WARN;
  return {
    state, query, endpoint,
    why: results.length ? '解析出 ' + results.length + ' 条结果' : 'HTTP 通了但解析出 0 条（页面结构变了或空结果）',
    results, bytes: r.body.length, attempts: r.attempts, at: new Date().toISOString(),
  };
}

/** 抓一页并提取正文 */
export async function capture(url, opts = {}) {
  const r = await httpGet(url, { timeoutSec: opts.timeoutSec || 25, retries: 2 });
  if (r.state !== S.PASS && r.state !== S.WARN) {
    return { state: r.state, url, why: r.state === S.UNKNOWN ? (r.why || '连不上') : 'HTTP ' + r.httpCode, text: '' };
  }
  const { text, title } = extractReadable(r.body);
  return {
    state: text.length > 200 ? S.PASS : text.length > 0 ? S.WARN : S.FAIL,
    url, title, text, chars: text.length, bytes: r.body.length,
    why: text.length ? '提取正文 ' + text.length + ' 字' : '拿到了 HTML 但没提出正文',
    at: new Date().toISOString(),
  };
}

// ── 自检（离线，验解析器）──
export function selfTest() {
  const cases = [];
  // 统一断言入口（2026-11-16）：原文件用 T('名', 条件)，
  // 审计器扫不到标签。包一层 T，不改任何断言逻辑。
  const T = (n, ok, why) => cases.push([n, !!ok, why]);
  // 1) 正文提取
  const html1 = `<html><head><title>标题 A</title><style>x{}</style></head>
    <body><script>evil()</script><h1>大标题</h1><p>第一段&nbsp;内容</p><p>第二段 &amp; 符号</p></body></html>`;
  const r1 = extractReadable(html1);
  // 伴生断言：若 parseSearchResults 永远返回 []，
  // 「空输入安全」这类断言会通过。这条钉住解析器必须真的解析出东西。
  T('正例 · 伴生：正常搜索结果必须真的解析出来（钉住解析器不是永远返回空）',
    parseSearchResults('<a class="result__a" href="https://e.com/x">标题X</a>', 5).length > 0,
    'len=' + parseSearchResults('<a class="result__a" href="https://e.com/x">标题X</a>', 5).length);

  T('正例 · 去 script/style', !r1.text.includes('evil') && !r1.text.includes('x{}'));
  T('正例 · 抽 title', r1.title === '标题 A');
  T('正例 · 解实体', r1.text.includes('& 符号') && r1.text.includes('第一段 内容'));
  T('块级换行', r1.text.split('\n').filter((l) => l.trim()).length >= 3);

  // 2) 搜索结果解析
  const html2 = `<div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x">结果一</a>
    <a class="result__snippet">这是摘要一</a></div>
    <div class="result">
    <a class="result__a" href="https://example.org/b">结果二</a>
    <a class="result__snippet">摘要二</a></div>`;
  const rs = parseSearchResults(html2, 5);
  T('正例 · 解析出 2 条', rs.length === 2);
  T('正例 · uddg 还原真实 URL', rs[0]?.url === 'https://example.com/a');
  T('正例 · 标题正确', rs[0]?.title === '结果一' && rs[1]?.title === '结果二');
  T('正例 · 摘要正确', rs[0]?.snippet === '这是摘要一');
  T('正例 · host 提取', rs[0]?.host === 'example.com');

  // 3) 空输入不崩
  T('空输入安全', extractReadable('').text === '' && parseSearchResults('').length === 0);

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length,
    total: cases.length,
    ok: bad.length === 0,
    lines: cases.map(([n, ok]) => '  ' + (ok ? '✓' : '✗') + ' ' + n).join('\n'),
  };
}

// ── CLI ──
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  if (process.argv.includes('--selftest')) {
    const r = selfTest();
    console.log('');
    console.log('  A3 联网 · 解析器自检（离线）');
    console.log(r.lines);
    console.log('');
    console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
    console.log('');
    process.exit(r.ok ? 0 : 1);
  }

  const capUrl = arg('capture');
  if (capUrl) {
    const r = await capture(capUrl);
    if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else {
      console.log('');
      console.log('  ' + r.state + '  ' + capUrl);
      if (r.title) console.log('  标题: ' + r.title);
      console.log('  ' + r.why);
      if (r.text) console.log('\n  ' + r.text.slice(0, 600).replace(/\n/g, '\n  '));
      console.log('');
    }
    process.exit(r.state === S.PASS ? 0 : r.state === S.WARN ? 3 : r.state === S.FAIL ? 1 : 2);
  }

  const q = positional(0);
  if (!q) {
    console.error('用法: node tools/net/search.mjs "查询词" [--limit=5] [--json]');
    console.error('      node tools/net/search.mjs --capture=<url>');
    console.error('      node tools/net/search.mjs --selftest');
    process.exit(2);
  }

  const r = await search(q, { limit: Number(arg('limit', '8')) });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(r, null, 2) + '\n', 'utf8');

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log('');
    console.log('  ' + r.state + '  「' + q + '」  ' + r.why);
    for (const x of r.results) {
      console.log('');
      console.log('  · ' + x.title);
      console.log('    ' + x.url);
      if (x.snippet) console.log('    ' + x.snippet.slice(0, 120));
    }
    console.log('');
  }
  process.exit(r.state === S.PASS ? 0 : r.state === S.WARN ? 3 : r.state === S.FAIL ? 1 : 2);
}