#!/usr/bin/env node
/**
 * 主 agent 全链路验证 —— WebSocket → 宿主 → 模型 → 落盘。
 *
 * 【为什么必须有这个文件】
 * 用户三次说「主 agent 不可用」，我三次以为是样式问题，都改错了地方。
 * 真正的根因是宿主缺会话通道（台账 H-0192）。补完之后**必须能证明**：
 *   ① 宿主真的注册了这些方法（不是写在注释里）
 *   ② 真的能建会话
 *   ③ 真的能收到模型回复（内容非空 + usage 是真实数字）
 *   ④ 消息真的落盘了（重启后还在）
 *
 * 判据全部来自**实际 WebSocket 往返**，不读源码、不看注释。
 * 任何一步失败就是 FAIL，不把失败说成通过。
 *
 * 用法：node tools/agent/verify-agent-channel.mjs
 * 四态：0 = PASS / 1 = FAIL / 2 = UNKNOWN
 */
import { WebSocket } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { USER_DATA_DIR } from './runtime.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// 产品是单进程：界面/API/WebSocket 都在 47124（tools/workbench/serve.mjs）。
// 8080 只是历史的独立调试端口，默认不再用它。
const WS_URL = process.env.NIANCHU_WS || 'ws://127.0.0.1:47124/ws';

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

/** 最小 WS 客户端：一次连接，多次请求 */
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const pending = new Map();
    let seq = 0;
    const timer = setTimeout(() => reject(new Error('连接超时 8s')), 8000);

    ws.onopen = () => { clearTimeout(timer); resolve(api); };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error('连接失败: ' + String(e && e.message))); };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      const id = msg && msg.id;
      if (id !== undefined && id !== null && pending.has(id)) {
        const { res, rej, to } = pending.get(id);
        pending.delete(id);
        clearTimeout(to);
        if (msg.error) rej(new Error(msg.error.message || 'rpc error'));
        else res(msg.result);
      }
    };

    const api = {
      call(method, params, timeoutMs = 90000) {
        return new Promise((res, rej) => {
          const id = ++seq;
          const to = setTimeout(() => {
            pending.delete(id);
            rej(new Error('RPC 超时 ' + timeoutMs + 'ms: ' + method));
          }, timeoutMs);
          pending.set(id, { res, rej, to });
          ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        });
      },
      close() { try { ws.close(); } catch { /* ignore */ } },
    };
  });
}

console.log('');
console.log('  主 agent 全链路验证 · ' + WS_URL);
console.log('  ' + '─'.repeat(72));

let api;
try {
  api = await connect();
} catch (e) {
  console.log('  ❔ ' + String(e.message));
  console.log('  （宿主没起？先跑 node tools/hostapi/ws-host.mjs）');
  console.log('');
  console.log('  四态: UNKNOWN —— 连不上宿主，判不了');
  console.log('');
  process.exit(2);
}

// ① 宿主注册了方法
let impl = [];
try {
  // 产品服务器把页面挂在 /，方法清单在 /api/host-status。
  // 独立调试模式的宿主（ws-host.mjs 直跑）根路径也返回方法列表 —— 两处都试。
  const base = WS_URL.replace('ws://', 'http://').replace(/\/ws$/, '');
  for (const u of [base + '/api/host-status', base + '/']) {
    const res = await fetch(u, { signal: AbortSignal.timeout(6000) });
    const j = await res.json().catch(() => null);
    if (j && Array.isArray(j.implemented)) { impl = j.implemented; break; }
  }
} catch { /* ignore */ }
const need = ['create_assistant_workspace', 'list_sessions', 'create_session', 'start_dialog_turn'];
t('宿主注册了会话通道方法（4 个）', need.every((m) => impl.includes(m)),
  '缺 ' + need.filter((m) => !impl.includes(m)).join(', '));

// ② 助手工作区
let ws = null;
try {
  ws = await api.call('create_assistant_workspace', {});
} catch (e) { ws = null; }
t('create_assistant_workspace 返回 id', !!(ws && ws.id), ws ? '' : '返回空');

// ③ 列会话
let list = [];
try {
  const r = await api.call('list_sessions', {});
  list = Array.isArray(r) ? r : (r && r.sessions) || [];
} catch { list = []; }
t('list_sessions 返回数组', Array.isArray(list), '类型不对');

