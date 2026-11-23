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

console.log('═══ 紫微十二宫实际分布 ═══');
console.log();

const data = await cdp.eval(`(function(){
  var N = window.__NEURON3D;
  if (!N || !N.length) return { error: 'no neuron' };
  var inst = N[0];
  var arr = inst.state.arrangement;
  if (!arr) return { error: 'no arrangement' };

  return {
    palaces: arr.palaces.map(function(p){
      return {
        id: p.id,
        name: p.name,
        zhi: p.zhi,
        grid: p.grid,
        count: p.scenes.length,
        scenes: p.scenes.slice(0,3).map(function(s){ return s.name; }),
      };
    }),
    nodes: inst.state.scenes.map(function(s){
      return { name: s.name, palace: s.palaceName, r: s.gridR, c: s.gridC, slot: s.slot };
    }),
  };
})()`);

if (data.error) {
  console.log('  ✗ ' + data.error);
} else {
  console.log('  宫位分布:');
  for (const p of data.palaces) {
    const bar = '█'.repeat(Math.min(20, p.count));
    console.log('    ' + p.name.padEnd(6) + '(' + p.zhi + ') r' + p.grid.r + 'c' + p.grid.c +
      '  ' + String(p.count).padStart(2) + ' 个 ' + bar +
      (p.count > 0 ? '  ' + p.scenes.join(',') : ''));
  }
  console.log();
  console.log('  节点坐标:');
  for (const n of data.nodes) {
    console.log('    ' + n.name.padEnd(12) + '在' + n.palace + '  r' + n.r + ' c' + n.c + ' slot' + n.slot);
  }
}

cdp.close();
