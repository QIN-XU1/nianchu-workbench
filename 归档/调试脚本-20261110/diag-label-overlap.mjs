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
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 40000); });
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

console.log('═══ 诊断：标签重叠 + 异常大圆 ═══');
console.log();

// ① 节点实际屏幕位置（用于检查重叠）
const nodes = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  var W = cv.clientWidth, H = cv.clientHeight;
  var R = S.radius, fov = R * 2.9;
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
    out.push({
      name: n.name,
      x: Math.round(cx + x1*denom),
      y: Math.round(cy + y1*denom),
      z: Math.round(z2),
      r: Math.round(n.r * denom),
      dragged: n.dragged,
      // 标签位置 = 节点下方
      labelY: Math.round(cy + y1*denom + n.r*denom + 8),
    });
  }
  return { nodes: out, R: Math.round(R), W: W, H: H, draggedCount: S.scenes.filter(function(x){return x.dragged;}).length };
})()`);

console.log('  拖拽中的节点: ' + nodes.draggedCount);
console.log();
console.log('  节点位置（检查重叠）:');
for (const n of nodes.nodes) {
  console.log('    ' + String(n.name).padEnd(12) + '@(' + String(n.x).padStart(4) + ',' + String(n.y).padStart(4) + ') z=' + String(n.z).padStart(5) + ' r=' + n.r + (n.dragged ? ' [拖拽]' : ''));
}

// ② 检查标签重叠
let overlapPairs = [];
for (let i = 0; i < nodes.nodes.length; i++) {
  for (let j = i + 1; j < nodes.nodes.length; j++) {
    const a = nodes.nodes[i], b = nodes.nodes[j];
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.labelY - b.labelY);
    if (dx < 60 && dy < 14) {
      overlapPairs.push(a.name + ' ↔ ' + b.name + ' (dx=' + dx + ')');
    }
  }
}

console.log();
console.log('  标签重叠对: ' + overlapPairs.length);
for (const p of overlapPairs) console.log('    ' + p);

// ③ 整理（复位拖拽）
console.log();
console.log('═══ 执行整理（复位拖拽节点）═══');
await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  if (typeof N.tidy === 'function') N.tidy();
  return true;
})()`);
await new Promise(r => setTimeout(r, 700));

const after = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  return {
    draggedCount: S.scenes.filter(function(x){return x.dragged;}).length,
    minGap: (function(){
      var min = Infinity;
      for (var i=0;i<S.scenes.length;i++) for (var j=i+1;j<S.scenes.length;j++){
        var a=S.scenes[i], b=S.scenes[j];
        var d = Math.sqrt(Math.pow(a.sx-b.sx,2)+Math.pow(a.sy-b.sy,2)+Math.pow(a.sz-b.sz,2));
        if (d < min) min = d;
      }
      return Math.round(min*10)/10;
    })(),
  };
})()`);
console.log('  整理后: ' + JSON.stringify(after));

cdp.close();
