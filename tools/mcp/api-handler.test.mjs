#!/usr/bin/env node
/**
 * /api/mcp 处理器的反例测试（不依赖真 server，用假 session）。
 *
 * 6 条**必须被拒绝**的构造 + 3 条正例（防「全拒绝」也算过）：
 *   1. GET                          → 405
 *   2. 未知 serverId                → 404（并列出已知 id）
 *   3. action 非法                  → 400
 *   4. call 缺 tool                 → 400
 *   5. 请求体不是 JSON              → 400
 *   6. **body 里带 command 字段**   → 被忽略（必须只用白名单命令）
 *   7. 并发第二次                   → 429
 *   8. 正例 probe                   → 200 且返回工具列表
 *   9. 正例 call                    → 200 且返回结果
 */
import { createMcpHandler, createMcpMiddleware } from './api-handler.mjs';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  ← ' + detail : '')); }
};

function fakeRes() {
  const r = { code: null, headers: null, body: null };
  r.writeHead = (c, h) => { r.code = c; r.headers = h || {}; };
  r.end = (b) => { r.body = b; };
  r.json = () => { try { return JSON.parse(r.body); } catch { return null; } };
  return r;
}

const SERVERS = { ok: true, servers: [{ id: 'fake', name: 'F', command: 'node x.mjs' }] };

/** 假 session：记录收到的命令，便于断言「用的是白名单命令」 */
function mkFakeSession(log) {
  return (cmd, opts) => {
    log.push({ cmd, opts });
    return {
      start: async () => ({ state: 'PASS' }),
      initialize: async () => ({ state: 'PASS', serverInfo: { name: 'fake-server' } }),
      listTools: async () => ({ state: 'PASS', tools: [{ name: 'echo' }, { name: 'add' }] }),
      callTool: async (name, args) => ({ state: 'PASS', why: '调用成功', content: [{ type: 'text', text: JSON.stringify({ called: name, args }) }], isError: false }),
      close: async () => {},
      stderr: '',
    };
  };
}

const H = (over = {}) => createMcpHandler({ load: () => SERVERS, sessionFactory: mkFakeSession([]), ...over });

// 1) GET → 405
{
  const res = fakeRes();
  await H()({ method: 'GET' }, res, '');
  t('反例：GET → 405', res.code === 405, 'code=' + res.code);
}

// 2) 未知 serverId → 404
{
  const res = fakeRes();
  await H()({ method: 'POST' }, res, JSON.stringify({ serverId: 'nope', action: 'probe' }));
  const j = res.json();
  t('反例：未知 serverId → 404 且列出已知 id', res.code === 404 && Array.isArray(j?.known) && j.known.includes('fake'), JSON.stringify(j));
}

// 3) action 非法 → 400
{
  const res = fakeRes();
  await H()({ method: 'POST' }, res, JSON.stringify({ serverId: 'fake', action: 'rm -rf' }));
  t('反例：action 非法 → 400', res.code === 400, 'code=' + res.code);
}

// 4) call 缺 tool → 400
{
  const res = fakeRes();
  await H()({ method: 'POST' }, res, JSON.stringify({ serverId: 'fake', action: 'call' }));
  t('反例：call 缺 tool → 400', res.code === 400, 'code=' + res.code);
}

// 5) 坏 JSON → 400
{
  const res = fakeRes();
  await H()({ method: 'POST' }, res, '{not json');
  t('反例：请求体不是 JSON → 400', res.code === 400, 'code=' + res.code);
}

// 6) body 带 command → 必须被忽略
{
  const log = [];
  const res = fakeRes();
  await H({ sessionFactory: mkFakeSession(log) })({ method: 'POST' }, res, JSON.stringify({
    serverId: 'fake', action: 'probe', command: ['powershell', '-c', 'rm -rf /'],
  }));
  const used = log[0]?.cmd;
  t('反例：body 带 command → 被忽略，只用白名单命令',
    typeof used === 'string' && used === 'node x.mjs', JSON.stringify(used));
}

// 7) 并发 → 429
{
  let release;
  const slow = () => ({
    start: () => new Promise((r) => { release = () => r({ state: 'PASS' }); }),
    initialize: async () => ({ state: 'PASS' }),
    listTools: async () => ({ state: 'PASS', tools: [] }),
    callTool: async () => ({ state: 'PASS' }),
    close: async () => {},
    stderr: '',
  });
  const h = H({ sessionFactory: slow });
  const r1 = fakeRes();
  const p1 = h({ method: 'POST' }, r1, JSON.stringify({ serverId: 'fake', action: 'probe' }));
  const r2 = fakeRes();
  await h({ method: 'POST' }, r2, JSON.stringify({ serverId: 'fake', action: 'probe' }));
  t('反例：并发第二次 → 429', r2.code === 429, 'code=' + r2.code);
  release();
  await p1;
}

// 8) 正例 probe
{
  const res = fakeRes();
  await H()({ method: 'POST' }, res, JSON.stringify({ serverId: 'fake', action: 'probe' }));
  const j = res.json();
  t('正例：probe → 200 且返回工具列表', res.code === 200 && j?.ok === true && j.count === 2, JSON.stringify(j).slice(0, 120));
}

// 9) 正例 call
{
  const res = fakeRes();
  await H()({ method: 'POST' }, res, JSON.stringify({ serverId: 'fake', action: 'call', tool: 'add', args: { a: 40, b: 2 } }));
  const j = res.json();
  t('正例：call → 200 且返回 content', res.code === 200 && j?.ok === true && Array.isArray(j.content) && /add/.test(JSON.stringify(j.content)), JSON.stringify(j).slice(0, 140));
}

// 10) 中间件：非本路径 next()
{
  const mw = createMcpMiddleware({ load: () => SERVERS, sessionFactory: mkFakeSession([]) });
  let nexted = false;
  await mw({ method: 'POST', url: '/api/other', on: () => {} }, fakeRes(), () => { nexted = true; });
  t('中间件：非 /api/mcp → next()', nexted === true);
}

console.log('');
console.log('  /api/mcp 反例测试：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
