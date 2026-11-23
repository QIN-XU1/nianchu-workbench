/**
 * 为已建的 11 个会话补开场消息（让它们出现在侧边栏）
 *
 * 原项目铁律：
 *   ⚠ 空会话不进侧边栏：建完塞一条开场消息再打断
 *
 * 开场消息内容（只要求回一句，不干活）：
 *   "你是「<场景名>」场景的 AI 助手。现在只回一句话「已读」即可 ——
 *    不要读任何文件、不要调用任何工具、不要开始干活，等用户下一条指令。"
 *
 * 用法：
 *   DSH_ENGINE_TOKEN=xxx node prototype\seed-sessions.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.DSH_ENGINE_BASE || 'http://127.0.0.1:3080';
const TOKEN = process.env.DSH_ENGINE_TOKEN || '';
const WB = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench`;
const SC = path.join(WB, '外壳', 'scenarios');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

if (!TOKEN) { console.error('需要 DSH_ENGINE_TOKEN'); process.exit(1); }

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
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch { /* ignore */ }
  return { status: r.status, j, t };
}

function loadBindings() {
  const out = [];
  for (const f of fs.readdirSync(SC)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SC, f), 'utf8').replace(/\uFEFF/g, ''));
      const h = (j.panels || []).find(p => p.type === 'harness');
      if (h && h.sessionId) out.push({ scene: j.id, name: j.name, sessionId: h.sessionId, title: h.sessionTitle });
    } catch { /* ignore */ }
  }
  return out;
}

(async () => {
  console.log(C.bold + '为 11 个会话补开场消息' + C.reset);
  console.log();

  await getCookie();
  if (!cookie) { console.error('拿不到 cookie'); process.exit(1); }
  console.log(C.green + '✓' + C.reset + ' cookie 已获取');
  console.log();

  const bindings = loadBindings();
  console.log('会话数:', bindings.length);
  console.log();

  let ok = 0, fail = 0;
  const results = [];

  for (const b of bindings) {
    const seedTxt = '你是「' + (b.title || b.name) + '」场景的 AI 助手。当前工作台场景为 `'
      + b.scene + '`。现在只回一句话「已读」即可 —— '
      + '不要读任何文件、不要调用任何工具、不要开始干活，等用户下一条指令。';

    process.stdout.write('  ' + b.scene.padEnd(20) + ' ');

    const pr = await rpc('session/prompt', {
      request: {
        requestId: (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
        sessionId: b.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: seedTxt }],
      },
    });

    if (pr.status !== 200) {
      console.log(C.red + '开场消息失败 HTTP ' + pr.status + C.reset);
      console.log('       ' + String(pr.t).slice(0, 150));
      fail++;
      results.push({ ...b, seeded: false, status: pr.status });
      continue;
    }
    process.stdout.write(C.green + '✓' + C.reset + ' 已投递');

    // 等它真开始（原项目说要等 10 秒，太早取消 = 没真开始）
    await new Promise(r => setTimeout(r, 3000));

    // 打断（这轮不许干活）
    const cx = await rpc('session/cancel', { request: { sessionId: b.sessionId } });
    if (cx.status === 200) {
      console.log(C.green + ' ✓' + C.reset + ' 已打断');
    } else {
      console.log(C.yellow + ' 打断失败' + C.reset);
    }

    ok++;
    results.push({ ...b, seeded: true, status: 200 });
  }

  console.log();
  console.log(C.bold + '=== 汇总 ===' + C.reset);
  console.log('  成功: ' + ok);
  console.log('  失败: ' + fail);

  fs.writeFileSync(path.join(WB, '工具', 'session-seeded.json'), JSON.stringify({
    at: new Date().toISOString(),
    ok, fail, results,
  }, null, 2), 'utf8');

  process.exit(fail ? 2 : 0);
})();
