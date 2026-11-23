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
            errs.push((d.exception?.description || d.text || '').slice(0, 400));
          }
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
await cdp.send('Runtime.enable');

console.log('═══ 诊断 AI 面板白屏 ═══');
console.log();

const st = await cdp.eval(`(function(){
  var panels = document.querySelectorAll('[data-panel-type="harness"]');
  var out = [];
  panels.forEach(function(p){
    var wv = p.querySelector('webview');
    var body = p.querySelector('.wb-panel-body') || p;
    var r = body.getBoundingClientRect();
    out.push({
      hasWebview: !!wv,
      wvSrc: wv ? wv.getAttribute('src') : '(无)',
      wvPartition: wv ? wv.getAttribute('partition') : '(无)',
      wvW: wv ? Math.round(wv.getBoundingClientRect().width) : -1,
      wvH: wv ? Math.round(wv.getBoundingClientRect().height) : -1,
      bodyW: Math.round(r.width),
      bodyH: Math.round(r.height),
      bodyBg: getComputedStyle(body).backgroundColor,
      headText: (p.querySelector('.wb-panel-head') ? p.querySelector('.wb-panel-head').textContent : '').slice(0, 50).replace(/\\s+/g,' '),
    });
  });
  return { count: panels.length, list: out };
})()`);
console.log(JSON.stringify(st, null, 2).slice(0, 1200));

console.log();
console.log('═══ 所有 webview target ═══');
const allWebviews = targets.filter(t => t.type === 'webview');
for (const t of allWebviews) {
  console.log('  [' + (t.url || '').slice(0, 60) + ']  ' + (t.title || '').slice(0, 30));
}

console.log();
console.log('═══ 引擎是否可达 ═══');
const engine = await cdp.eval(`(async function(){
  try {
    var r = await window.app.getHarnessUrl();
    return { ok: r.ok, url: (r.value || '').slice(0, 80) };
  } catch(e) { return { error: e.message }; }
})()`);
console.log('  ' + JSON.stringify(engine));

cdp.close();
