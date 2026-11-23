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

// 完全重置：视角 + 悬停 + 选中 + 拖拽
const r = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;

  // 用新增的 resetView
  N.resetView();

  // 清悬停/选中
  S.hover = null;
  S.sel = null;
  S.mouse.inside = false;

  N.update();

  return {
    yaw: Math.round(S.yaw*100)/100,
    pitch: Math.round(S.pitch*100)/100,
    zoom: S.zoom,
    hover: S.hover ? S.hover.name : null,
    sel: S.sel ? S.sel.name : null,
    dragged: S.scenes.filter(function(n){return n.dragged;}).length,
  };
})()`);

console.log('重置后: ' + JSON.stringify(r, null, 2));

// 把鼠标移出画布
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1900, y: 1100, button: 'none' });
await new Promise(res => setTimeout(res, 800));

// 截图
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
const fs = await import('node:fs');
fs.writeFileSync(
  String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\screens\final-clean.png`,
  Buffer.from(shot.data, 'base64')
);
console.log('已保存 final-clean.png');

cdp.close();
