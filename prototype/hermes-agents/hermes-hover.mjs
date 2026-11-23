#!/usr/bin/env node
/**
 * 在 hermes 页面上做鼠标悬停 + 截图，用来验证 canvas 图形的悬停卡片。
 *
 * 星图的节点标签不是常驻绘制的 —— render.ts 只在 hover 时用 nodeFooter()/wrapText()
 * 画悬停卡片。所以「界面上看得见中文场景名」这件事必须用悬停来证明。
 *
 * 用法：node hermes-hover.mjs <x> <y> <截图输出> [截图前等待毫秒]
 */

import fs from 'node:fs';

const CDP = 'http://127.0.0.1:9333';
const [x, y, out, waitMs] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4] || 'hover.png', Number(process.argv[5] || 1200)];

const list = await (await fetch(CDP + '/json/list')).json();
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
if (!page) { console.log('  ✗ 没有 page target'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq;
  pending.set(id, { resolve });
  ws.send(JSON.stringify({ id, method, params }));
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

// 先把鼠标挪到别处，再移到目标，让 hover 状态真实触发
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, button: 'none' });
await new Promise((r) => setTimeout(r, 250));
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
await new Promise((r) => setTimeout(r, waitMs));

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('  悬停 (' + x + ',' + y + ') → ' + out + ' (' + Math.round(fs.statSync(out).size / 1024) + ' KB)');
ws.close();
