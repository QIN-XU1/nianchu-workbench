import http from 'node:http';

const TOKEN = 'EAPcsV48H0v5Ms5QP4XND9vRiI4eS7knmVz681eW_Ys';
const PORT = 3080;

console.log('═══ 探明引擎 cookie 鉴权 ═══');
console.log();

function getCookie() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PORT,
      path: '/?token=' + TOKEN,
      method: 'GET',
    }, (res) => {
      console.log('GET /?token= → 状态 ' + res.statusCode);
      const sc = res.headers['set-cookie'] || [];
      console.log('  set-cookie 数: ' + sc.length);
      for (const c of sc) console.log('    ' + c);
      console.log('  location: ' + (res.headers.location || '(无)'));

      const cookies = sc.map(c => c.split(';')[0]).filter(Boolean);
      res.on('data', () => {});
      res.on('end', () => resolve({ cookies, status: res.statusCode }));
    });
    req.on('error', e => { console.log('ERR: ' + e.message); resolve({ cookies: [] }); });
    req.end();
  });
}

function rpc(cookies, method, args) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      type: 'client-request', rpcId: 'probe-1',
      method, payload: { args: args || {} },
    });
    const req = http.request({
      hostname: '127.0.0.1', port: PORT,
      path: '/api/' + method,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        ...(cookies.length ? { 'Cookie': cookies.join('; ') } : {}),
        'Origin': 'http://127.0.0.1:' + PORT,
        'Referer': 'http://127.0.0.1:' + PORT + '/',
      },
    }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 300) }));
    });
    req.on('error', e => resolve({ error: e.message }));
    req.write(body);
    req.end();
  });
}

const { cookies } = await getCookie();
console.log();
console.log('cookie: ' + (cookies.length ? cookies.join(' | ') : '(无)'));

console.log();
console.log('═══ 调用测试 ═══');
for (const m of ['session/list', 'workspace/list']) {
  const r = await rpc(cookies, m);
  console.log('  ' + m.padEnd(20) + ' → ' + r.status + '  ' + (r.body || r.error || '').slice(0, 80));
}
