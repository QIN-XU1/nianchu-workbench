#!/usr/bin/env node
/**
 * 用 hermes 的 Electron 窗口当浏览器：加载产品官网 → 截图 → 还原。
 *
 * 为什么这么做：
 *   - web_search / web_fetch 因 DeepSeek 余额 402 不可用
 *   - curl 抓 SPA 只拿到空壳（chatgpt.com / trae.ai / workbuddy.ai 都是 0 字）
 *   - bsk 浏览器 daemon 没起
 *   Electron 的 Chromium 是现成的、已在跑的渲染引擎，CDP 9333 直接可用。
 *
 * 注意：这会把应用窗口导航走，跑完必须还原到 dist/index.html。
 *
 * 用法：node ui-survey-render.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9333';
const OUT = 'D:/file/AI Temp/DeepSeek/Agent自研/research/ui-survey/rendered';
const HOME = 'file:///C:/hermes/apps/desktop/dist/index.html';
fs.mkdirSync(OUT, { recursive: true });

const TARGETS = [
  ['qoder', 'https://qoder.com'],
  ['workbuddy', 'https://www.workbuddy.ai'],
  ['trae', 'https://www.trae.ai'],
  ['cursor', 'https://www.cursor.com'],
  ['kiro', 'https://kiro.dev'],
  ['windsurf', 'https://windsurf.com'],
  ['chatgpt', 'https://chatgpt.com'],
  ['codex', 'https://openai.com/codex/'],
  ['amp', 'https://ampcode.com'],
  ['zed', 'https://zed.dev'],
];

async function send(ws, method, params = {}, timeoutMs = 45000) {
  const id = send._id = (send._id || 0) + 1;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + method)), timeoutMs);
    const h = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) { clearTimeout(t); ws.removeEventListener('message', h); m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 160))) : res(m.result); }
    };
    ws.addEventListener('message', h);
  });
}

(async () => {
  const list = await (await fetch(CDP + '/json')).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) { console.log('  ✗ 没有 CDP page'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  await send(ws, 'Page.enable');
  await send(ws, 'Runtime.enable');
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 1500, height: 940, deviceScaleFactor: 1, mobile: false });

  const done = [];
  for (const [id, url] of TARGETS) {
    process.stdout.write('  ' + id.padEnd(12));
    try {
      await send(ws, 'Page.navigate', { url }, 60000);
      // 等 SPA 渲染：先等 load，再给动画/懒加载留时间
      await new Promise((r) => setTimeout(r, 9000));
      const info = await send(ws, 'Runtime.evaluate', {
        expression: `(() => ({ title: document.title, url: location.href, chars: (document.body.innerText||'').length, imgs: document.images.length }))()`,
        returnByValue: true,
      }, 20000);
      const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT, id + '.png');
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      const v = info.result.value;
      console.log('✓ ' + String(v.chars).padStart(6) + ' 字  ' + path.basename(file));
      done.push({ id, url, file, ...v });
    } catch (e) {
      console.log('✗ ' + String(e.message).slice(0, 70));
      done.push({ id, url, error: String(e.message).slice(0, 120) });
    }
  }

  // 还原应用
  console.log('');
  process.stdout.write('  还原应用… ');
  try {
    await send(ws, 'Page.navigate', { url: HOME }, 60000);
    await new Promise((r) => setTimeout(r, 6000));
    console.log('✓');
  } catch (e) { console.log('✗ ' + String(e.message).slice(0, 60)); }

  fs.writeFileSync(path.join(OUT, '_rendered.json'), JSON.stringify(done, null, 2), 'utf8');
  ws.close();
  console.log('  截图: ' + OUT);
})();