// ④ 建会话
let session = null;
try {
  session = await api.call('create_session', { request: { sessionName: '验证会话', workspaceId: ws?.id } });
} catch (e) { session = null; }
t('create_session 返回 sessionId', !!(session && session.sessionId));

// ⑤★ 真发一句话，拿真回复
let turn = null;
const probe = '请只回复两个字：收到';
const t0 = Date.now();
try {
  turn = await api.call('start_dialog_turn', {
    request: { sessionId: session?.sessionId, content: probe },
  }, 120000);
} catch (e) {
  turn = { state: 'FAIL', reason: String(e.message) };
}
const ms = Date.now() - t0;

t('start_dialog_turn 四态为 PASS', turn && turn.state === 'PASS',
  turn ? String(turn.reason || turn.state) : '无返回');
t('回复内容非空', !!(turn && typeof turn.content === 'string' && turn.content.trim().length > 0),
  turn ? 'content=' + JSON.stringify(String(turn.content ?? '').slice(0, 40)) : '');
t('usage 是真实数字（in>0, out>0）',
  !!(turn && turn.usage && turn.usage.prompt_tokens > 0 && turn.usage.completion_tokens > 0),
  turn && turn.usage ? JSON.stringify(turn.usage) : '无 usage');

// ⑥ 消息真的落盘了
let disk = null;
if (session?.sessionId) {
  // 用户数据在平台用户目录（runtime.mjs 导出的 USER_DATA_DIR），不在仓库里
    const p = join(USER_DATA_DIR, 'sessions', session.sessionId + '.jsonl');
  if (existsSync(p)) {
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
    disk = { path: p, lines: lines.length, hasUser: false, hasAssistant: false };
    for (const l of lines) {
      let m; try { m = JSON.parse(l); } catch { continue; }
      if (m.role === 'user' && String(m.content).includes('收到')) disk.hasUser = true;
      if (m.role === 'assistant' && m.content) disk.hasAssistant = true;
    }
  }
}
t('用户消息已落盘', !!(disk && disk.hasUser), disk ? '文件在但没找到这条' : '文件不存在');
t('助手回复已落盘', !!(disk && disk.hasAssistant), disk ? '文件在但没找到回复' : '文件不存在');

// ⑦ 重启后还能读到（用 get_session 反查）
let back = null;
try {
  back = await api.call('get_session', { sessionId: session?.sessionId });
} catch { back = null; }
const backMsgs = (back && back.messages) || [];
t('get_session 能读回历史（含 user + assistant）',
  backMsgs.some((m) => m.role === 'user') && backMsgs.some((m) => m.role === 'assistant'),
  '读回 ' + backMsgs.length + ' 条');

// ⑧ ★反例：不存在的会话必须如实报 UNKNOWN，不能编造
let bogus = null;
try { bogus = await api.call('get_session', { sessionId: 'no-such-session-xyz' }); } catch { bogus = null; }
t('★反例：不存在的会话返回 UNKNOWN 而不是空成功',
  !!(bogus && bogus.state === 'UNKNOWN'),
  bogus ? 'state=' + bogus.state : '无返回');

// ⑨ ★反例：空内容必须 FAIL
let empty = null;
try { empty = await api.call('start_dialog_turn', { request: { sessionId: session?.sessionId, content: '' } }); }
catch (e) { empty = { state: 'FAIL', reason: 'threw' }; }
t('★反例：空内容被拒（FAIL）', !!(empty && empty.state === 'FAIL'),
  empty ? 'state=' + empty.state : '无返回');

api.close();

console.log('');
console.log('  链路耗时: ' + ms + 'ms');
if (turn && turn.state === 'PASS') {
  console.log('  模型: ' + turn.model);
  console.log('  回复: ' + String(turn.content).slice(0, 100).replace(/\n/g, ' '));
  console.log('  usage: in=' + turn.usage.prompt_tokens + ' out=' + turn.usage.completion_tokens);
  console.log('  落盘: ' + join(USER_DATA_DIR, 'sessions', session.sessionId + '.jsonl') + '（' + (disk?.lines ?? 0) + ' 行）');
}
console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 会话/对话/落盘全链路真实可用'
  : 'FAIL —— 有环节没通'));
console.log('');
process.exit(fails.length === 0 ? 0 : 1);