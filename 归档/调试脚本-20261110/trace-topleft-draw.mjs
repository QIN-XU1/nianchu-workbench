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

console.log('═══ 插桩：追踪画到左上角的操作 ═══');
console.log();

// 用 Proxy 包装 ctx，记录所有绘制调用及其坐标
const result = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  var ctx = cv.getContext('2d');

  var W = cv.clientWidth, H = cv.clientHeight;
  var TOPLEFT_W = 260, TOPLEFT_H = 220;

  var hits = [];
  var current = [];   // 当前记录的路径点

  // 包装关键方法
  var origMoveTo = ctx.moveTo.bind(ctx);
  var origLineTo = ctx.lineTo.bind(ctx);
  var origQuad = ctx.quadraticCurveTo.bind(ctx);
  var origArc = ctx.arc.bind(ctx);
  var origFillRect = ctx.fillRect.bind(ctx);
  var origFill = ctx.fill.bind(ctx);
  var origStroke = ctx.stroke.bind(ctx);

  var stack = [];

  ctx.moveTo = function(x, y) {
    stack.push({ op: 'moveTo', x: x, y: y });
    return origMoveTo(x, y);
  };
  ctx.lineTo = function(x, y) {
    stack.push({ op: 'lineTo', x: x, y: y });
    return origLineTo(x, y);
  };
  ctx.quadraticCurveTo = function(cx, cy, x, y) {
    stack.push({ op: 'quadTo', cx: cx, cy: cy, x: x, y: y });
    return origQuad(cx, cy, x, y);
  };
  ctx.arc = function(x, y, r, s, e, ccw) {
    stack.push({ op: 'arc', x: x, y: y, r: r });
    return origArc(x, y, r, s, e, ccw);
  };
  ctx.fillRect = function(x, y, w, h) {
    if (x < TOPLEFT_W && y < TOPLEFT_H + 100) {
      hits.push({ type: 'fillRect', x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
    }
    return origFillRect(x, y, w, h);
  };
  ctx.stroke = function() {
    // 检查路径是否触及左上角
    for (var i = 0; i < stack.length; i++) {
      var p = stack[i];
      if (p.x !== undefined && p.x < TOPLEFT_W && p.y < TOPLEFT_H + 100) {
        hits.push({
          type: 'stroke',
          path: stack.map(function(q){
            return q.op + '(' + Math.round(q.x) + ',' + Math.round(q.y) + ')';
          }).slice(0, 6).join(' → '),
          color: String(ctx.strokeStyle).slice(0, 40),
          lineWidth: ctx.lineWidth,
        });
        break;
      }
    }
    stack = [];
    return origStroke();
  };
  ctx.fill = function() {
    for (var i = 0; i < stack.length; i++) {
      var p = stack[i];
      if (p.x !== undefined && p.x < TOPLEFT_W && p.y < TOPLEFT_H + 100) {
        hits.push({
          type: 'fill',
          path: stack.map(function(q){
            return q.op + '(' + Math.round(q.x) + ',' + Math.round(q.y) + ')';
          }).slice(0, 6).join(' → '),
          fill: String(ctx.fillStyle).slice(0, 40),
        });
        break;
      }
    }
    stack = [];
    return origFill();
  };

  // 渲染一帧
  N.update();

  // 恢复
  ctx.moveTo = origMoveTo;
  ctx.lineTo = origLineTo;
  ctx.quadraticCurveTo = origQuad;
  ctx.arc = origArc;
  ctx.fillRect = origFillRect;
  ctx.fill = origFill;
  ctx.stroke = origStroke;

  return { hits: hits.slice(0, 20), total: hits.length };
})()`);

if (result.__exception) {
  console.log('ERROR: ' + result.__exception);
} else {
  console.log('命中左上角的绘制调用: ' + result.total);
  console.log();
  for (const h of result.hits) {
    console.log('  [' + h.type + ']');
    if (h.path) console.log('    路径: ' + h.path);
    if (h.color) console.log('    颜色: ' + h.color + '  线宽: ' + h.lineWidth);
    if (h.fill) console.log('    填充: ' + h.fill);
    if (h.x !== undefined) console.log('    矩形: (' + h.x + ',' + h.y + ') ' + h.w + '×' + h.h);
    console.log();
  }
}

cdp.close();
