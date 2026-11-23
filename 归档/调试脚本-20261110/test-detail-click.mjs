const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  const errs = [];
  return {
    errs,
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 8000);
        ws.addEventListener('open', () => { clearTimeout(t); res(); });
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('失败')); });
        ws.addEventListener('message', (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch { return; }
          if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params.exceptionDetails;
            errs.push((d.exception?.description || d.text || '').slice(0, 300));
          }
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
      if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 500) };
      return r.result?.value;
    },
    close() { try { ws.close(); } catch {} }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Runtime.enable');

console.log('═══ 模拟真实点击（精确命中节点）═══');
console.log();

// 重置并计算节点屏幕坐标
const info = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  N.resetView();
  S.viewScale = 1; S.panX = 0; S.panY = 0;
  S.hover = null; S.sel = null;
  N.update();

  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  var rect = cv.getBoundingClientRect();
  var W = cv.clientWidth, H = cv.clientHeight;
  var R = S.radius, fov = (S.radiusX || R) * 2.6 / S.zoom;
  var n = S.scenes.find(function(x){ return x.name === '管线'; }) || S.scenes[0];
  var cyaw = Math.cos(S.yaw), syaw = Math.sin(S.yaw);
  var x1 = n.sx*cyaw + n.sz*syaw;
  var z1 = -n.sx*syaw + n.sz*cyaw;
  var cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
  var y1 = n.sy*cp - z1*sp;
  var z2 = n.sy*sp + z1*cp;
  var denom = fov/(fov+z2);
  var vs = S.viewScale || 1, px = S.panX || 0, py = S.panY || 0;

  return {
    name: n.name,
    absX: rect.x + (W/2 + x1*denom) * vs + px,
    absY: rect.y + (H/2 + y1*denom) * vs + py,
    canvasRect: { x: rect.x, y: rect.y },
  };
})()`);

console.log('节点: ' + info.name + ' 绝对坐标: (' + Math.round(info.absX) + ',' + Math.round(info.absY) + ')');

// 移动 + 点击
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.absX, y: info.absY, button: 'none' });
await new Promise(r => setTimeout(r, 300));

const hoverState = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  return { hover: S.hover ? S.hover.name : null };
})()`);
console.log('悬停: ' + JSON.stringify(hoverState));

await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.absX, y: info.absY, button: 'left', clickCount: 1 });
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.absX, y: info.absY, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 600));

const after = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  // 找详情面板
  var panel = document.querySelector('[data-panel-type="neuron"]');
  var divs = panel.querySelectorAll('div');
  var detail = null;
  for (var i = 0; i < divs.length; i++) {
    var s = getComputedStyle(divs[i]);
    if (s.position === 'absolute' && parseInt(s.zIndex || 0) >= 5) {
      detail = divs[i];
      break;
    }
  }
  return {
    sel: S.sel ? S.sel.name : null,
    detailDisplay: detail ? detail.style.display : null,
    detailText: detail ? (detail.textContent || '').slice(0, 400) : null,
    detailHasWuxing: detail ? /木|火|土|金|水/.test(detail.textContent || '') : false,
  };
})()`);

console.log('点击后:');
console.log('  sel: ' + after.sel);
console.log('  detail display: ' + after.detailDisplay);
console.log('  五行: ' + (after.detailHasWuxing ? 'YES' : 'NO'));
console.log();
if (after.detailText) {
  console.log('  详情内容:');
  console.log('    ' + after.detailText.replace(/\s+/g, ' ').slice(0, 300));
}

console.log();
console.log('JS 错误: ' + cdp.errs.length);
for (const e of [...new Set(cdp.errs)].slice(0, 3)) console.log('  XX ' + e.slice(0, 200));

cdp.close();
