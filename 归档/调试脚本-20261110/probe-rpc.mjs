/**
 * 探测引擎有哪些 RPC 方法（特别是模型相关的）
 */
const BASE = 'http://127.0.0.1:3080';
const TOKEN = '3yeNHhvSWx9Ej_Xc4pHDGeLdhCz6mAEpyH6k7EPRw4s';

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
    body: JSON.stringify({ type: 'client-request', rpcId: 'r' + (seq++), method, payload: { args: args || {} } }),
    signal: AbortSignal.timeout(15000),
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

  const METHODS = [
    'model/list', 'models/list', 'model/catalog', 'provider/list', 'providers/list',
    'settings/get', 'config/get', 'session/list', 'workspace/list',
    'agent/presets', 'preset/list',
  ];

  console.log('=== 探测 RPC 方法 ===');
  for (const m of METHODS) {
    try {
      const r = await rpc(m, {});
      const ok = r.j && r.j.result && r.j.result.ok !== false;
      let brief = '';
      if (r.j && r.j.result) {
        if (r.j.result.value) {
          brief = JSON.stringify(r.j.result.value).slice(0, 150);
        } else if (r.j.result.error) {
          brief = 'ERR: ' + (r.j.result.error.message || r.j.result.error.code || '').slice(0, 60);
        }
      } else {
        brief = r.t.slice(0, 80);
      }
      console.log(`  ${ok ? '✓' : '✗'} ${m.padEnd(22)} ${r.status}  ${brief}`);
    } catch (e) {
      console.log(`  ✗ ${m.padEnd(22)} 异常 ${e.message.slice(0, 40)}`);
    }
  }
})();
