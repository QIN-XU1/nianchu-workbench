/**
 * 在已通的 web-gw 引擎上重建 11 个场景会话
 *
 * 引擎已证明走 raccoon 网关（答案 38643948 证实）
 * 现在给每个场景建会话、改名、写回 json
 */

import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.DSH_ENGINE_BASE || 'http://127.0.0.1:3080';
const TOKEN = process.env.DSH_ENGINE_TOKEN || '';
const WB = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench`;
const SC = path.join(WB, '外壳', 'scenarios');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

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
  console.log(C.bold + '重建 11 个场景会话（已通的网关引擎）' + C.reset);
  console.log();

  await getCookie();
  if (!cookie) { console.error('拿不到 cookie'); process.exit(1); }
  console.log(C.green + '✓' + C.reset + ' cookie');
  console.log();

  // 读场景
  const scenes = [];
  for (const f of fs.readdirSync(SC)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SC, f), 'utf8').replace(/\uFEFF/g, ''));
      if (j.id && j.name) scenes.push({ file: f, json: j });
    } catch { /* ignore */ }
  }
  scenes.sort((a, b) => a.json.id.localeCompare(b.json.id));

  const results = [];
  const fails = [];

  for (const sc of scenes) {
    const j = sc.json;
    const harness = (j.panels || []).find(p => p.type === 'harness');
    if (!harness) { console.log(C.dim + '  跳过 ' + j.id + '（无 AI 面板）' + C.reset); continue; }

    const title = harness.sessionTitle || j.name || j.id;

    process.stdout.write('  ' + j.id.padEnd(20));

    // 建会话
    const c = await rpc('session/create', { request: { cwd: String.raw`D:\file\AI Temp\DeepSeek\Agent自研` } });
    const newId = c.j?.result?.value?.sessionId;
    if (!newId) { console.log(C.red + '建失败 HTTP' + c.status + C.reset); fails.push(j.id); continue; }
    process.stdout.write(C.green + '✓' + C.reset + ' 建 ');

    // 改名
    const rn = await rpc('session/rename', { request: { sessionId: newId, title } });
    process.stdout.write((rn.status === 200 ? C.green + '✓' + C.reset : C.yellow + '!' + C.reset) + ' 改名 ');

    // 存入场消息（让会话出现在侧边栏）
    const seed = '你是「' + title + '」场景的 AI 助手，场景 id 为 `' + j.id + '`。'
      + '现在只回一句话「已读」，不要调用任何工具。';
    await rpc('session/prompt', {
      request: {
        requestId: crypto.randomUUID(),
        sessionId: newId,
        mode: 'queue',
        content: [{ type: 'text', text: seed }],
      },
    });
    await new Promise(r => setTimeout(r, 2500));
    await rpc('session/cancel', { request: { sessionId: newId } });
    process.stdout.write(C.green + '✓' + C.reset + ' 开场 ');

    // 写回
    harness.sessionId = newId;
    harness.sessionTitle = title;
    fs.writeFileSync(path.join(SC, sc.file), JSON.stringify(j, null, 2) + '\n', 'utf8');
    console.log(C.green + '✓' + C.reset + ' 写回');

    results.push({ id: j.id, name: j.name, sessionId: newId, title });
  }

  console.log();
  console.log(C.bold + '=== 汇总 ===' + C.reset);
  console.log('  成功: ' + results.length);
  console.log('  失败: ' + fails.length);

  fs.writeFileSync(path.join(WB, '工具', 'session-bindings.json'), JSON.stringify({
    at: new Date().toISOString(),
    base: BASE,
    provider: 'raccoon',
    model: 'sn-deepseek-v4-1-flash-1017',
    results,
    fails,
  }, null, 2), 'utf8');

  console.log('  绑定表: workbench/工具/session-bindings.json');
  process.exit(fails.length ? 2 : 0);
})();
