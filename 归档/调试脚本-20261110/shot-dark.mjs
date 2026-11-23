import fs from 'node:fs';
import path from 'node:path';

const CDP_PORT = 9333;
const OUT = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\screens`;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  return {
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 5000);
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
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 30000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 错误');
      return r.result?.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

// 确保 dark
await cdp.eval(`(function(){ if (window.__tuiTerminal_API) window.__tuiTerminal_API.theme('dark'); document.body.dataset.tuiTheme='dark'; return true; })()`);
await new Promise(r => setTimeout(r, 1500));

const scenes = ['pipeline', 'relationship', 'command', 'research'];
for (const sid of scenes) {
  await cdp.eval(`(async function(){ try { await window.loadScenario('${sid}'); } catch(e){} })()`);
  await new Promise(r => setTimeout(r, 3500));
  await cdp.eval(`(function(){ if (window.__tuiTerminal_API) window.__tuiTerminal_API.theme('dark'); return true; })()`);
  await new Promise(r => setTimeout(r, 800));

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (shot && shot.data) {
    const f = path.join(OUT, 'dark-' + sid + '.png');
    fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
    console.log('OK', f, fs.statSync(f).size, 'bytes');
  }
}

cdp.close();
