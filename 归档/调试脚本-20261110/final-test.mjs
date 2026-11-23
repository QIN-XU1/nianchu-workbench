/**
 * 最终测试：用当前引擎（web-gw profile）发消息，看是否真的能对话
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

  // 用研究场景
  let sid = '';
  for (const f of fs.readdirSync(SC)) {
    if (!f.startsWith('research') || !f.endsWith('.json')) continue;
    const j = JSON.parse(fs.readFileSync(path.join(SC, f), 'utf8').replace(/\uFEFF/g, ''));
    const h = (j.panels || []).find(p => p.type === 'harness');
    if (h) sid = h.sessionId;
  }
  console.log('research sessionId:', sid);
  console.log();

  console.log('=== 发消息 ===');
  const pr = await rpc('session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId: sid,
      mode: 'queue',
      content: [{ type: 'text', text: '你好，请只回复"网关测试成功"五个字' }],
    },
  });
  console.log('  投递:', pr.status, pr.t.slice(0, 80));

  // 等 30 秒
  console.log();
  console.log('=== 等 30 秒看回复 ===');
  await new Promise(r => setTimeout(r, 30000));

  // 用 CDP 读界面
  const targets = await (await fetch('http://127.0.0.1:9333/json/list', { signal: AbortSignal.timeout(5000) })).json();
  const engWv = targets.filter(t => t.type === 'webview' && t.url.includes('3080'));
  if (engWv.length) {
    const ws = new WebSocket(engWv[0].webSocketDebuggerUrl);
    await new Promise(r => { ws.addEventListener('open', r); setTimeout(r, 3000); });
    let id = 1;
    const p = new Map();
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id && p.has(m.id)) { p.get(m.id)(m.result); p.delete(m.id); }
    });
    const send = (m, pa) => new Promise(r => { const i = id++; p.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: pa })); });
    const ev = async x => { const rr = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return rr?.result?.value; };

    const result = await ev(`(function(){
      return {
        body: (document.body.innerText || '').slice(-800),
        hasQuota: /额度已用尽|QUOTA/.test(document.body.innerText || ''),
        hasSuccess: /网关测试成功/.test(document.body.innerText || ''),
      };
    })()`);
    console.log();
    console.log('  QUOTA 错误:', result.hasQuota);
    console.log('  收到回复:', result.hasSuccess);
    console.log();
    console.log('  界面尾部:');
    console.log(result.body.slice(-400));
    ws.close();
  }
})();
