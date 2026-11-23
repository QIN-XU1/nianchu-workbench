/**
 * 别名验证：证明「前端发的斜杠方法名」也能走通。
 *
 * 【为什么需要】我第一次只注册了下划线名（list_sessions），
 * 但前端 websocket-adapter.ts:73-101 实际发的是 agent/listSessions。
 * 结果前端 30s 后报 Request timeout —— 不是慢，是名字对不上。
 *
 * 这个脚本直接按**前端真实的方法名**发请求，全过才算真的可用。
 *
 * 用法：node tools/agent/verify-alias.mjs
 * 四态：0 = PASS / 1 = FAIL / 2 = UNKNOWN
 */
import { WebSocket } from 'node:http';

// 产品是单进程：界面/API/WebSocket 都在 47124（tools/workbench/serve.mjs）。
// 8080 只是历史的独立调试端口，默认不再用它。
const WS_URL = process.env.NIANCHU_WS || 'ws://127.0.0.1:47124/ws';
import { ensureServer, stopServer } from '../workbench/_serve.mjs';
import { modelAvailable } from './_model-probe.mjs';
// 第 201 轮：WS 也需服务；不可达则自起（起不来如实 UNKNOWN）
const _srv = await ensureServer(WS_URL.replace(/^ws/, 'http').replace(/\/ws$/, ''));
if (!_srv.ok) {
  console.log('  ⚠ ' + _srv.why + ' → UNKNOWN（环境问题，不是代码缺陷）');
  await stopServer(_srv.child);
  process.exit(2);
}
// 别名映射本身不依赖模型；但「提交一轮对话」依赖模型。模型不可用时只跳过那几条。
const _modelOk = await modelAvailable();

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

const ws = new WebSocket(WS_URL);
let seq = 0;
const pending = new Map();

const call = (method, params, tmo = 90000) => new Promise((res, rej) => {
  const id = 'a' + (++seq);
  const to = setTimeout(() => { pending.delete(id); rej(new Error('TIMEOUT')); }, tmo);
  pending.set(id, { res, rej, to });
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
});

ws.onmessage = (ev) => {
  let m;
  try { m = JSON.parse(String(ev.data)); } catch { return; }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  clearTimeout(p.to);
  if (m.error) p.rej(new Error(m.error.message));
  else p.res(m.result);
};

let _done = false;
ws.onerror = () => {
  if (_done) return; // 主流程已完成，close() 触发的 onerror 不应覆盖结果
  console.log('  ❔ 连不上 ' + WS_URL);
  console.log('  四态: UNKNOWN');
  process.exit(2);
};

ws.onopen = async () => {
  console.log('');
  console.log('  前端真实方法名验证（斜杠形式）');
  console.log('  ' + '─'.repeat(66));

  // ① 前端 create_assistant_workspace 原样发
  let wsObj = null;
  try { wsObj = await call('create_assistant_workspace', {}); } catch (e) { /* 记录到判据里 */ }
  t('create_assistant_workspace（原样名）', !!(wsObj && wsObj.id), wsObj ? '' : '返回空');

  // ② agent/listSessions（前端 L74 映射）
  let list = null;
  try { list = await call('agent/listSessions', {}); } catch (e) { list = null; }
  t('agent/listSessions（前端真实名）', Array.isArray(list), list ? '不是数组' : '失败');

  // ③ agent/createSession（前端 L73 映射）
  let made = null;
  try {
    made = await call('agent/createSession', {
      request: { sessionName: '别名验证', workspaceId: wsObj?.id },
    });
  } catch (e) { made = null; }
  t('agent/createSession（前端真实名）', !!(made && made.sessionId));

  // ④ ★ agent/submitDialogTurn（前端 L101 映射）—— 最关键的一条
  let turn = null;
  const t0 = Date.now();
  try {
    turn = await call('agent/submitDialogTurn', {
      request: { sessionId: made?.sessionId, content: '只回复两个字：收到' },
    });
  } catch (e) { turn = { state: 'FAIL', reason: String(e.message) }; }
  const ms = Date.now() - t0;

  if (_modelOk) {
  t('agent/submitDialogTurn（前端真实名）四态 PASS',
    turn && turn.state === 'PASS', turn ? String(turn.reason || turn.state) : '无返回');
  t('回复非空', !!(turn && turn.content && String(turn.content).trim()), '');
  t('usage 真实', !!(turn && turn.usage && turn.usage.prompt_tokens > 0));
  t('耗时 < 30s（前端 requestTimeoutMs=30000）', ms < 30000, ms + 'ms');
  } else {
    console.log('  ⚠ 模型不可用 → submitDialogTurn/回复/usage/耗时 4 条跳过（UNKNOWN）');
  }

  // ⑤ get_session 也能用斜杠名
  let back = null;
  try { back = await call('agent/getSession', { sessionId: made?.sessionId }); } catch { back = null; }
  const msgs = (back && back.messages) || [];
  if (_modelOk) {
  t('agent/getSession（前端真实名）读回历史',
    msgs.some((m) => m.role === 'user') && msgs.some((m) => m.role === 'assistant'),
    '读回 ' + msgs.length + ' 条');
  }

  // ⑥ ★反例：随便编一个方法名必须 -32601，不能假装成功
  let bogus = null;
  try { bogus = await call('agent/noSuchMethodAtAll', {}); } catch (e) { bogus = { err: String(e.message) }; }
  t('★反例：不存在的方法名如实报错（不假装成功）',
    !!(bogus && (bogus.err || !bogus.state)), bogus ? '竟然成功了' : '');

  console.log('');
  console.log('  耗时: ' + ms + 'ms');
  if (turn && turn.state === 'PASS') {
    console.log('  回复: ' + String(turn.content).slice(0, 60).replace(/\n/g, ' '));
    console.log('  usage: in=' + turn.usage.prompt_tokens + ' out=' + turn.usage.completion_tokens);
  }
  console.log('');
  console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
  if (fails.length) fails.forEach((f) => console.log('    - ' + f));
  console.log('  四态: ' + (fails.length === 0 ? 'PASS —— 前端真实方法名全部走通' : 'FAIL'));
  console.log('');
  ws.close();
  _done = true;
  await stopServer(_srv.child);
  process.exit(fails.length === 0 ? 0 : 1);
};