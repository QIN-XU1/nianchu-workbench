/**
 * 把场景会话切到 pursueray provider
 *
 * 问题：已有会话绑定的是 deepseek-official（余额不足）
 * 需要：把所有场景会话的模型切到 pursueray
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const WB = 'D:/file/AI Temp/DeepSeek/Agent自研/workbench';
const PORT = 3083;
const PROVIDER = process.argv[2] || 'pursueray';
const MODEL = process.argv[3] || 'deepseek-v4-pro';

function getToken() {
  const s = fs.readFileSync(path.join(WB, '外壳', 'server.log'), 'utf8');
  const m = [...s.matchAll(/token=([A-Za-z0-9_-]{20,})/g)];
  return m.length ? m[m.length - 1][1] : null;
}

function req(method, p, body, cookie) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : '';
    const r = http.request({
      hostname: '127.0.0.1', port: PORT, path: p, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d), ...(cookie ? { cookie } : {}) },
      timeout: 60000,
    }, (re) => { let b = ''; re.on('data', (c) => { b += c; }); re.on('end', () => res({ h: re.headers, b })); });
    r.on('error', () => res({ h: {}, b: '' }));
    r.on('timeout', () => { r.destroy(); res({ h: {}, b: '' }); });
    r.write(d); r.end();
  });
}

let cookie = '';
async function connect() {
  const r = await req('GET', '/?token=' + getToken());
  const sc = r.h['set-cookie'];
  cookie = Array.isArray(sc) ? sc.map((c) => c.split(';')[0]).join('; ') : '';
}
await connect();

async function rpc(channel, endpoint, args) {
  const call = async () => {
    const r = await req('POST', '/api/' + channel + '/' + endpoint, {
      type: 'client-request', rpcId: crypto.randomUUID(),
      method: channel + '/' + endpoint, payload: { args: args || {} },
    }, cookie);
    try { return JSON.parse(r.b); } catch { return { raw: r.b }; }
  };
  let res = await call();
  if (!res?.result) { await connect(); res = await call(); }
  return res;
}

console.log('═'.repeat(72));
console.log('  切换场景会话到 ' + PROVIDER + ' / ' + MODEL);
console.log('═'.repeat(72));
console.log();

// 列出所有会话
const list = await rpc('session', 'list', { _request: {} });
const sessions = list?.result?.value?.items || [];
console.log('总会话: ' + sessions.length);
console.log();

let switched = 0;
let failed = 0;

for (const s of sessions) {
  const sid = s.sessionId || s.id;
  const cwdRaw = String(s.cwd || '');
  // 只处理场景注入目录的会话
  if (!cwdRaw.includes('场景注入')) {
    console.log('  ⏭  ' + String(sid).slice(0, 44) + '  （非场景会话）');
    continue;
  }
  const scene = (cwdRaw.match(/场景注入[\\/]([^\\/]+)/) || [])[1] || '?';

  const sel = await rpc('session', 'selectModel', {
    request: { sessionId: sid, provider: PROVIDER, model: MODEL },
  });

  if (sel?.result?.ok) {
    switched++;
    console.log('  ✓ ' + scene.padEnd(20) + String(sid).slice(0, 40));
  } else {
    failed++;
    const err = sel?.result?.error?.message || JSON.stringify(sel?.result?.error || sel?.raw || '');
    console.log('  ✗ ' + scene.padEnd(20) + String(sid).slice(0, 40) + '  ' + String(err).slice(0, 80));
  }
}

console.log();
console.log('═'.repeat(72));
console.log('  成功 ' + switched + ' 个，失败 ' + failed + ' 个');
console.log('═'.repeat(72));

// 验证一个会话
if (switched > 0) {
  console.log();
  console.log('验证：新会话默认用什么 provider');
  // ⚠ 2026-11-12 修（用废弃目录当 cwd）
  //
  //   原来：path.join(WB, '数据', '.dsh', '场景注入', 'arch-review')
  //   但第 14 轮「场景工作目录迁移（方案 A）」后，
  //   会话 cwd 已改为 数据/.dsh/场景记忆/<场景名>/。
  //   用旧目录建验证会话会在废弃目录里生成 session 记录，且和真实场景不一致。
  //
  //   修法：用真实场景目录。
  const cwd = path.join(WB, '数据', '.dsh', '场景记忆', '架构梳理');
  const created = await rpc('session', 'create', { request: { cwd } });
  const newSid = created?.result?.value?.sessionId;
  console.log('  新会话: ' + newSid);
  const sel2 = await rpc('session', 'selectModel', {
    request: { sessionId: newSid, provider: PROVIDER, model: MODEL },
  });
  console.log('  切模型: ' + (sel2?.result?.ok ? '✓' : '✗'));

  // 发消息测试
  await rpc('session', 'prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId: newSid,
      mode: 'queue',
      content: [{ type: 'text', text: '只回答两个字：收到' }],
    },
  });
  console.log('  已发消息，等 20 秒…');
  await new Promise((r) => setTimeout(r, 20000));

  const pg = await rpc('session', 'page', {
    request: { address: { kind: 'session', sessionId: newSid }, maxMessages: 100 },
  });
  const records = pg?.result?.value?.records || [];
  const all = JSON.stringify(records);
  console.log('  records: ' + records.length);
  console.log('  request/context: ' + (all.match(/"provider":"([^"]+)"/) || ['', '?'])[1]);
  console.log('  含「收到」: ' + (all.includes('收到') ? '✓' : '✗'));
  console.log('  含余额错误: ' + (all.includes('Insufficient') ? '✗ 有' : '✓ 无'));
}
