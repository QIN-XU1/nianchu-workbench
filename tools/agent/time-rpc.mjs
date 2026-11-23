/**
 * 计时探针：分别测每个会话方法耗时，定位前端 30s 超时的原因。
 * 用法：node tools/agent/time-rpc.mjs
 */
import { WebSocket } from 'node:http';

const ws = new WebSocket(process.env.NIANCHU_WS || 'ws://127.0.0.1:8080/ws');
let seq = 0;
const pending = new Map();

const send = (method, params, tmo = 60000) => new Promise((res, rej) => {
  const id = 't' + (++seq);
  const to = setTimeout(() => { pending.delete(id); rej(new Error('TIMEOUT ' + method)); }, tmo);
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

ws.onopen = async () => {
  const rows = [];
  const time = async (label, fn) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      rows.push([label, Date.now() - t0, 'OK', '']);
      return r;
    } catch (e) {
      rows.push([label, Date.now() - t0, 'ERR', String(e.message).slice(0, 60)]);
      return null;
    }
  };

  await time('list_sessions', () => send('list_sessions', {}));
  const ws1 = await time('create_assistant_workspace', () => send('create_assistant_workspace', {}));
  const made = await time('create_session', () => send('create_session', { request: { sessionName: '计时', workspaceId: ws1?.id } }));
  const turn = await time('start_dialog_turn', () => send('start_dialog_turn', {
    request: { sessionId: made?.sessionId, content: '只回复两个字：收到' },
  }));
  await time('get_session', () => send('get_session', { sessionId: made?.sessionId }));

  console.log('');
  console.log('  方法耗时');
  console.log('  ' + '─'.repeat(62));
  for (const [label, ms, st, err] of rows) {
    console.log('  ' + label.padEnd(30) + String(ms).padStart(6) + 'ms  ' + st + (err ? '  ' + err : ''));
  }
  if (turn && turn.state === 'PASS') {
    console.log('');
    console.log('  回复: ' + String(turn.content).slice(0, 60).replace(/\n/g, ' '));
    console.log('  usage: in=' + turn.usage?.prompt_tokens + ' out=' + turn.usage?.completion_tokens);
  }
  const slow = rows.filter((r) => r[1] > 25000);
  console.log('');
  console.log('  超过 25s 的方法: ' + (slow.length ? slow.map((r) => r[0]).join(', ') : '无'));
  console.log('');
  ws.close();
  process.exit(slow.length ? 1 : 0);
};

ws.onerror = () => { console.log('  连接失败'); process.exit(2); };