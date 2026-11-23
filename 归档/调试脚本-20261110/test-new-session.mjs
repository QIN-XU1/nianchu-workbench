/**
 * 建一个新会话（用网关模型），测试是否成功
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.DSH_ENGINE_BASE || 'http://127.0.0.1:3080';
const TOKEN = process.env.DSH_ENGINE_TOKEN || '';

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
    signal: AbortSignal.timeout(40000),
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch { /* ignore */ }
  return { status: r.status, j, t };
}

(async () => {
  await getCookie();
  console.log('cookie:', cookie ? 'OK' : 'FAIL');
  console.log();

  // 建新会话
  console.log('=== 建新测试会话 ===');
  const c = await rpc('session/create', { request: { cwd: String.raw`D:\file\AI Temp\DeepSeek\Agent自研` } });
  const sid = c.j && c.j.result && c.j.result.value && c.j.result.value.sessionId;
  console.log('  sessionId:', sid || '失败');
  if (!sid) { console.log('  ' + c.t.slice(0, 200)); process.exit(1); }

  // 发消息
  console.log();
  console.log('=== 发消息（用默认模型 = raccoon 网关）===');
  const pr = await rpc('session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId: sid,
      mode: 'queue',
      content: [{ type: 'text', text: '只回复两个字：已读' }],
    },
  });
  console.log('  投递:', pr.status, pr.t.slice(0, 80));

  // 等响应
  console.log();
  console.log('=== 等 25 秒 ===');
  await new Promise(r => setTimeout(r, 25000));

  // 用 session/list 读状态
  const list = await rpc('session/list', {});
  if (list.j && list.j.result && list.j.result.value) {
    const txt = JSON.stringify(list.j.result.value);
    console.log('  session/list 片段: ' + txt.slice(0, 300));
  }

  console.log();
  console.log('新会话 id: ' + sid);
  console.log('（请在界面里查看这个会话，确认是否成功）');
})();
