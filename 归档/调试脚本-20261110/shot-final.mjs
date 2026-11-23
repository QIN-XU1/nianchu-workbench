import fs from 'node:fs';

const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  return {
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 8000);
        ws.addEventListener('open', () => { clearTimeout(t); res(); });
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('失败')); });
        ws.addEventListener('message', (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch { return; }
          if (m.id && p.has(m.id)) { const { resolve, reject } = p.get(m.id); p.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
        });
      });
    },
    send(method, params = {}) {
      const i = id++;
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 40000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
      return r.result?.value;
    },
    close() { try { ws.close(); } catch {} }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

const OUT = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\screens`;

// ① 回到 command 场景，等稳定
await cdp.eval(`(async function(){
  try { await window.__WB.commands.run('scene.switch', { id: 'command' }); } catch(e){}
  return true;
})()`);
await new Promise(r => setTimeout(r, 4000));

// ② 截图（暗色）
const s1 = await cdp.send('Page.captureScreenshot', { format: 'png' });
if (s1 && s1.data) {
  const f = OUT + '\\final-01-overview.png';
  fs.writeFileSync(f, Buffer.from(s1.data, 'base64'));
  console.log('OK ' + f + '  ' + Math.round(fs.statSync(f).size / 1024) + ' KB');
}

// ③ 切到 bilibili（多面板场景）再截图
await cdp.eval(`(async function(){
  try { await window.__WB.commands.run('scene.switch', { id: 'bilibili' }); } catch(e){}
  return true;
})()`);
await new Promise(r => setTimeout(r, 5000));
const s2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
if (s2 && s2.data) {
  const f = OUT + '\\final-02-bilibili.png';
  fs.writeFileSync(f, Buffer.from(s2.data, 'base64'));
  console.log('OK ' + f + '  ' + Math.round(fs.statSync(f).size / 1024) + ' KB');
}

// ④ 切到 arch-review（4 面板）截图
await cdp.eval(`(async function(){
  try { await window.__WB.commands.run('scene.switch', { id: 'arch-review' }); } catch(e){}
  return true;
})()`);
await new Promise(r => setTimeout(r, 5000));
const s3 = await cdp.send('Page.captureScreenshot', { format: 'png' });
if (s3 && s3.data) {
  const f = OUT + '\\final-03-arch.png';
  fs.writeFileSync(f, Buffer.from(s3.data, 'base64'));
  console.log('OK ' + f + '  ' + Math.round(fs.statSync(f).size / 1024) + ' KB');
}

// ⑤ 点亮神经元演示
await cdp.eval(`(async function(){
  try { await window.__WB.commands.run('scene.switch', { id: 'command' }); } catch(e){}
  await new Promise(function(r){ setTimeout(r, 2500); });
  if (window.__NEURON3D && window.__NEURON3D[0]) {
    window.__NEURON3D[0].lightScene('arch-review', true);
    window.__NEURON3D[0].lightScene('research', true);
    window.__NEURON3D[0].lightScene('pipeline', true);
  }
  return true;
})()`);
await new Promise(r => setTimeout(r, 2000));

const s4 = await cdp.send('Page.captureScreenshot', { format: 'png' });
if (s4 && s4.data) {
  const f = OUT + '\\final-04-lit.png';
  fs.writeFileSync(f, Buffer.from(s4.data, 'base64'));
  console.log('OK ' + f + '  ' + Math.round(fs.statSync(f).size / 1024) + ' KB');
}

cdp.close();
