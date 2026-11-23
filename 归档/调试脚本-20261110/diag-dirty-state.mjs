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

const d = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;

  return {
    // 哪个节点 dragged
    dragged: S.scenes.filter(function(n){ return n.dragged; }).map(function(n){ return n.name; }),
    // 哪个节点 lit（被调度）
    lit: S.scenes.filter(function(n){ return n.lit; }).map(function(n){ return n.name; }),
    hover: S.hover ? S.hover.name : null,
    sel: S.sel ? S.sel.name : null,
  };
})()`);

console.log('===========================================');
console.log('  自检：脏状态来源');
console.log('===========================================');
console.log();
console.log('  dragged 节点: ' + (d.dragged.length ? d.dragged.join(', ') : '无'));
console.log('  lit 节点:     ' + (d.lit.length ? d.lit.join(', ') : '无'));
console.log('  hover:        ' + (d.hover || '无'));
console.log('  sel:          ' + (d.sel || '无'));

console.log();
if (d.lit.length) {
  console.log('  ★ "管线" 异常明亮是因为 lit=true（正在调度），这是**正常状态**');
  console.log('    不是 bug —— 但它太亮了，需要降低 lit 的视觉强度');
}
if (d.dragged.length) {
  console.log('  ★ 有节点仍处于 dragged 状态（resetView 未清干净）');
}

cdp.close();
