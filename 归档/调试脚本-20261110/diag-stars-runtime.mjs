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

console.log('════ 运行时自检 ════');
console.log();

const d = await cdp.eval(`(function(){
  var N = window.__NEURON3D;
  if (!N || !N.length) return { error: 'no neuron' };
  var S = N[0].state;

  // 星点状态
  var stars = S.stars || [];
  var visible = stars.filter(function(s){ return s.a > 0.012; }).length;
  var avgA = stars.length ? (stars.reduce(function(t,s){return t+s.a;},0) / stars.length) : 0;
  var avgR = stars.length ? (stars.reduce(function(t,s){return t+s.r;},0) / stars.length) : 0;
  var maxR = stars.reduce(function(m,s){return s.r > m ? s.r : m;}, 0);
  var minA = stars.reduce(function(m,s){return s.a < m ? s.a : m;}, 99);
  var maxA = stars.reduce(function(m,s){return s.a > m ? s.a : m;}, 0);

  // 节点状态
  var nodePos = S.nodeScreenPos || [];

  return {
    starCount: stars.length,
    visibleStars: visible,
    avgA: Math.round(avgA * 1000) / 1000,
    minA: Math.round(minA * 1000) / 1000,
    maxA: Math.round(maxA * 1000) / 1000,
    avgR: Math.round(avgR * 100) / 100,
    maxR: Math.round(maxR * 1000) / 1000,
    nodePosCount: nodePos.length,
    sampleStar: stars.slice(0, 3).map(function(s){
      return { x: Math.round(s.x*1000)/1000, y: Math.round(s.y*1000)/1000, a: Math.round(s.a*1000)/1000, r: Math.round(s.r*1000)/1000, baseA: Math.round(s.baseA*1000)/1000, r0: Math.round(s.r0*1000)/1000, life: Math.round(s.life*100)/100 };
    }),
    renderCount: S.animId ? 'animating' : 'stopped',
    t: Math.round(S.t * 10) / 10,
  };
})()`);

console.log(JSON.stringify(d, null, 2));

console.log();
console.log('JS 异常: ' + cdp.errs.length);
for (const e of [...new Set(cdp.errs)].slice(0, 3)) console.log('  ✗ ' + e.slice(0, 200));

cdp.close();
