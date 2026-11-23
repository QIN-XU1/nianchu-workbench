#!/usr/bin/env node
/**
 * 用 hermes 的 Electron 渲染"文档站"页面并截图（第二站：真界面截图在文档里）。
 *
 * 第一站抓官网首页失败了 —— 拿到的是大字标题 + cookie 横幅。
 * 开发者产品的 UI 截图基本都在 docs / changelog 里，而这些站是客户端渲染的，
 * curl 只能拿到空壳，必须真渲染。
 */

import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9333';
const OUT = 'D:/file/AI Temp/DeepSeek/Agent自研/research/ui-survey/rendered2';
const HOME = 'file:///C:/hermes/apps/desktop/dist/index.html';
fs.mkdirSync(OUT, { recursive: true });

const TARGETS = [
  ['docs-qoder', 'https://docs.qoder.com/'],
  ['qoder-home', 'https://qoder.com'],
  ['docs-trae', 'https://docs.trae.ai/'],
  ['cursor-changelog', 'https://cursor.com/changelog'],
  ['docs-cline', 'https://docs.cline.bot/'],
  ['amp-manual', 'https://ampcode.com/manual'],
  ['claude-code', 'https://docs.anthropic.com/en/docs/claude-code/overview'],
  ['codex', 'https://developers.openai.com/codex/'],
];

async function send(ws, method, params = {}, timeoutMs = 60000) {
  const id = send._id = (send._id || 0) + 1;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + method)), timeoutMs);
    const h = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) { clearTimeout(t); ws.removeEventListener('message', h); m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 140))) : res(m.result); }
    };
    ws.addEventListener('message', h);
  });
}

(async () => {
  const list = await (await fetch(CDP + '/json')).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) { console.log('  x no CDP page'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  await send(ws, 'Page.enable');
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 1500, height: 940, deviceScaleFactor: 1, mobile: false });

  const done = [];
  for (const [id, url] of TARGETS) {
    process.stdout.write('  ' + id.padEnd(17));
    try {
      await send(ws, 'Page.navigate', { url }, 70000);
      await new Promise((r) => setTimeout(r, 10000));
      const info = await send(ws, 'Runtime.evaluate', {
        expression: '(() => ({ title: document.title, chars: (document.body.innerText||"").length, imgs: document.images.length }))()',
        returnByValue: true,
      }, 25000);
      const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' }, 40000);
      const file = path.join(OUT, id + '.png');
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log('ok ' + String(info.result.value.chars).padStart(6) + ' chars');
      done.push({ id, url, file, ...info.result.value });
    } catch (e) {
      console.log('x ' + String(e.message).slice(0, 60));
      done.push({ id, url, error: String(e.message).slice(0, 120) });
    }
  }

  process.stdout.write('  restore app... ');
  try {
    await send(ws, 'Page.navigate', { url: HOME }, 70000);
    await new Promise((r) => setTimeout(r, 6000));
    console.log('ok');
  } catch (e) { console.log('x'); }
  fs.writeFileSync(path.join(OUT, '_rendered.json'), JSON.stringify(done, null, 2), 'utf8');
  ws.close();
})();
