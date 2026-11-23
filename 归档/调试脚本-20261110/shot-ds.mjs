import fs from 'node:fs';

const CDP_PORT = 9333;

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
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 25000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 错误');
      return r.result?.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

const OUT = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\screens`;

async function shot(name, scene) {
  if (scene) {
    await cdp.eval(`(async function(){ try { await window.loadScenario('${scene}'); } catch(e){} })()`);
    await new Promise(r => setTimeout(r, 3500));
  }
  // 确保主 Agent 展开
  await cdp.eval(`(function(){ document.body.dataset.mainAgent='on'; return true; })()`);
  await new Promise(r => setTimeout(r, 500));

  const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (s && s.data) {
    const f = OUT + '\\' + name + '.png';
    fs.writeFileSync(f, Buffer.from(s.data, 'base64'));
    console.log('OK ' + f + '  ' + fs.statSync(f).size + ' bytes');
  }
}

await shot('ds-01-pipeline', 'pipeline');
await shot('ds-02-command', 'command');
await shot('ds-03-relationship', 'relationship');

cdp.close();
