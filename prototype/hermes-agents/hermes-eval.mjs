#!/usr/bin/env node
/**
 * 在运行中的 hermes 页面里执行一段 JS 并打印结果。
 * 用于：读页面真实数据（用页面自己的凭据抓接口）、检查渲染状态。
 *
 * 用法：node hermes-eval.mjs "<js 表达式>" [等待毫秒]
 */

const CDP = 'http://127.0.0.1:9333';
const expr = process.argv[2];
const waitMs = Number(process.argv[3] || 0);

if (!expr) { console.log('用法: node hermes-eval.mjs "<js>"'); process.exit(1); }

const list = await (await fetch(CDP + '/json/list')).json();
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
if (!page) { console.log('  ✗ 没有 page target'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve } = pending.get(m.id);
    pending.delete(m.id);
    resolve(m.result);
  }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq;
  pending.set(id, { resolve });
  ws.send(JSON.stringify({ id, method, params }));
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable');
if (waitMs) await new Promise((r) => setTimeout(r, waitMs));

const res = await send('Runtime.evaluate', {
  expression: expr,
  returnByValue: true,
  awaitPromise: true,
});
if (res.exceptionDetails) {
  console.log('  ✗ 异常: ' + JSON.stringify(res.exceptionDetails).slice(0, 400));
} else {
  const v = res.result?.value;
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
}
ws.close();
