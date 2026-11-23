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

// 找一个中间位置的节点
const pos = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  var r = cv.getBoundingClientRect();
  var W = cv.clientWidth, H = cv.clientHeight;
  var R = S.radius, fov = (S.radiusX || R) * 2.6 / S.zoom;
  var cx = W/2, cy = H/2;

  // 找最靠中间的节点
  var best = null, bestD = 1e9;
  for (var i = 0; i < S.scenes.length; i++) {
    var n = S.scenes[i];
    var cyaw = Math.cos(S.yaw), syaw = Math.sin(S.yaw);
    var x1 = n.sx*cyaw + n.sz*syaw;
    var z1 = -n.sx*syaw + n.sz*cyaw;
    var cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
    var y1 = n.sy*cp - z1*sp;
    var z2 = n.sy*sp + z1*cp;
    var denom = fov/(fov+z2);
    var sx = cx + x1*denom, sy = cy + y1*denom;
    var d = Math.hypot(sx - cx, sy - cy);
    if (d < bestD) { bestD = d; best = { name: n.name, id: n.id, sx: sx, sy: sy }; }
  }
  return { node: best, box: { x: Math.round(r.x), y: Math.round(r.y) } };
})()`);

console.log('目标节点: ' + pos.node.name + ' @(' + Math.round(pos.node.sx) + ',' + Math.round(pos.node.sy) + ')');

const absX = pos.box.x + pos.node.sx;
const absY = pos.box.y + pos.node.sy;

// 悬停
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: absX, y: absY, button: 'none' });
await new Promise(r => setTimeout(r, 500));

const hoverState = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  return { hover: S.hover ? S.hover.name : null };
})()`);
console.log('悬停状态: ' + JSON.stringify(hoverState));

// 截图
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
const fs = await import('node:fs');
fs.writeFileSync(
  String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\screens\state-hover.png`,
  Buffer.from(shot.data, 'base64')
);
console.log('已保存 hover 截图');

// 点击选中
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: absX, y: absY, button: 'left', clickCount: 1 });
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: absX, y: absY, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 600));

const selState = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  return { sel: S.sel ? S.sel.name : null };
})()`);
console.log('选中状态: ' + JSON.stringify(selState));

const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(
  String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\screens\state-selected.png`,
  Buffer.from(shot2.data, 'base64')
);
console.log('已保存 selected 截图');

cdp.close();
