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

// 找「管线」节点（截图显示在 ~1057,308）
const info = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  var rect = cv.getBoundingClientRect();
  var W = cv.clientWidth, H = cv.clientHeight;
  var R = S.radius, fov = (S.radiusX || R) * 2.6 / S.zoom;
  var cx = W/2, cy = H/2;

  var target = null;
  for (var i = 0; i < S.scenes.length; i++) {
    var n = S.scenes[i];
    if (n.name === '管线') { target = n; break; }
  }
  if (!target) target = S.scenes[0];

  var cyaw = Math.cos(S.yaw), syaw = Math.sin(S.yaw);
  var x1 = target.sx*cyaw + target.sz*syaw;
  var z1 = -target.sx*syaw + target.sz*cyaw;
  var cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
  var y1 = target.sy*cp - z1*sp;
  var z2 = target.sy*sp + z1*cp;
  var denom = fov/(fov+z2);

  return {
    name: target.name,
    sx: cx + x1*denom,
    sy: cy + y1*denom,
    box: { x: rect.x, y: rect.y },
  };
})()`);

console.log('目标节点: ' + info.name);
console.log('画布内: (' + Math.round(info.sx) + ',' + Math.round(info.sy) + ')');

const absX = info.box.x + info.sx;
const absY = info.box.y + info.sy;

const fs = await import('node:fs');
const ROOT = String.raw`D:\file\AI Temp\DeepSeek\Agent自研`;

// ── ① 悬停 ──
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: absX, y: absY, button: 'none' });
await new Promise(r => setTimeout(r, 600));

const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png', clip: {
  x: Math.max(0, absX - 220), y: Math.max(0, absY - 180), width: 440, height: 360, scale: 3,
}});
fs.writeFileSync(ROOT + '\\prototype\\screens\\state-focus-zoom.png', Buffer.from(shot1.data, 'base64'));
console.log('已保存 悬停放大图');

// ── ② 选中 ──
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: absX, y: absY, button: 'left', clickCount: 1 });
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: absX, y: absY, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 800));

const selState = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  return { sel: S.sel ? S.sel.name : null };
})()`);
console.log('选中: ' + JSON.stringify(selState));

const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png', clip: {
  x: Math.max(0, absX - 220), y: Math.max(0, absY - 180), width: 440, height: 360, scale: 3,
}});
fs.writeFileSync(ROOT + '\\prototype\\screens\\state-sel-zoom.png', Buffer.from(shot2.data, 'base64'));
console.log('已保存 选中放大图');

// ── ③ 取消选中 ──
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: absX, y: absY, button: 'left', clickCount: 1 });
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: absX, y: absY, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 300));
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: absX + 200, y: absY + 200, button: 'none' });

console.log('已取消选中');

cdp.close();
