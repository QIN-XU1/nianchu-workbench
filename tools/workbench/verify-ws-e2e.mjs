#!/usr/bin/env node
/**
 * 念初工作台 WS 端到端测试 —— 验证**实时交互通道**（agent 运行/取消/注入都走 WS）。
 *
 * HTTP e2e（第 75 轮）验证的是请求-响应端点；但产品核心交互（会话、运行、中断）走
 *   WebSocket JSON-RPC 2.0（/ws）。内核全绿 + HTTP 能用 ≠ WS 通道可用，所以单测这一层。
 *
 * 用 Node 24 全局 WebSocket 连接 ws://127.0.0.1:47124/ws，发真实 JSON-RPC。
 * 前置：serve.mjs 在跑；否则 UNKNOWN 退出 2。
 */
const WSURL = process.env.NIANCHU_WS || 'ws://127.0.0.1:47124/ws';
import { ensureServer, stopServer } from './_serve.mjs';
const _BASE = WSURL.replace(/^ws/, 'http').replace(/\/ws$/, '');
const _srv = await ensureServer(_BASE);
if (!_srv.ok) {
  console.error('  ⚠ ' + _srv.why + ' → UNKNOWN（环境问题，不是代码缺陷）');
  await stopServer(_srv.child);
  process.exit(2);
}
console.log('  · ' + _srv.why);
let pass = 0, fail = 0;
const t = (n, c, i = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (i ? ' ← ' + i : '')); } };

const ws = new WebSocket(WSURL);
let seq = 0;
const pending = new Map();
const events = [];
const openP = new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(new Error('WS 连接失败')); });
ws.onmessage = (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m && m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else events.push(m);
};
function call(method, params = {}, timeoutMs = 8000) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, timeoutMs);
  });
}
const ok = (r) => r && (r.result !== undefined) && !r.error;
const err = (r) => r && r.error;

try { await openP; } catch { console.error('  ✗ ' + WSURL + ' 不可达（先 node tools/workbench/serve.mjs）'); process.exit(2); }

// 1. 只读方法
{
  const r = await call('list_sessions', {});
  t('list_sessions 有 result', ok(r), JSON.stringify(r).slice(0, 100));
}
{
  const r = await call('get_available_modes', {});
  t('get_available_modes 有 result', ok(r), JSON.stringify(r).slice(0, 100));
}
{
  const r = await call('get_current_workspace', {});
  t('get_current_workspace 有 result', ok(r), JSON.stringify(r).slice(0, 80));
}
// 2. 会话往返（真实会话存储）
let sid = null;
{
  const r = await call('create_session', { request: { sessionName: 'ws-e2e-' + Date.now() } });
  sid = r.result && (r.result.sessionId || r.result.id || (r.result.session && r.result.session.sessionId));
  t('create_session 返回 sessionId', ok(r) && Boolean(sid), JSON.stringify(r).slice(0, 120));
}
if (sid) {
  const r = await call('get_session', { request: { sessionId: sid } });
  const got = r.result && (r.result.sessionId === sid || (r.result.session && r.result.session.sessionId === sid) || JSON.stringify(r.result).includes(sid));
  t('get_session 取回刚建的会话', ok(r) && got, JSON.stringify(r).slice(0, 120));
}
// 3. 运行通道 + 中断（C1 可中断）：start_run 立刻返回 runId；cancel_run 可取消
let runId = null;
{
  const r = await call('start_run', { request: { task: 'ws-e2e 冒烟：随便说一句', maxSteps: 1 } });
  runId = r.result && r.result.runId;
  t('start_run 立刻返回 runId（异步启动）', ok(r) && Boolean(runId), JSON.stringify(r).slice(0, 140));
}
if (runId) {
  const r = await call('cancel_run', { request: { runId, reason: 'ws-e2e 取消' } });
  t('cancel_run 接受取消', ok(r) && r.result && r.result.state === 'PASS', JSON.stringify(r).slice(0, 120));
}
// 4. 反例：未知方法必须回 JSON-RPC error，不能静默/崩溃
{
  const r = await call('totally_unknown_method_xyz', {});
  t('反例:未知方法 → JSON-RPC error', Boolean(err(r)), JSON.stringify(r).slice(0, 120));
}
// 5. 反例：get_session 无参 → 结构化错误（不是崩溃）
{
  const r = await call('get_session', { request: {} });
  // 可接受：JSON-RPC error，或结构化 result（含 state，如 UNKNOWN 'session not found'）——关键是**不崩不挂**
  t('反例:get_session 缺 sessionId → 结构化响应（不崩）', Boolean(err(r)) || (r.result && typeof r.result === 'object' && ('state' in r.result || 'ok' in r.result || 'sessionId' in r.result)), JSON.stringify(r).slice(0, 120));
}
// 6. 通道仍存活：再发一个只读方法
{
  const r = await call('list_sessions', {});
  t('全部请求后 WS 通道仍存活', ok(r));
}

try { ws.close(); } catch {}
await stopServer(_srv.child);
console.log(`\n  结果：通过 ${pass} · 失败 ${fail}`);
console.log('  四态: ' + (fail === 0 ? 'PASS' : 'FAIL'));
process.exit(fail === 0 ? 0 : 1);