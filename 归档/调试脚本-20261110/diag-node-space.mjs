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

console.log('═══ 节点空间分布诊断 ═══');
console.log();

const d = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var W = document.querySelector('[data-panel-type="neuron"] canvas').clientWidth;
  var H = document.querySelector('[data-panel-type="neuron"] canvas').clientHeight;

  // 世界坐标 → 屏幕
  var R = S.radius, RX = S.radiusX || R, RY = S.radiusY || R;
  var fov = RX * 2.6;
  var cx = W/2, cy = H/2;

  var out = [];
  for (var i = 0; i < S.scenes.length; i++) {
    var n = S.scenes[i];
    var cyaw = Math.cos(S.yaw), syaw = Math.sin(S.yaw);
    var x1 = n.sx*cyaw + n.sz*syaw;
    var z1 = -n.sx*syaw + n.sz*cyaw;
    var cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
    var y1 = n.sy*cp - z1*sp;
    var z2 = n.sy*sp + z1*cp;
    var denom = fov/(fov+z2);
    var sx = Math.round(cx + x1*denom);
    var sy = Math.round(cy + y1*denom);
    out.push({
      name: n.name,
      domain: n.domain,
      sx: sx, sy: sy,
      worldR: Math.round(Math.sqrt(n.sx*n.sx + n.sy*n.sy + n.sz*n.sz)),
    });
  }

  return { nodes: out, W: W, H: H, RX: Math.round(RX), RY: Math.round(RY), fov: Math.round(fov) };
})()`);

console.log('  画布: ' + d.W + '×' + d.H);
console.log('  椭圆半径: RX=' + d.RX + ' RY=' + d.RY);
console.log('  fov=' + d.fov);
console.log();
console.log('  节点屏幕坐标:');
let minX = 9999, maxX = 0, minY = 9999, maxY = 0;
for (const n of d.nodes) {
  console.log('    ' + String(n.name).padEnd(12) + String(n.domain).padEnd(8) +
    '屏幕(' + String(n.sx).padStart(4) + ',' + String(n.sy).padStart(4) + ')  世界半径=' + n.worldR);
  minX = Math.min(minX, n.sx); maxX = Math.max(maxX, n.sx);
  minY = Math.min(minY, n.sy); maxY = Math.max(maxY, n.sy);
}

console.log();
console.log('  屏幕范围: x ' + minX + '~' + maxX + '   y ' + minY + '~' + maxY);
console.log('  画布占用: 水平 ' + Math.round((maxX-minX)/d.W*100) + '%  垂直 ' + Math.round((maxY-minY)/d.H*100) + '%');

console.log();
console.log('  各领域世界半径:');
const byDom = {};
for (const n of d.nodes) {
  if (!byDom[n.domain]) byDom[n.domain] = [];
  byDom[n.domain].push(n.worldR);
}
for (const k of Object.keys(byDom)) {
  console.log('    ' + k.padEnd(10) + '半径 ' + byDom[k].join(', '));
}

cdp.close();
