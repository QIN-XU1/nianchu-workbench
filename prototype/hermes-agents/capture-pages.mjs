#!/usr/bin/env node
/**
 * 批量截取 hermes 桌面端各页面 —— 用来做界面设计评估。
 *
 * 为什么需要：目标第 5 条要「界面截图 + 可判定对比」。之前只有星图和首页两张，
 * 不足以判断「界面设计好不好」。这个脚本把 27 个页面里的关键几个都抓下来，
 * 同一进程连续抓，避免反复重启。
 *
 * 用法：node capture-pages.mjs [route1 route2 ...]
 * 默认抓：chat / command-center / learning / settings / agents
 */

import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9333';
const BASE = 'file:///C:/hermes/apps/desktop/dist/index.html';
const OUT = 'D:/file/AI Temp/DeepSeek/Agent自研/research/screenshots';
const ROUTES = process.argv.slice(2).length ? process.argv.slice(2) : ['chat', 'command-center', 'learning', 'settings', 'agents'];

async function send(ws, method, params = {}) {
  const id = send._id = (send._id || 0) + 1;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + method)), 30000);
    const h = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) { clearTimeout(t); ws.removeEventListener('message', h); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    };
    ws.addEventListener('message', h);
  });
}

const evalJs = (ws, expr) => send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });

(async () => {
  const list = await (await fetch(CDP + '/json')).json();
  const page = list.find((t) => t.type === 'page' && String(t.url).includes('hermes'));
  if (!page) { console.log('  ✗ 没找到 hermes 页面'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

  fs.mkdirSync(OUT, { recursive: true });
  const results = [];

  for (const route of ROUTES) {
    // 只改 hash，不做整页导航 —— 整页跳转会走 file:// 解析失败（实测 -6）
    await evalJs(ws, 'window.location.hash = "#/' + route + '"; "ok"');
    await new Promise((r) => setTimeout(r, 3500));

    const info = await evalJs(ws, `(() => {
      const txt = (document.body.innerText || '');
      return {
        route: location.hash,
        chars: txt.length,
        blocks: txt.split('\\n').filter(s => s.trim()).length,
        buttons: document.querySelectorAll('button,[role=button]').length,
        inputs: document.querySelectorAll('input,textarea,[contenteditable]').length,
        canvases: document.querySelectorAll('canvas').length,
        title: (document.querySelector('h1,h2,[class*=title]')?.textContent || '').trim().slice(0, 60),
        head: txt.split('\\n').filter(s => s.trim()).slice(0, 6),
      };
    })()`);

    const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, 'ui-' + route + '.png');
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));

    results.push({ route, ...info.result.value, file });
    console.log('  ✓ ' + route.padEnd(18) + ' 字符 ' + String(info.result.value.chars).padStart(5) +
      ' · 块 ' + String(info.result.value.blocks).padStart(3) +
      ' · 按钮 ' + String(info.result.value.buttons).padStart(3) +
      ' · 输入 ' + String(info.result.value.inputs).padStart(2) +
      ' · canvas ' + info.result.value.canvases);
  }

  fs.writeFileSync(path.join(OUT, '_pages.json'), JSON.stringify(results, null, 2), 'utf8');
  ws.close();
  console.log('');
  console.log('  截图已存 ' + OUT);
})();
