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

console.log('═══ 布局塌陷诊断 ═══');
console.log();

const st = await cdp.eval(`(function(){
  var app = document.querySelector('.wb-app');
  var body = document.querySelector('.wb-body');
  var split = document.querySelector('.wb-split');
  var main = document.querySelector('.wb-main');
  var side = document.querySelector('.wb-side');
  function box(el, name){
    if(!el) return { name: name, missing: true };
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    return {
      name: name,
      w: Math.round(r.width), h: Math.round(r.height),
      display: cs.display, height: cs.height, flex: cs.flex, minHeight: cs.minHeight,
      gridCols: cs.gridTemplateColumns ? cs.gridTemplateColumns.slice(0, 60) : '',
      gridRows: cs.gridTemplateRows ? cs.gridTemplateRows.slice(0, 60) : '',
    };
  }
  return {
    app: box(app, 'wb-app'),
    body: box(body, 'wb-body'),
    split: box(split, 'wb-split'),
    main: box(main, 'wb-main'),
    side: box(side, 'wb-side'),
    scenebarDisplay: document.querySelector('.wb-scenebar') ? getComputedStyle(document.querySelector('.wb-scenebar')).display : '(无)',
  };
})()`);

console.log(JSON.stringify(st, null, 2));

cdp.close();
