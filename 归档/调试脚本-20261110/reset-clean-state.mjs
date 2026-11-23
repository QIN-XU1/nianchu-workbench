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

console.log('═══ 重置到干净状态 ═══');
console.log();

// ── ① 重置视角 + 清拖拽 ──
const reset = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;

  var before = {
    yaw: Math.round(S.yaw*100)/100,
    pitch: Math.round(S.pitch*100)/100,
    zoom: S.zoom,
    dragged: S.scenes.filter(function(n){return n.dragged;}).length,
  };

  // 清拖拽标记
  for (var i = 0; i < S.scenes.length; i++) S.scenes[i].dragged = false;

  // 重置视角（与 reset 按钮一致）
  S.yaw = 0.4;
  S.pitch = -0.25;
  S.zoom = 1;

  // 重排
  N.update();

  return {
    before: before,
    after: {
      yaw: S.yaw, pitch: S.pitch, zoom: S.zoom,
      dragged: S.scenes.filter(function(n){return n.dragged;}).length,
    },
  };
})()`);

console.log('重置前: ' + JSON.stringify(reset.before));
console.log('重置后: ' + JSON.stringify(reset.after));

// ── ② 验证节点都回到球面 ──
await new Promise(r => setTimeout(r, 300));

const verify = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var RX = S.radiusX, RY = S.radiusY;

  var outOfRange = [];
  for (var i = 0; i < S.scenes.length; i++) {
    var n = S.scenes[i];
    // 椭球内判定
    var e = Math.sqrt(
      Math.pow(n.sx / (RX * 0.94), 2) +
      Math.pow(n.sy / (RY * 0.94), 2) +
      Math.pow(n.sz / (RX * 0.94), 2)
    );
    if (e > 1.02) {
      outOfRange.push({ name: n.name, ellip: Math.round(e * 100) / 100 });
    }
  }

  return {
    sceneCount: S.scenes.length,
    outOfRange: outOfRange,
    draggingCount: S.scenes.filter(function(n){return n.dragged;}).length,
    yaw: Math.round(S.yaw*100)/100,
    zoom: S.zoom,
    RX: Math.round(RX),
    RY: Math.round(RY),
  };
})()`);

console.log();
console.log('验证: ' + JSON.stringify(verify, null, 2));

// ── ③ 截图 ──
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
const fs = await import('node:fs');
fs.writeFileSync(
  String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\screens\clean-state.png`,
  Buffer.from(shot.data, 'base64')
);
console.log();
console.log('已保存 clean-state.png');

cdp.close();
