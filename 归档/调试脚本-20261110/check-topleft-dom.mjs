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

console.log('═══ 检查左上角是 canvas 还是 DOM ═══');
console.log();

const info = await cdp.eval(`(function(){
  // 画布位置
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  var r = cv.getBoundingClientRect();

  // 在左上角斜线位置采样 DOM
  var samples = [];
  var points = [
    [12, 30], [25, 40], [40, 50], [55, 60], [30, 130]
  ];

  for (var i = 0; i < points.length; i++) {
    var x = r.x + points[i][0];
    var y = r.y + points[i][1];
    var el = document.elementFromPoint(x, y);
    samples.push({
      point: points[i],
      abs: [Math.round(x), Math.round(y)],
      tag: el ? el.tagName : null,
      cls: el ? (el.className || '').toString().slice(0, 40) : null,
      id: el ? el.id : null,
    });
  }

  return {
    canvasRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    samples: samples,
  };
})()`);

console.log('画布位置: ' + JSON.stringify(info.canvasRect));
console.log();
console.log('左上角采样点:');
for (const s of info.samples) {
  console.log('  (' + s.point[0] + ',' + s.point[1] + ') → ' + s.tag +
    (s.cls ? ' .' + s.cls : '') + (s.id ? ' #' + s.id : ''));
}

console.log();
console.log('═══ 只截 canvas（不含 DOM 装饰）═══');

// 只截 canvas 区域
const shot = await cdp.send('Page.captureScreenshot', {
  format: 'png',
  clip: {
    x: info.canvasRect.x,
    y: info.canvasRect.y,
    width: 300,
    height: 250,
    scale: 4,
  },
});

const fs = await import('node:fs');
fs.writeFileSync(
  String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\screens\canvas-topleft.png`,
  Buffer.from(shot.data, 'base64')
);
console.log('已保存 canvas 左上角截图（4x）');

cdp.close();
