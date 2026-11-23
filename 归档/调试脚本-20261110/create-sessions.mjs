/**
 * 批量建会话 —— 用拿到 token 的 web 引擎
 *
 * 流程（照 建会话.mjs 的实测配方）：
 *   ① token → 签名 cookie（必须 redirect:'manual'）
 *   ② POST /api/<method> 调 session/create
 *   ③ session/rename 改标题
 *   ④ 输出 sessionId
 */

const BASE = 'http://127.0.0.1:3080';
const TOKEN = '3yeNHhvSWx9Ej_Xc4pHDGeLdhCz6mAEpyH6k7EPRw4s';

const SCENES = [
  { id: 'command',             title: '命令' },
  { id: 'research',            title: '调研' },
  { id: 'competitor-analyze',  title: '竞品拆解' },
  { id: 'reverse-eng',         title: '逆向分析' },
  { id: 'arch-review',         title: '架构梳理' },
  { id: 'build-plan',          title: '实施计划' },
  { id: 'pipeline',            title: '管线' },
  { id: 'relationship',        title: '关系军师' },
  { id: 'self-review',         title: '自我复盘' },
  { id: 'bilibili',            title: 'B站' },
  { id: 'pc-cleanup',          title: '本地电脑' },
];

// ═══════ 1. token → cookie ═══════
async function getCookie() {
  const r = await fetch(`${BASE}/?token=${TOKEN}`, { redirect: 'manual' });
  const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (!setCookie.length) {
    const raw = r.headers.get('set-cookie');
    if (raw) setCookie.push(raw);
  }
  const cookies = setCookie.map(c => c.split(';')[0]).filter(Boolean);
  console.log('  状态:', r.status);
  console.log('  cookie 数:', cookies.length);
  return cookies.join('; ');
}

// ═══════ 2. 调 RPC ═══════
async function rpc(cookie, method, params) {
  const r = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie,
      'Origin': BASE,
    },
    body: JSON.stringify(params || {}),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, json, text: text.slice(0, 200) };
}

(async () => {
  console.log('=== 建会话 ===');
  console.log();

  const cookie = await getCookie();
  if (!cookie) { console.error('拿不到 cookie'); process.exit(1); }

  // 先试一个请求，看 API 通不通
  console.log();
  console.log('=== 探测 API ===');
  const probe = await rpc(cookie, 'session/list', {});
  console.log('  session/list → HTTP', probe.status);
  if (probe.json) {
    console.log('  返回:', JSON.stringify(probe.json).slice(0, 300));
  } else {
    console.log('  原始:', probe.text);
  }

  console.log();
  console.log('=== 工作区列表 ===');
  const wsList = await rpc(cookie, 'workspace/list', {});
  console.log('  workspace/list → HTTP', wsList.status);
  if (wsList.json) {
    console.log('  ' + JSON.stringify(wsList.json).slice(0, 500));
  }

  process.exit(0);
})();
