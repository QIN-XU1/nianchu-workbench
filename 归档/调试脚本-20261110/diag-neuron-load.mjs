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
            const txt = (d.exception?.description || d.text || '').slice(0, 400);
            errs.push(txt);
            console.log('!!! 异常: ' + txt);
          }
          if (m.method === 'Runtime.consoleAPICalled') {
            const args = (m.params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || ''));
            const txt = args.join(' ');
            if (m.params.type === 'error' || txt.includes('neuron') || txt.includes('未就绪')) {
              console.log('[' + m.params.type + '] ' + txt.slice(0, 300));
            }
            if (m.params.type === 'error') errs.push(txt.slice(0, 300));
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
await cdp.send('Log.enable');

console.log('═══ 抓取 neuron 加载失败原因 ═══');
console.log();

// 手动触发场景重渲染，看异常
const result = await cdp.eval(`(async function(){
  try {
    // 直接 import neuron 模块看是否报错
    var mod = await import('./panels/neuron.js');
    return { ok: true, hasDefault: typeof mod.default === 'function' };
  } catch (e) {
    return { ok: false, error: e.message, stack: String(e.stack || '').slice(0, 300) };
  }
})()`);

console.log('import neuron.js: ' + JSON.stringify(result, null, 2));

// 再试一次场景切换
console.log();
const switchResult = await cdp.eval(`(async function(){
  try {
    window.__WB.state.set('scene.current', null);  // 强制清空以便重渲染
    var ok = await window.__WB.switchScene('hub');
    await new Promise(function(r){ setTimeout(r, 800); });
    return {
      ok: ok,
      current: window.__WB.getCurrentScene(),
      neuronInstances: window.__NEURON3D ? window.__NEURON3D.length : 0,
    };
  } catch(e) {
    return { error: e.message, stack: String(e.stack || '').slice(0, 300) };
  }
})()`);
console.log('切换 scene: ' + JSON.stringify(switchResult, null, 2));

console.log();
console.log('累计异常: ' + cdp.errs.length);
for (const e of [...new Set(cdp.errs)].slice(0, 5)) {
  console.log('  XX ' + e.slice(0, 200));
}

cdp.close();
