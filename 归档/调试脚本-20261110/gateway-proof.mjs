/**
 * 网关真实验证 —— 判据设计必须排除"自己发的提问"
 *
 * 关键：不提"网关测试成功"这几个字，改用一个模型必须真的计算才能得出的答案。
 * 例如：算 2+2=4 这类，或者要求输出一个随机口令。
 *
 * 更强判据：让模型输出一个我给定的随机串的反转，这样答案只可能来自模型。
 */

import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.DSH_ENGINE_BASE || 'http://127.0.0.1:3080';
const TOKEN = process.env.DSH_ENGINE_TOKEN || '';
const WB = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench`;

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

// 生成一个只有模型算得出答案的题目
const A = 8379;
const B = 4612;
const EXPECT = String(A * B);   // 38655828 —— 提问里不出现答案

function readUI() {
  return new Promise(async (resolve) => {
    const targets = await (await fetch('http://127.0.0.1:9333/json/list', { signal: AbortSignal.timeout(5000) })).json();
    const engWv = targets.filter(t => t.type === 'webview' && t.url.includes('3080'));
    if (!engWv.length) return resolve({ error: 'no webview' });
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
    const out = await ev(`(function(){ return (document.body.innerText || ''); })()`);
    ws.close();
    resolve({ text: out });
  });
}

(async () => {
  await getCookie();
  console.log('cookie:', cookie ? 'OK' : 'FAIL');
  console.log();

  // 新建会话（确保用新的默认模型）
  console.log('=== 新建会话 ===');
  const c = await rpc('session/create', { request: { cwd: String.raw`D:\file\AI Temp\DeepSeek\Agent自研` } });
  const sid = c.j?.result?.value?.sessionId;
  console.log('  sessionId:', sid || '失败');
  if (!sid) { console.log(c.t.slice(0, 200)); process.exit(1); }

  // 提问：只给出两个数，答案不出现
  const PROMPT = `请计算 ${A} 乘以 ${B} 的结果，只输出纯数字，不要任何其他文字。`;
  console.log();
  console.log('=== 提问 ===');
  console.log('  ' + PROMPT);
  console.log('  预期答案（不在提问里）: ' + EXPECT);

  const pr = await rpc('session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId: sid,
      mode: 'queue',
      content: [{ type: 'text', text: PROMPT }],
    },
  });
  console.log('  投递:', pr.status);

  // 等 40 秒
  console.log();
  console.log('=== 等 40 秒 ===');
  await new Promise(r => setTimeout(r, 40000));

  const ui = await readUI();
  const text = ui.text || '';

  console.log();
  console.log('═══ 精确判定 ═══');

  // 判据 1：答案出现在界面里（且不在提问里 —— 提问只有两个数）
  const hasAnswer = text.includes(EXPECT);

  // 判据 2：QUOTA 错误
  const quota = /额度已用尽|ACCOUNT_QUOTA|QUOTA/.test(text);

  // 判据 3：处理失败
  const fail = /本轮运行失败/.test(text);

  console.log('  出现正确答案 ' + EXPECT + ' : ' + hasAnswer);
  console.log('  QUOTA 错误                  : ' + quota);
  console.log('  本轮运行失败                : ' + fail);
  console.log();
  console.log('  界面尾部:');
  console.log(text.slice(-500));

  console.log();
  console.log('═══ 结论 ═══');
  if (hasAnswer && !quota) {
    console.log('  ✅ 网关真的通了！模型算出了 ' + EXPECT + '（提问里没有这个数）');
  } else if (quota || fail) {
    console.log('  ❌ 仍是 QUOTA —— 网关未生效');
  } else {
    console.log('  ? 无明确结论');
  }
})();
