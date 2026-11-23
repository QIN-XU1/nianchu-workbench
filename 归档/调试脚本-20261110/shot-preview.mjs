const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  return {
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 8000);
        ws.addEventListener('open', () => { clearTimeout(t); res(); });
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('连接失败')); });
        ws.addEventListener('message', (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch { return; }
          if (m.id && p.has(m.id)) { const { resolve, reject } = p.get(m.id); p.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
        });
      });
    },
    send(method, params = {}) {
      const i = id++;
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 30000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 400) };
      return r.result?.value;
    },
    close() { try { ws.close(); } catch {} }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
if (!page) { console.log('no page'); process.exit(1); }

const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

// 先在当前页打开 preview，截图，再回退
const previewUrl = page.url.replace(/index\.html.*$/, 'style-preview.html');
console.log('打开 preview: ' + previewUrl);

await cdp.send('Page.navigate', { url: previewUrl });
await new Promise(r => setTimeout(r, 3000));

const OUT = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\screens`;
const fs = await import('node:fs');

const s = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
if (s && s.data) {
  const f = OUT + '\\style-preview.png';
  fs.writeFileSync(f, Buffer.from(s.data, 'base64'));
  console.log('OK ' + f + '  ' + Math.round(fs.statSync(f).size / 1024) + ' KB');
}

// 检查内容
const info = await cdp.eval(`(function(){
  return {
    title: document.title,
    buttons: document.querySelectorAll('.wb-btn').length,
    inputs: document.querySelectorAll('.wb-input, .wb-textarea, .wb-select').length,
    rows: document.querySelectorAll('.wb-row').length,
    badges: document.querySelectorAll('.wb-badge').length,
    cards: document.querySelectorAll('.wb-card').length,
    tables: document.querySelectorAll('.wb-table').length,
    tabs: document.querySelectorAll('.wb-tab').length,
    switches: document.querySelectorAll('.wb-switch').length,
    bodyBg: getComputedStyle(document.body).backgroundColor,
  };
})()`);
console.log();
console.log('preview 内容: ' + JSON.stringify(info, null, 2));

// 回退到主界面
await cdp.send('Page.navigate', { url: page.url });
cdp.close();
