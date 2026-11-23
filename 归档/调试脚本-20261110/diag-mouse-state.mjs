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

console.log('═══ 检查 S.mouse 状态（怀疑 star grab 连线）═══');
console.log();

const m = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  return {
    mouse: S.mouse,
    inside: S.mouse ? S.mouse.inside : null,
    nx: S.mouse ? S.mouse.nx : null,
    ny: S.mouse ? S.mouse.ny : null,
  };
})()`);

console.log(JSON.stringify(m, null, 2));

if (m.inside) {
  console.log();
  console.log('★ S.mouse.inside = true');
  console.log('  鼠标归一化位置: (' + m.nx?.toFixed(3) + ', ' + m.ny?.toFixed(3) + ')');
  console.log('  → drawStars 里的 grab 连线会从鼠标位置画线到附近星点');
  console.log('  → 这就是左上角斜线的来源！');
} else {
  console.log();
  console.log('S.mouse.inside = false，grab 连线不应绘制');
  console.log('→ 斜线另有来源');
}

cdp.close();
