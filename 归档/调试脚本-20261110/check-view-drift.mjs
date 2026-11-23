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

console.log('═══ 检查视野是否在自动变化 ═══');
console.log();

// 连续采样 3 次 yaw/pitch，间隔 1 秒
for (let k = 1; k <= 3; k++) {
  const s = await cdp.eval(`(function(){
    var S = window.__NEURON3D[0].state;
    return {
      yaw: Math.round(S.yaw * 1000) / 1000,
      pitch: Math.round(S.pitch * 1000) / 1000,
      zoom: Math.round(S.zoom * 1000) / 1000,
      t: Math.round(S.t * 100) / 100,
      animId: !!S.animId,
      draggingCount: S.scenes.filter(function(n){ return n.dragged; }).length,
    };
  })()`);
  console.log('  采样 ' + k + ': ' + JSON.stringify(s));
  await new Promise(r => setTimeout(r, 1000));
}

console.log();
console.log('═══ 重新截图（当前真实状态）═══');

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
const fs = await import('node:fs');
fs.writeFileSync(
  String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\screens\current-real.png`,
  Buffer.from(shot.data, 'base64')
);
console.log('已保存 current-real.png');

cdp.close();
