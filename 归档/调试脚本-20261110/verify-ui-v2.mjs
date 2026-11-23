const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  const errs = [];
  const logs = [];
  return {
    errs, logs,
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
          if (m.method === 'Runtime.consoleAPICalled') {
            const args = (m.params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || a.type));
            logs.push(m.params.type + ': ' + args.join(' ').slice(0, 250));
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
      if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 400) };
      return r.result?.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
console.log('═══ 页面目标 ═══');
for (const t of targets) {
  console.log('  [' + t.type + '] ' + (t.title || '').slice(0, 40) + '  ' + t.url.slice(0, 90));
}
console.log();

const page = targets.find(t => t.type === 'page');
if (!page) { console.log('找不到 page target'); process.exit(1); }

const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Runtime.enable');

console.log('URL: ' + (await cdp.eval('location.href')));

console.log();
console.log('═══ 新前端结构检查 ═══');
const r = await cdp.eval(`(function(){
  var app = document.getElementById('app');
  var splash = document.getElementById('boot-splash');
  return {
    hasWB: !!window.__WB,
    appChildCount: app ? app.children.length : -1,
    splashExists: !!splash,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    titlebar: !!document.querySelector('.wb-titlebar'),
    scenebar: !!document.querySelector('.wb-scenebar'),
    split: !!document.querySelector('.wb-split'),
    panels: document.querySelectorAll('.wb-panel').length,
    scenetabs: document.querySelectorAll('.wb-scenetab').length,
    bootPhase: window.__WB ? window.__WB.state.get('boot.phase') : '(无)',
    scenesCount: window.__WB ? (window.__WB.state.get('scenes') || []).length : -1,
  };
})()`);
console.log(JSON.stringify(r, null, 2));

console.log();
console.log('═══ 控制台错误 ═══');
const uniq = [...new Set(cdp.errs)];
if (uniq.length) for (const e of uniq.slice(0, 8)) console.log('  ✗ ' + e.replace(/\n/g, ' | '));
else console.log('  (无)');

console.log();
console.log('═══ 控制台日志 ═══');
for (const l of cdp.logs.slice(-15)) console.log('  ' + l);

cdp.close();
