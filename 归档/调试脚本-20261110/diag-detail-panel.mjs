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

console.log('═══ 直接测试 showDetail ═══');
console.log();

// 通过实例直接调 showDetail（如果暴露了）
const r1 = await cdp.eval(`(function(){
  var N = window.__NEURON3D && window.__NEURON3D[0];
  if (!N) return { error: 'no neuron' };

  var S = N.state;
  var scene = S.scenes.find(function(x){ return x.name === '管线'; }) || S.scenes[0];

  // 直接设置 sel 并调用 render（render 不会调 showDetail）
  S.sel = scene;

  // 检查 showDetail 是否可用
  return {
    hasShowDetail: typeof N.showDetail === 'function',
    sceneName: scene.name,
    sceneDomain: scene.domain,
    hasSessionId: !!scene.sessionId,
    attachments: scene.attachments,
  };
})()`);
console.log('实例状态: ' + JSON.stringify(r1, null, 2));

// 找详情面板 DOM 元素（不管 display）
console.log();
console.log('查找详情面板 DOM:');
const r2 = await cdp.eval(`(function(){
  var panel = document.querySelector('[data-panel-type="neuron"]');
  if (!panel) return { error: 'no panel' };

  var found = [];
  var divs = panel.querySelectorAll('div');
  for (var i = 0; i < divs.length; i++) {
    var d = divs[i];
    var s = getComputedStyle(d);
    if (s.position === 'absolute') {
      found.push({
        idx: i,
        display: d.style.display,
        zIndex: s.zIndex,
        w: Math.round(d.getBoundingClientRect().width),
        h: Math.round(d.getBoundingClientRect().height),
        textLen: (d.textContent || '').length,
        snippet: (d.textContent || '').slice(0, 60).replace(/\\s+/g, ' '),
      });
    }
  }
  return { count: found.length, items: found };
})()`);
console.log(JSON.stringify(r2, null, 2));

cdp.close();
