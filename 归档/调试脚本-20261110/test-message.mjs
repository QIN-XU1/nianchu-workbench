/**
 * 测试：用网关模型发一条消息，看是否成功
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.DSH_ENGINE_BASE || 'http://127.0.0.1:3080';
const TOKEN = process.env.DSH_ENGINE_TOKEN || '';
const WB = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench`;
const SC = path.join(WB, '外壳', 'scenarios');

let cookie = '';
let seq = 1;

async function getCookie() {
  const r = await fetch(`${BASE}/?token=${TOKEN}`, { redirect: 'manual' });
  const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
  return cookie;
}

async function rpc(method, args) {
  const r = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r' + (seq++), method, payload: { args } }),
    signal: AbortSignal.timeout(30000),
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch { /* ignore */ }
  return { status: r.status, j, t };
}

(async () => {
  await getCookie();
  console.log('cookie:', cookie ? 'OK' : 'FAIL');

  // 找 command 场景的 sessionId
  let sid = '';
  for (const f of fs.readdirSync(SC)) {
    if (!f.startsWith('command') || !f.endsWith('.json')) continue;
    const j = JSON.parse(fs.readFileSync(path.join(SC, f), 'utf8').replace(/\uFEFF/g, ''));
    const h = (j.panels || []).find(p => p.type === 'harness');
    if (h) sid = h.sessionId;
  }
  console.log('sessionId:', sid);
  console.log();

  // 发测试消息
  console.log('=== 发测试消息 ===');
  const pr = await rpc('session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId: sid,
      mode: 'queue',
      content: [{ type: 'text', text: '只回复两个字：已读' }],
    },
  });
  console.log('  投递:', pr.status, pr.t.slice(0, 100));

  // 等 20 秒看结果
  console.log();
  console.log('=== 等待响应（20 秒）===');
  await new Promise(r => setTimeout(r, 20000));

  // 读会话历史
  const hist = await rpc('session/messages', { request: { sessionId: sid } });
  console.log('  消息查询:', hist.status);
  if (hist.j) {
    const txt = JSON.stringify(hist.j);
    console.log('  ' + txt.slice(0, 400));
  } else {
    console.log('  ' + hist.t.slice(0, 200));
  }
})();
