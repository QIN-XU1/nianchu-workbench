import fs from 'node:fs';

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
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 错误');
      return r.result?.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

// 诊断面板留白的真实原因
const diag = await cdp.eval(`(function(){
  var out = { panel: [], grid: null, body: null };
  var p = document.querySelector('.panel');
  if (p) {
    var cs = getComputedStyle(p);
    out.panel = {
      height: Math.round(p.getBoundingClientRect().height),
      display: cs.display,
      flexDirection: cs.flexDirection,
      overflow: cs.overflow,
    };
    var head = p.querySelector('.panel-head');
    var bodyEl = p.querySelector('.panel-body');
    if (head) out.panel.headHeight = Math.round(head.getBoundingClientRect().height);
    if (bodyEl) {
      var bcs = getComputedStyle(bodyEl);
      out.panel.bodyHeight = Math.round(bodyEl.getBoundingClientRect().height);
      out.panel.bodyFlex = bcs.flex;
      out.panel.bodyOverflow = bcs.overflow;
      // 内容实际高度
      var inner = bodyEl.firstElementChild;
      out.panel.contentHeight = inner ? Math.round(inner.getBoundingClientRect().height) : 0;
    }
  }
  var g = document.getElementById('grid') || document.querySelector('.grid');
  if (g) {
    var gcs = getComputedStyle(g);
    out.grid = {
      height: Math.round(g.getBoundingClientRect().height),
      display: gcs.display,
      gridTemplateRows: gcs.gridTemplateRows,
      gridTemplateColumns: gcs.gridTemplateColumns,
      gap: gcs.gap,
      padding: gcs.padding,
    };
  }
  // body 的整体结构
  out.body = {
    children: Array.from(document.body.children).map(function(c){
      var cs2 = getComputedStyle(c);
      return { tag: c.tagName, id: c.id, cls: String(c.className).slice(0,30),
               h: Math.round(c.getBoundingClientRect().height),
               display: cs2.display, flex: cs2.flex };
    }).slice(0, 15),
  };
  return out;
})()`);

console.log(JSON.stringify(diag, null, 2));

cdp.close();
