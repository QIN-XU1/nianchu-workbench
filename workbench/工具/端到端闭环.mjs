/**
 * 端到端闭环验证 —— 真实任务，真实 AI
 *
 * ══════════════════════════════════════════════════════════════
 *  这是整个项目第一次真正跑通「中枢派单 → 场景执行」的闭环
 * ══════════════════════════════════════════════════════════════
 *
 *  链路：
 *    ① 中枢判断归属（路由表）
 *    ② 写四件套工单（派单工具）
 *    ③ 真投递到场景会话（投递通道）
 *    ④ 场景 agent 真的干活（pursueray 通道）
 *    ⑤ 结论写回场景记忆（断层 3）
 *    ⑥ 中枢验收（进度判定）
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const PORT = 3083;

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
      timeout: 300000,
    }, (re) => { let b = ''; re.on('data', (c) => { b += c; }); re.on('end', () => res({ h: re.headers, b })); });
    r.on('error', (e) => res({ h: {}, b: JSON.stringify({ error: e.message }) }));
    r.on('timeout', () => { r.destroy(); res({ h: {}, b: JSON.stringify({ error: 'timeout' }) }); });
    r.write(d); r.end();
  });
}

const token = getToken();
if (!token) { console.log('✗ 拿不到 token'); process.exit(2); }
let cookie = '';

/** 拿 cookie（可重入，cookie 失效时重连） */
async function connect() {
  const r = await req('GET', '/?token=' + token);
  const sc = r.h['set-cookie'];
  cookie = Array.isArray(sc) ? sc.map((c) => c.split(';')[0]).join('; ') : '';
  return { status: r.h ? 200 : 0, ok: !!cookie, body: r.b ? 'ok' : '' };
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
  // cookie 失效（返回空或解析失败）→ 重连一次再试
  if (!res || !res.result) {
    await connect();
    res = await call();
  }
  return res;
}

