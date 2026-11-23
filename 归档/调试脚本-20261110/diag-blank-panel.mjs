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
            errs.push((d.exception?.description || d.text || '').slice(0, 300));
          }
          if (m.method === 'Runtime.consoleAPICalled') {
            const args = (m.params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || ''));
            if (m.params.type === 'error') errs.push('console.error: ' + args.join(' ').slice(0, 200));
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
    close() { try { ws.close(); } catch {} }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Runtime.enable');

console.log('════ 自检：JS 状态 ════');
console.log();

// 1. 检查神经元是否还在
const d = await cdp.eval(`(function(){
  return {
    neuronInstances: window.__NEURON3D ? window.__NEURON3D.length : 0,
    wbExists: !!window.__WB,
    currentScene: window.__WB && window.__WB.getCurrentScene ? window.__WB.getCurrentScene() : null,
  };
})()`);
console.log('神经元实例: ' + d.neuronInstances);
console.log('__WB 存在: ' + d.wbExists);
console.log('当前场景: ' + d.currentScene);

// 2. 检查右侧面板 DOM
const right = await cdp.eval(`(function(){
  var panels = document.querySelectorAll('[data-panel-type]');
  var out = [];
  for (var i = 0; i < panels.length; i++) {
    var p = panels[i];
    var r = p.getBoundingClientRect();
    out.push({
      type: p.getAttribute('data-panel-type'),
      w: Math.round(r.width),
      h: Math.round(r.height),
      hasContent: p.textContent.trim().length > 0,
      textLen: p.textContent.trim().length,
    });
  }
  return out;
})()`);
console.log();
console.log('面板:');
for (const p of right) {
  console.log('  ' + p.type.padEnd(14) + p.w + '×' + p.h + '  内容 ' + p.textLen + ' 字符  ' + (p.hasContent ? 'OK' : '★空'));
}

// 3. 页面错误
console.log();
console.log('JS 错误: ' + cdp.errs.length);
const uniq = [...new Set(cdp.errs)];
for (const e of uniq.slice(0, 5)) {
  console.log('  ✗ ' + e.slice(0, 180));
}

cdp.close();
