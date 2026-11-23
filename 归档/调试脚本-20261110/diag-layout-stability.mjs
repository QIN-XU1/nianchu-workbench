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

console.log('═══ 定位：为什么世界坐标会变 ═══');
console.log();

// 检查 dragged 状态
const d1 = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  return {
    draggedCount: S.scenes.filter(function(n){ return n.dragged; }).length,
    canvasW: document.querySelector('[data-panel-type="neuron"] canvas').clientWidth,
    canvasH: document.querySelector('[data-panel-type="neuron"] canvas').clientHeight,
    radiusX: Math.round(S.radiusX || 0),
    radiusY: Math.round(S.radiusY || 0),
    nodeCoords: S.scenes.slice(0, 2).map(function(n){
      return { id: n.id, sx: Math.round(n.sx), sy: Math.round(n.sy), sz: Math.round(n.sz), dragged: !!n.dragged };
    }),
  };
})()`);
console.log('① 当前状态:');
console.log(JSON.stringify(d1, null, 2));

console.log();
console.log('② 单独调用 layout() 一次，看坐标是否变化:');
const d2 = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var before = S.scenes.slice(0,2).map(function(n){
    return { id: n.id, sx: Math.round(n.sx), sy: Math.round(n.sy), sz: Math.round(n.sz) };
  });
  N.update();   // 会调 layout
  var after = S.scenes.slice(0,2).map(function(n){
    return { id: n.id, sx: Math.round(n.sx), sy: Math.round(n.sy), sz: Math.round(n.sz) };
  });
  return { before: before, after: after };
})()`);
console.log('   before: ' + JSON.stringify(d2.before));
console.log('   after:  ' + JSON.stringify(d2.after));

const changed = JSON.stringify(d2.before) !== JSON.stringify(d2.after);
console.log('   坐标变化: ' + (changed ? '★ 变化了（layout 不可重现）' : '未变化（layout 稳定）'));

console.log();
console.log('③ 第二次调用 layout():');
const d3 = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var before = S.scenes.slice(0,2).map(function(n){
    return { id: n.id, sx: Math.round(n.sx), sy: Math.round(n.sy), sz: Math.round(n.sz) };
  });
  N.update();
  var after = S.scenes.slice(0,2).map(function(n){
    return { id: n.id, sx: Math.round(n.sx), sy: Math.round(n.sy), sz: Math.round(n.sz) };
  });
  return { before: before, after: after, same: JSON.stringify(before) === JSON.stringify(after) };
})()`);
console.log('   before: ' + JSON.stringify(d3.before));
console.log('   after:  ' + JSON.stringify(d3.after));
console.log('   稳定: ' + (d3.same ? '✓ 是' : '✗ 否'));

cdp.close();
