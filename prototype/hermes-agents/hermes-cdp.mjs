#!/usr/bin/env node
/**
 * hermes 桌面端 CDP 验证器：导航到指定路由 → 读 DOM 断言 → 截图。
 *
 * 为什么不用 API：/api/learning/graph 要鉴权（{"detail":"Unauthorized"}），
 * 而界面才是要交付的东西。CDP 看到的就是用户看到的，截图即证据。
 *
 * 用法：
 *   node hermes-cdp.mjs <route> <截图输出路径> [等待毫秒]
 *   node hermes-cdp.mjs /starmap out.png 8000
 */

import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9333';
const route = process.argv[2] || '/';
const outPath = process.argv[3] || 'shot.png';
const settleMs = Number(process.argv[4] || 6000);

const list = await (await fetch(CDP + '/json/list')).json();
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
if (!page) {
  console.log('  ✗ 没有可用的 page target');
  console.log('    targets: ' + list.map((t) => t.type + ' ' + t.url.slice(0, 60)).join(' | '));
  process.exit(1);
}
console.log('  目标页: ' + page.url.slice(0, 90));

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const events = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  } else if (msg.method) {
    events.push(msg);
  }
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

await send('Page.enable');
await send('Runtime.enable');

// Hermes 桌面端是 file:// 加载 + hash 路由：
//   file:///C:/hermes/apps/desktop/dist/index.html#/local-xxxx
// 所以不能 new URL('/starmap', page.url) —— 那会解析成 file:///C:/starmap，
// 整页替换成「Hermes couldn't start」错误页。只能改 hash。
const baseUrl = (() => {
  const u = new URL(page.url);
  u.hash = '';
  if (!u.pathname.endsWith('.html')) {
    // 已经被打到错误页：回到应用的 index.html
    return 'file:///C:/hermes/apps/desktop/dist/index.html';
  }
  return u.toString();
})();
const hashRoute = route.startsWith('#') ? route : '#' + (route.startsWith('/') ? route : '/' + route);
const target = baseUrl + hashRoute;
console.log('  导航到: ' + target);
await send('Page.navigate', { url: target });

// 等渲染稳定
await new Promise((r) => setTimeout(r, settleMs));

// DOM 断言
const probe = await send('Runtime.evaluate', {
  expression: `(() => {
    const txt = document.body ? document.body.innerText : '';
    const canvases = [...document.querySelectorAll('canvas')].map(c => ({ w: c.width, h: c.height }));
    const svgs = document.querySelectorAll('svg').length;
    return {
      url: location.href,
      title: document.title,
      textLen: txt.length,
      textHead: txt.slice(0, 400),
      canvasCount: canvases.length,
      canvases,
      svgCount: svgs,
      hasSceneWords: /中枢|架构梳理|工具工坊|调研|实现|设计|运维|质量/.test(txt),
      sceneHits: (txt.match(/中枢|架构梳理|实施计划|后端工坊|前端工坊|工具工坊|调研|竞品拆解|逆向分析|故障分析|本地电脑|自我复盘/g) || []).length,
    };
  })()`,
  returnByValue: true,
});
const info = probe.result?.value || {};
console.log('  URL:      ' + info.url);
console.log('  文字长度: ' + info.textLen);
console.log('  canvas:   ' + info.canvasCount + ' 个 ' + JSON.stringify(info.canvases));
console.log('  svg:      ' + info.svgCount);
console.log('  场景词命中: ' + info.sceneHits);
console.log('  文字开头: ' + String(info.textHead || '').replace(/\n/g, ' ⏎ ').slice(0, 220));

// 截图
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
const kb = Math.round(fs.statSync(outPath).size / 1024);
console.log('  截图: ' + outPath + ' (' + kb + ' KB)');

// 控制台错误
const errs = events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
if (errs.length) {
  console.log('  ⚠ 控制台错误 ' + errs.length + ' 条，前 3：');
  for (const e of errs.slice(0, 3)) {
    const d = e.params.exceptionDetails || e.params;
    console.log('    ' + JSON.stringify(d).slice(0, 180));
  }
} else {
  console.log('  控制台无错误');
}

ws.close();
process.exit(info.sceneHits > 0 ? 0 : 2);
