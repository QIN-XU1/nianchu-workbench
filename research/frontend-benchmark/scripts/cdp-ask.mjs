import fs from 'node:fs';

const BASE = 'http://127.0.0.1:9223';
const OUT = 'D:/file/AI Temp/DeepSeek/Agent自研/research/frontend-benchmark/evidence';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(BASE + '/json')).json();
const pg = list.find((t) => t.type === 'page' && /127\.0\.0\.1/.test(t.url));
if (!pg) throw new Error('page not found');
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (mm, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params: p })); });
await new Promise((r) => { ws.onopen = r; });
await send('Page.enable'); await send('Runtime.enable');
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };

await send('Page.reload', { ignoreCache: true });
await sleep(5000);

await ev(`(()=>{const b=[...document.querySelectorAll('.ncc__icon')].find(x=>(x.getAttribute('title')||'').includes('新对话')); if(b)b.click();})()`);
await sleep(400);
await ev(`(()=>{const t=document.querySelector('.ncc__input'); const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(t,'用一句话解释什么是幂等'); t.dispatchEvent(new Event('input',{bubbles:true}));})()`);
await sleep(300);
await ev(`document.querySelector('.ncc__send')?.click()`);
for (let i = 0; i < 60; i++) { await sleep(1000); if (await ev(`!document.querySelector('.ncc__typing')`)) break; }

const out = {
  meta: await ev(`[...document.querySelectorAll('.ncc-msg__meta')].map(e=>e.textContent.trim())`),
  metaTitle: await ev(`[...document.querySelectorAll('.ncc-msg__meta')].map(e=>e.getAttribute('title'))`),
  usage: await ev(`document.querySelector('.ncc__usage')?.textContent.trim()`),
  usageTitle: await ev(`document.querySelector('.ncc__usage')?.getAttribute('title')`),
  text: await ev(`document.querySelectorAll('.ncc-msg[data-role="assistant"] .ncc-msg__body')?.length`),
};
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT + '/improve-model-label.png', Buffer.from(shot.result.data, 'base64'));
console.log(JSON.stringify(out, null, 2));
ws.close(); process.exit(0);
