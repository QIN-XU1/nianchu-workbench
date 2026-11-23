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
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

const fs = await import('node:fs');
const ROOT = String.raw`D:\file\AI Temp\DeepSeek\Agent自研`;

// 选中「管线」，旋转到 120°（节点在最深处），截图
const angles = [0, 120, 240];

for (const deg of angles) {
  await cdp.eval(`(function(){
    var N = window.__NEURON3D[0];
    var S = N.state;
    S.yaw = ${deg} * Math.PI / 180;
    S.pitch = -0.25;
    S.zoom = 1;
    if (!S.sel || S.sel.name !== '管线') {
      S.sel = S.scenes.find(function(n){ return n.name === '管线'; }) || S.scenes[0];
    }
    N.update();
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 400));

  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 90, width: 1230, height: 800, scale: 1 },
  });
  fs.writeFileSync(ROOT + '\\prototype\\screens\\edge-at-' + deg + '.png', Buffer.from(shot.data, 'base64'));
  console.log('已保存 edge-at-' + deg + '.png');
}

cdp.close();
