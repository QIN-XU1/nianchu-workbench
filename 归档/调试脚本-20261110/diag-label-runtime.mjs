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

console.log('═══ 标签重叠自检 ═══');
console.log();

const d = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;

  // labelRects 是渲染时记录的实际标签位置
  var rects = S.labelRects || [];

  var out = {
    labelCount: rects.length,
    rects: rects.map(function(r){
      return { x: Math.round(r.x), y: Math.round(r.y), hw: Math.round(r.hw * 10) / 10 };
    }),
  };

  // 检查重叠
  var overlaps = [];
  for (var i = 0; i < rects.length; i++) {
    for (var j = i + 1; j < rects.length; j++) {
      var a = rects[i], b = rects[j];
      var dx = Math.abs(a.x - b.x);
      var dy = Math.abs(a.y - b.y);
      if (dx < (a.hw + b.hw) && dy < 13) {
        overlaps.push({
          i: i, j: j,
          dx: Math.round(dx), dy: Math.round(dy),
          needW: Math.round(a.hw + b.hw),
        });
      }
    }
  }
  out.overlaps = overlaps;
  out.overlapCount = overlaps.length;

  return out;
})()`);

console.log('标签数量: ' + d.labelCount);
console.log();
console.log('标签位置:');
for (let i = 0; i < d.rects.length; i++) {
  const r = d.rects[i];
  console.log('  #' + i + ' @(' + String(r.x).padStart(4) + ',' + String(r.y).padStart(4) + ') 半宽=' + r.hw);
}

console.log();
console.log('重叠对: ' + d.overlapCount);
for (const o of d.overlaps) {
  console.log('  #' + o.i + ' ↔ #' + o.j + '  dx=' + o.dx + ' (需 ' + o.needW + ')  dy=' + o.dy);
}

// 检查为什么会重叠：看防重叠循环是否执行
console.log();
const logic = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  // 检查源码里 DX/DY 数组
  return {
    hasLabelRects: !!(N.state.labelRects),
    note: 'labelRects 每帧重置，冲突时应下移',
  };
})()`);
console.log('逻辑: ' + JSON.stringify(logic));

cdp.close();
