/**
 * 批量建会话 —— 11 个场景各建一个 AI 会话
 *
 * 用 web 引擎（3080）的 RPC API，payload 格式照 建会话.mjs：
 *   { type:'client-request', rpcId:'r1', method, payload:{ args } }
 *
 * 流程：
 *   ① token → cookie
 *   ② session/create  → sessionId
 *   ③ session/rename  → 标题
 *   ④ 写回 scenarios/<id>.json 的 panels[].sessionId / sessionTitle
 */

import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.DSH_ENGINE_BASE || 'http://127.0.0.1:3080';
const TOKEN = process.env.DSH_ENGINE_TOKEN || '';
const WB = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench`;
const SC = path.join(WB, '外壳', 'scenarios');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

if (!TOKEN) {
  console.error('需要 DSH_ENGINE_TOKEN');
  process.exit(1);
}

let cookie = '';
let rpcSeq = 1;

async function getCookie() {
  const r = await fetch(`${BASE}/?token=${TOKEN}`, { redirect: 'manual' });
  const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  if (sc.length) {
    cookie = sc.map(c => c.split(';')[0]).join('; ');
  }
  return cookie;
}

async function rpc(method, args) {
  const r = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r' + (rpcSeq++), method, payload: { args } }),
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch { /* ignore */ }
  return { status: r.status, j, t };
}

// ═══════ 读场景 ═══════
function loadScenes() {
  const out = [];
  for (const f of fs.readdirSync(SC)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SC, f), 'utf8').replace(/\uFEFF/g, ''));
      if (j.id && j.name) out.push({ file: f, json: j });
    } catch { /* ignore */ }
  }
  return out;
}

// ═══════ 找工作区 ═══════
async function findWorkspace(cwd) {
  const r = await rpc('session/list', {});
  // 从返回里找 workspace 信息
  const txt = r.t;
  // 尝试 workspace/list
  const w = await rpc('workspace/list', {});
  if (w.j && w.j.result && w.j.result.value) {
    const list = w.j.result.value.workspaces || w.j.result.value || [];
    const norm = s => String(s || '').replace(/[\\/]+$/, '').toLowerCase();
    for (const item of (Array.isArray(list) ? list : [])) {
      if (norm(item.path) === norm(cwd)) return item.id || item.workspaceId;
    }
  }
  return '';
}

// ═══════ 主流程 ═══════
(async () => {
  console.log(C.bold + '批量建会话' + C.reset + '  ' + BASE);
  console.log();

  await getCookie();
  if (!cookie) {
    console.error(C.red + '拿不到 cookie（token 可能失效）' + C.reset);
    process.exit(1);
  }
  console.log(C.green + '✓' + C.reset + ' cookie 已获取');
  console.log();

  const scenes = loadScenes();
  console.log('场景数:', scenes.length);
  console.log();

  // 找工作区
  const WORKSPACE_CWD = String.raw`D:\file\AI Temp\DeepSeek\Agent自研`;
  let wsId = '';
  try {
    wsId = await findWorkspace(WORKSPACE_CWD);
  } catch { /* ignore */ }
  console.log('工作区 id:', wsId || '(未找到，退回 cwd)');
  console.log();

  const results = [];
  const failures = [];

  for (const sc of scenes) {
    const j = sc.json;
    const harness = (j.panels || []).find(p => p.type === 'harness');
    if (!harness) {
      console.log(C.dim + '  跳过 ' + j.id + '（无 AI 面板）' + C.reset);
      continue;
    }

    const title = harness.sessionTitle || j.name || j.id;

    // 已经绑过就跳过
    if (harness.sessionId) {
      console.log(C.green + '  已有' + C.reset + ' ' + j.id.padEnd(20) + ' ' + harness.sessionId);
      results.push({ id: j.id, sessionId: harness.sessionId, title, reused: true });
      continue;
    }

    process.stdout.write('  ' + j.id.padEnd(20) + ' 建会话… ');

    // ① 建
    const c = await rpc('session/create', { request: wsId ? { workspaceId: wsId } : { cwd: WORKSPACE_CWD } });
    const newId = c.j && c.j.result && c.j.result.value && c.j.result.value.sessionId;
    if (!newId) {
      console.log(C.red + '失败 HTTP ' + c.status + C.reset);
      console.log('       ' + String(c.t).slice(0, 150));
      failures.push({ id: j.id, reason: 'create' });
      continue;
    }
    process.stdout.write(C.green + '✓' + C.reset + ' ' + newId.slice(0, 12) + '… ');

    // ② 改名
    const rn = await rpc('session/rename', { request: { sessionId: newId, title } });
    if (rn.status !== 200) {
      console.log(C.yellow + '改名失败' + C.reset);
    } else {
      process.stdout.write(C.green + '✓' + C.reset + ' 改名 ');
    }

    // ③ 写回 json
    harness.sessionId = newId;
    harness.sessionTitle = title;
    fs.writeFileSync(path.join(SC, sc.file), JSON.stringify(j, null, 2) + '\n', 'utf8');
    console.log(C.green + '✓' + C.reset + ' 写回');

    results.push({ id: j.id, sessionId: newId, title });
  }

  console.log();
  console.log(C.bold + '=== 汇总 ===' + C.reset);
  console.log('  成功: ' + results.length);
  console.log('  失败: ' + failures.length);

  // 直接输出 json 供后续用
  const outPath = path.join(WB, '工具', 'session-bindings.json');
  fs.writeFileSync(outPath, JSON.stringify({
    at: new Date().toISOString(),
    base: BASE,
    results,
    failures,
  }, null, 2), 'utf8');
  console.log('  绑定表: ' + outPath);

  if (failures.length) {
    console.log();
    console.log(C.yellow + '失败明细：' + C.reset);
    for (const f of failures) console.log('  ' + f.id + '  ' + f.reason);
  }

  process.exit(failures.length ? 2 : 0);
})();
