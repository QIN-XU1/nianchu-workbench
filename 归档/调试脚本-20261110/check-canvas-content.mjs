const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  return {
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 5000);
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
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 20000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
      return r.result?.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

console.log('═══ 画布真实内容检查 ═══');
console.log();

const r = await cdp.eval(`(function(){
  var body = document.querySelector('.panel-body[data-kind="neuron"]');
  if (!body) return { error: 'no panel' };
  var cv = body.querySelector('canvas');
  if (!cv) return { error: 'no canvas' };

  var ctx = cv.getContext('2d');
  // 采样整个画布，统计非黑像素
  var W = cv.width, H = cv.height;
  var data = ctx.getImageData(0, 0, W, H).data;
  var nonBlack = 0, colored = 0;
  var samples = [];
  for (var i = 0; i < data.length; i += 4 * 200) {
    var r0 = data[i], g0 = data[i+1], b0 = data[i+2];
    if (r0 > 25 || g0 > 25 || b0 > 25) nonBlack++;
    // 有彩色（非灰）
    if (Math.abs(r0-g0) > 20 || Math.abs(g0-b0) > 20) colored++;
  }

  return {
    canvasW: W, canvasH: H,
    totalSampled: Math.floor(data.length / (4*200)),
    nonBlack: nonBlack,
    colored: colored,
    bodyChildren: body.children.length,
    childTags: Array.prototype.slice.call(body.children).map(function(c){ return c.tagName + '.' + String(c.className).slice(0,20); }),
    // 检查是否重复创建
    canvasCount: body.querySelectorAll('canvas').length,
    hudCount: body.querySelectorAll('div').length,
  };
})()`);

console.log(JSON.stringify(r, null, 2));

// 检查 DOM 是否重复
console.log();
console.log('═══ neuron 面板的 DOM 结构 ═══');
const dom = await cdp.eval(`(function(){
  var body = document.querySelector('.panel-body[data-kind="neuron"]');
  if (!body) return 'no panel';
  return {
    innerHTMLLen: body.innerHTML.length,
    childrenDetail: Array.prototype.slice.call(body.children).map(function(c, i){
      return {
        i: i, tag: c.tagName, cls: String(c.className).slice(0, 25),
        style: (c.getAttribute('style')||'').slice(0, 80),
        children: c.children.length,
        w: Math.round(c.getBoundingClientRect().width),
        h: Math.round(c.getBoundingClientRect().height),
      };
    }),
  };
})()`);
console.log(JSON.stringify(dom, null, 2).slice(0, 1200));

cdp.close();