function runTool(file, args) {
  const r = spawnSync(process.execPath, [path.join(HERE, file), ...args], {
    cwd: WB, encoding: 'utf8', timeout: 120000, windowsHide: true,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

console.log('═'.repeat(72));
console.log('  端到端闭环验证（真实 AI）');
console.log('═'.repeat(72));
console.log();

// ══════════════════════════════════════════════════════════
//  ① 中枢判断归属
// ══════════════════════════════════════════════════════════
const NEED = '给架构梳理场景写一条真实的经验记录，内容是这次闭环验证的收获';
console.log('① 中枢判断归属');
console.log('   需求: ' + NEED);
const route = runTool('路由表.mjs', ['--route-json', NEED]);
let routeJson = null;
try { routeJson = JSON.parse(route.out); } catch { /* ignore */ }
console.log('   → ' + (routeJson ? routeJson.scene + '（' + routeJson.confidence + '）' : '解析失败'));
console.log();

// ══════════════════════════════════════════════════════════
//  ② 建派单
// ══════════════════════════════════════════════════════════
console.log('② 建派单（四件套）');
const subject = '闭环验证-真实AI执行-' + Date.now();
const send = runTool('派单.mjs', [
  '--send', '--from', 'hub', '--to', '架构梳理',
  '--subject', subject,
  '--phenomenon', '需要验证中枢派单能被场景 agent 真实执行',
  '--howto', '读你的场景私有记忆，在 §五 坑与决策 追加一条真实经验（关于架构梳理该注意什么）',
  '--verify', '场景私有记忆的 §五 节新增了一条内容',
]);

// 提取派单 id
const idMatch = send.out.match(/已登记:\s*(d-\d{8}-\d+)/);
const dispatchId = idMatch ? idMatch[1] : null;
console.log('   ' + (dispatchId ? '✓ ' + dispatchId : '✗ 失败\n' + send.out.slice(0, 300)));
if (!dispatchId) process.exit(2);
console.log();

// ══════════════════════════════════════════════════════════
//  ③ 真投递
// ══════════════════════════════════════════════════════════
console.log('③ 真投递');
const deliver = runTool('派单.mjs', ['--deliver', '--id', dispatchId, '--wait', '20000']);
console.log('   ' + deliver.out.split('\n').filter((l) => l.trim()).slice(0, 6).map((l) => l.trim()).join('\n   '));
console.log();

// ══════════════════════════════════════════════════════════
//  ④ 等场景 agent 干活
// ══════════════════════════════════════════════════════════
console.log('④ 等场景 agent 执行（最多 5 分钟）');

// 找 arch-review 的会话（cwd 现在指向场景记忆目录）
const listR = await rpc('session', 'list', { _request: {} });
const sessions = listR?.result?.value?.items || listR?.result?.value?.sessions || [];
const norm = (p) => String(p || '').split('\\').join('/').toLowerCase();
const ARCH_CWD = norm(path.join(WB, '数据', '.dsh', '场景记忆', '架构梳理'));
const archSessions = sessions.filter((s) => {
  const cwd = norm(s.cwd || s.workspace || '');
  return cwd === ARCH_CWD || cwd.startsWith(ARCH_CWD + '/');
});
// 取最新的
archSessions.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
console.log('   arch-review 会话: ' + archSessions.length + ' 个');
if (process.env.DEBUG_LOOP) {
  console.log('   [debug] listR.ok=' + (listR?.result?.ok) + ' sessions=' + sessions.length);
  console.log('   [debug] 期望=' + ARCH_CWD);
  for (const s of sessions.slice(0, 3)) {
    console.log('   [debug] 实际=' + norm(s.cwd));
  }
}

if (archSessions.length === 0) { console.log('   ✗ 没有会话'); process.exit(2); }
const sid = archSessions[0].sessionId || archSessions[0].id;
console.log('   使用: ' + sid);
console.log();

const memFile = path.join(WB, '数据', '.dsh', '场景记忆', '架构梳理', '场景私有记忆.md');
const beforeMem = fs.readFileSync(memFile, 'utf8');
const beforeLen = Buffer.byteLength(beforeMem, 'utf8');
console.log('   记忆文件当前: ' + beforeLen + ' B');

let done = false;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const pg = await rpc('session', 'page', {
    request: { address: { kind: 'session', sessionId: sid }, maxMessages: 300 },
  });
  const records = pg?.result?.value?.records || [];

  // 判是否结束 + 有无错误
  let lastEnd = null;
  let lastErr = null;
  for (const rec of records) {
    const ev = rec.event || rec;
    if (ev.type === 'turn/end') {
      lastEnd = ev.data?.reason?.kind;
      if (lastEnd === 'error') lastErr = ev.data?.reason?.error?.message;
    }
  }

  const nowMem = fs.readFileSync(memFile, 'utf8');
  const memChanged = nowMem !== beforeMem;

  if (i % 4 === 0) {
    process.stdout.write('   … ' + ((i + 1) * 5) + 's  记录 ' + records.length +
      '  记忆' + (memChanged ? '已变' : '未变') + '\n');
  }

  if (memChanged || (lastEnd === 'completed' && i > 3)) {
    done = true;
    console.log('   结束: turn/end=' + lastEnd + '  记忆变化=' + memChanged);
    if (lastErr) console.log('   错误: ' + lastErr.slice(0, 150));
    break;
  }
  if (lastEnd === 'error') {
    console.log('   出错: ' + (lastErr || '').slice(0, 200));
    break;
  }
}

console.log();

// ══════════════════════════════════════════════════════════
//  ⑤ 检查记忆是否写回
// ══════════════════════════════════════════════════════════
console.log('⑤ 检查记忆写回');
const afterMem = fs.readFileSync(memFile, 'utf8');
const afterLen = Buffer.byteLength(afterMem, 'utf8');
console.log('   ' + beforeLen + ' B → ' + afterLen + ' B  (' +
  (afterLen > beforeLen ? '+' : '') + (afterLen - beforeLen) + ')');

if (afterMem !== beforeMem) {
  console.log('   ✓ 记忆文件被修改');
  // 找新增行
  const beforeLines = new Set(beforeMem.split('\n'));
  const added = afterMem.split('\n').filter((l) => l.trim() && !beforeLines.has(l));
  console.log('   新增 ' + added.length + ' 行:');
  for (const l of added.slice(0, 8)) console.log('     + ' + l.slice(0, 90));
} else {
  console.log('   ✗ 记忆未变');
  // 看 AI 说了什么
  const pg = await rpc('session', 'page', {
    request: { address: { kind: 'session', sessionId: sid }, maxMessages: 300 },
  });
  const records = pg?.result?.value?.records || [];
  let lastAssistant = '';
  for (const rec of records) {
    const ev = rec.event || rec;
    if (ev.type === 'assistant/message') {
      const c = ev.data?.content || [];
      if (Array.isArray(c)) lastAssistant = c.filter((x) => x.type === 'text').map((x) => x.text).join('');
    }
  }
  if (lastAssistant) {
    console.log('   AI 最后回复:');
    console.log('   ' + lastAssistant.slice(0, 600).split('\n').join('\n   '));
  }
}

console.log();
console.log('═'.repeat(72));
console.log('  闭环结果');
console.log('═'.repeat(72));
console.log('  ① 判断归属: ' + (routeJson?.scene ? '✓' : '✗'));
console.log('  ② 建派单:   ' + (dispatchId ? '✓' : '✗'));
console.log('  ③ 真投递:   ' + (deliver.code === 0 ? '✓' : '✗'));
console.log('  ④ AI 执行:  ' + (done ? '✓' : '✗'));
console.log('  ⑤ 记忆写回: ' + (afterMem !== beforeMem ? '✓' : '✗'));
console.log();

if (afterMem !== beforeMem) {
  console.log('  🎉 完整闭环打通！这是项目第一次真实跑通「中枢 → 场景 → 记忆」。');
} else {
  console.log('  ⚠ 闭环未完成，原因见上');
}
