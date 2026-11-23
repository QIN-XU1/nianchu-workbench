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

console.log('═══ 切回中枢场景 ═══');

// 查找 hub 的 session 或场景
const hubInfo = await cdp.eval(`(function(){
  var st = window.__WB.state;
  var hubSession = st && st.get ? st.get('scene.hubSessionId') : null;
  return {
    current: window.__WB.getCurrentScene(),
    availableScenes: ['hub', 'arch-review', 'bilibili', 'build-plan', 'competitor-analyze',
      'pc-cleanup', 'pipeline', 'relationship', 'research', 'reverse-eng', 'self-review'],
  };
})()`);
console.log('当前场景: ' + hubInfo.current);

// 切回 hub
const back = await cdp.eval(`(async function(){
  try {
    var ok = await window.__WB.switchScene('hub');
    await new Promise(function(r){ setTimeout(r, 600); });
    return { ok: ok, current: window.__WB.getCurrentScene() };
  } catch(e) { return { error: e.message }; }
})()`);
console.log('切回结果: ' + JSON.stringify(back));

// 等待界面稳定
await new Promise(r => setTimeout(r, 800));

// 检查神经元是否重新挂载
const neuronCheck = await cdp.eval(`(function(){
  var N = window.__NEURON3D;
  var cvs = document.querySelectorAll('[data-panel-type="neuron"] canvas');
  return {
    neuronInstances: N ? N.length : 0,
    neuronCanvases: cvs.length,
    scenes: N && N.length && N[N.length-1].state ? N[N.length-1].state.scenes.length : 0,
    labelCount: N && N.length && N[N.length-1].state ? (N[N.length-1].state.labelRects || []).length : 0,
  };
})()`);
console.log();
console.log('神经元状态: ' + JSON.stringify(neuronCheck));

cdp.close();
