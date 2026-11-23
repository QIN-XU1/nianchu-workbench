/**
 * A3 联网搜索与抓取验证 —— 全部离线可复算。
 *
 * 【为什么必须离线验】A3 在矩阵里我们标「部分」，但 tools/net/* 早就有 28 项验收 ——
 * 问题是 **agent 拿不到**（工具面里没有）。所以本轮要证的不是"模块能跑"，
 * 而是「**念初这个 agent 会联网**，且四态判定在真实 HTTP 语义上正确」。
 * 为了不被外网抖动影响，这里用**本地 HTTP 服务器**制造各种真实情形。
 *
 * 钉住的判据：
 *   ① 200 + 长正文 → PASS，标题与正文正确，script/style 被剥掉
 *   ② 404 → FAIL（HTTP 层失败不是"连不上"）
 *   ③ 连不上（关掉的端口）→ UNKNOWN（传输层，与 ② 必须分开）
 *   ④ 超大正文 → 截断且有明确提示（不静默丢）
 *   ⑤ file:// 等本地协议 → 拒绝（工具输入契约，不是越界拦截）
 *   ⑥ 空 url / 空 query → FAIL
 *   ⑦ 工具真的在 agent 默认工具面里（这是本轮的核心缺口）
 *
 * 用法：node tools/agent/verify-a3-web.mjs   四态：0 PASS / 1 FAIL / 2 UNKNOWN
 */
import { createServer } from 'node:http';
import { createToolkit } from './toolkit.mjs';
import { pickTools } from './toolkit.mjs';

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

console.log('');
console.log('  A3 联网搜索与抓取验证（本地服务器，离线可复算）');
console.log('  ' + '─'.repeat(72));

const LONG = '<html><head><title>长页面标题</title><style>.x{color:red}</style></head><body>'
  + '<h1>第一节</h1><p>' + '这是一段足够长的正文内容。'.repeat(20) + '</p>'
  + '<script>alert("should-be-stripped")</script>'
  + '<p>结尾段落 UNIQUE_TAIL_9f3</p></body></html>';

const HUGE = '<html><head><title>巨大页</title></head><body><p>' + 'x'.repeat(30000) + '</p></body></html>';

const srv = createServer((req, res) => {
  if (req.url === '/long') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(LONG);
    return;
  }
  if (req.url === '/huge') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HUGE);
    return;
  }
  if (req.url === '/json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ hello: 'world', n: 42 }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const base = 'http://127.0.0.1:' + port;

try {
  const tk = createToolkit({ cwd: process.cwd() });

  // ══ 一、工具面（本轮核心缺口）══
  {
    t('toolkit 里有 web_fetch', Boolean(tk.web_fetch));
    t('toolkit 里有 web_search', Boolean(tk.web_search));
    const picked = pickTools(tk, ['web_search', 'web_fetch']);
    t('★两者能按名装载（agent 工具面可用）', picked.length === 2, String(picked.length));
    t('web_fetch 是只读工具', tk.web_fetch.readOnly === true);
    t('web_search 是只读工具', tk.web_search.readOnly === true);
    t('schema 要求 url / query',
      tk.web_fetch.input_schema.required.includes('url')
      && tk.web_search.input_schema.required.includes('query'));
  }

  // ══ 二、正常抓取 ══
  {
    const r = await tk.web_fetch.call({ url: base + '/long' });
    t('★200 + 长正文 → PASS', r.state === 'PASS', r.state + ' ' + String(r.why));
    t('标题正确提取', r.title === '长页面标题', String(r.title));
    t('正文含预期内容', /这是一段足够长的正文内容/.test(String(r.text)));
    t('正文含结尾段落（没被截掉）', /UNIQUE_TAIL_9f3/.test(String(r.text)));
    t('★script 内容被剥掉', !/should-be-stripped/.test(String(r.text)));
    t('★style 内容被剥掉', !/color:red/.test(String(r.text)));
    t('返回 ok=true', r.ok === true);
  }

  // ══ 三、HTTP 失败 vs 传输失败 必须分开 ══
  {
    const r404 = await tk.web_fetch.call({ url: base + '/missing' });
    t('★404 → FAIL（不是 UNKNOWN）', r404.state === 'FAIL' && r404.ok === false, r404.state);

    // 关掉的端口 → 传输层失败
    const deadPort = await (async () => {
      const s2 = createServer(() => {});
      await new Promise((res) => s2.listen(0, '127.0.0.1', res));
      const p = s2.address().port;
      await new Promise((res) => s2.close(res));
      return p;
    })();
    const rDead = await tk.web_fetch.call({ url: 'http://127.0.0.1:' + deadPort + '/x' });
    t('★连不上 → UNKNOWN（与 404 的 FAIL 分开）', rDead.state === 'UNKNOWN', rDead.state);
    t('★连不上时 ok=false', rDead.ok === false);
  }

  // ══ 四、截断要显式 ══
  {
    const r = await tk.web_fetch.call({ url: base + '/huge', max_chars: 1000 });
    t('★超大正文被截断且标记 truncated', r.truncated === true, String(r.truncated));
    t('★截断有明确提示（不静默丢）', /已截断/.test(String(r.note)), String(r.note));
    t('截断后长度不超过上限', String(r.text).length <= 1000, String(String(r.text).length));
    t('原始长度如实报告', Number(r.chars) > 1000, String(r.chars));
  }

  // ══ 五、非 HTML 不崩 ══
  {
    const r = await tk.web_fetch.call({ url: base + '/json' });
    t('★JSON 响应不崩，返回四态之一',
      ['PASS', 'WARN', 'FAIL', 'UNKNOWN'].includes(r.state), r.state);
    t('JSON 内容以文本形式可见', /hello/.test(String(r.text || '')), String(r.text).slice(0, 60));
  }

  // ══ 六、输入契约（反例）══
  {
    const f1 = await tk.web_fetch.call({ url: 'file:///C:/windows/win.ini' });
    t('★反例：file:// 被拒（只放行 http(s)）', f1.state === 'FAIL' && /只支持 http/.test(String(f1.error)),
      String(f1.error));

    const f2 = await tk.web_fetch.call({ url: 'ftp://example.com/x' });
    t('★反例：ftp:// 被拒', f2.state === 'FAIL');

    const f3 = await tk.web_fetch.call({ url: '   ' });
    t('★反例：空 url → FAIL 且不发起请求', f3.state === 'FAIL' && /必填/.test(String(f3.error)));

    const s1 = await tk.web_search.call({ query: '' });
    t('★反例：空 query → FAIL', s1.state === 'FAIL' && /必填/.test(String(s1.error)));
  }

  // ══ 七、搜索：形状正确即可（不依赖外网是否可用）══
  {
    const s = await tk.web_search.call({ query: '念初 agent 记忆', limit: 3 });
    t('web_search 返回四态之一', ['PASS', 'WARN', 'FAIL', 'UNKNOWN'].includes(s.state), s.state);
    t('结果数组存在且不超过 limit', Array.isArray(s.results) && s.results.length <= 3,
      String(s.results && s.results.length));
    t('结果条目有 title/url 字段',
      s.results.every((x) => typeof x.title === 'string' && typeof x.url === 'string'));
    if (s.state !== 'PASS') {
      console.log('      （搜索本次未拿到结果：' + s.state + ' ' + String(s.why || s.error || '') + '）');
    }
  }
} finally {
  srv.close();
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— agent 真的能联网：抓取四态正确（404≠连不上）、正文提取干净、截断显式、本地协议被拒'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;