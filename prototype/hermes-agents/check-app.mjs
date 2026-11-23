import fs from 'node:fs';

const CDP = 'http://127.0.0.1:9333';
async function send(ws, method, params = {}, t = 40000) {
  const id = send._id = (send._id || 0) + 1;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('timeout ' + method)), t);
    const h = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) { clearTimeout(to); ws.removeEventListener('message', h); m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 150))) : res(m.result); }
    };
    ws.addEventListener('message', h);
  });
}
const ev = async (ws, expr) => (await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, 30000)).result?.value;

const list = await (await fetch(CDP + '/json')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
await send(ws, 'Runtime.enable');
await send(ws, 'Page.enable');
await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

const st = await ev(ws, `JSON.stringify((() => {
  const bar = document.querySelector('[data-slot="statusbar"]');
  const t = (el) => (el ? (el.innerText || '').replace(/\\s+/g, ' ').trim() : '');
  return {
    hash: location.hash,
    statusbar: t(bar),
    blocked: /后端\\s*就绪|就绪/.test(t(bar)),
    offline: /offline|离线|couldn't start/i.test(document.body.innerText || ''),
    cards: document.querySelectorAll('[data-slot="aui_intro_scenes"] button').length,
    len: (document.body.innerText || '').length,
  };
})())`);
console.log(JSON.stringify(JSON.parse(st), null, 2));

// 回空态截图存档
await ev(ws, 'location.hash = "#/"; "ok"');
await new Promise((r) => setTimeout(r, 5000));
const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' }, 45000);
fs.writeFileSync('D:/file/AI Temp/DeepSeek/Agent自研/research/screenshots/hermes-首页-场景入口.png', Buffer.from(shot.data, 'base64'));
console.log('  截图: hermes-首页-场景入口.png');
ws.close();
