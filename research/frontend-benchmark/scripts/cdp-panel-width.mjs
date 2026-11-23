// CDP 实测：面板宽度拖拽（批次 Z.29）
// 用法：node research/frontend-benchmark/scripts/cdp-panel-width.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = 'http://127.0.0.1:47124/';
const OUT = 'D:/file/AI Temp/DeepSeek/Agent自研/research/frontend-benchmark/evidence';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitTarget(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) return page;
    } catch { /* 端点还没起 */ }
    await sleep(250);
  }
  return null;
}

const port = await freePort();
const profile = mkdtempSync(join(tmpdir(), 'ncc-pw-'));
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--window-size=1440,900',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank',
], { stdio: 'ignore' });

const page = await waitTarget(port, 30000);
if (!page) { console.error('CDP 端点没起来'); child.kill(); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const send = (method, params = {}) => new Promise(res => {
  const i = ++id;
  pend.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
await new Promise(r => { ws.onopen = r; });
await send('Page.enable');
await send('Runtime.enable');

const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
  return r.result?.result?.value;
};

const shot = async name => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(join(OUT, name), Buffer.from(s.result.data, 'base64'));
};

const panelWidth = () => ev(`(()=>{const p=document.querySelector('.openbitfun-fmc__panel'); if(!p) return null; const r=p.getBoundingClientRect(); return {width: Math.round(r.width), left: Math.round(r.left), var: getComputedStyle(p).getPropertyValue('--openbitfun-fmc-dock-width').trim(), stored: localStorage.getItem('ncc_panel_width')};})()`);

const ensureOpen = async () => {
  for (let i = 0; i < 40; i++) {
    if (await ev(`!!document.querySelector('.openbitfun-fmc__panel--open .openbitfun-fmc__resizer')`)) return true;
    await ev(`document.querySelector('.openbitfun-fmc__button')?.click()`);
    await sleep(250);
  }
  return false;
};

const result = { ok: false, steps: [], widths: {}, shots: [], errors: [] };

try {
  await send('Page.navigate', { url: URL_APP });
  await sleep(4000);
  // 页面第一次加载时 localStorage 可能是旧的：先清掉再刷新，保证从默认 400 开始
  await ev(`localStorage.removeItem('ncc_panel_width')`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(4500);
  const opened = await ensureOpen();
  if (!opened) throw new Error('面板没能打开（找不到 --open 或 resizer）');
  await sleep(400);

  const before = await panelWidth();
  result.widths.before = before;
  await shot('z29-panel-width-before.png');
  result.shots.push('z29-panel-width-before.png');

  // 键盘：聚焦分隔条，按两次 ←
  await ev(`document.querySelector('.openbitfun-fmc__resizer').focus()`);
  const key = async (code, vk) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: code, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: code, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  };
  await key('ArrowLeft', 37);
  await sleep(120);
  await key('ArrowLeft', 37);
  await sleep(300);
  const afterKeys = await panelWidth();
  result.widths.afterKeys = afterKeys;
  result.steps.push({ name: '键盘两次 ←', expected: '+32', got: afterKeys.width - before.width });

  // 拖动：从分隔条中心向左拖 120px
  const rect = await ev(`(()=>{const r=document.querySelector('.openbitfun-fmc__resizer').getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2};})()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(80);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x - 60, y: rect.y, button: 'left', buttons: 1 });
  await sleep(80);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x - 120, y: rect.y, button: 'left', buttons: 1 });
  await sleep(80);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x - 120, y: rect.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(500);
  const afterDrag = await panelWidth();
  result.widths.afterDrag = afterDrag;
  result.steps.push({ name: '左拖 120px', expected: '+120（夹到 46vw 内）', got: afterDrag.width - afterKeys.width });
  await shot('z29-panel-width-after-drag.png');
  result.shots.push('z29-panel-width-after-drag.png');

  // 刷新后仍在
  await send('Page.reload', { ignoreCache: true });
  await sleep(4500);
  const reopened = await ensureOpen();
  if (!reopened) throw new Error('刷新后面板没恢复');
  await sleep(300);
  const afterReload = await panelWidth();
  result.widths.afterReload = afterReload;
  result.steps.push({ name: '刷新后宽度', expected: afterDrag.width, got: afterReload.width });
  await shot('z29-panel-width-after-reload.png');
  result.shots.push('z29-panel-width-after-reload.png');

  result.ok = opened &&
    afterKeys.width === before.width + 32 &&
    afterDrag.width === before.width + 32 + 120 &&
    afterReload.width === afterDrag.width &&
    afterDrag.stored === String(afterDrag.width);
} catch (error) {
  result.errors.push(String(error && error.message ? error.message : error));
} finally {
  ws.close();
  child.kill();
}

fs.writeFileSync(join(OUT, 'panel-width.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
