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

console.log('═══ 连续采样标签重叠（10 次，间隔 300ms）═══');
console.log();

const results = [];

for (let k = 0; k < 10; k++) {
  const d = await cdp.eval(`(function(){
    var N = window.__NEURON3D[0];
    var rects = N.state.labelRects || [];
    var overlaps = [];
    for (var i = 0; i < rects.length; i++) {
      for (var j = i + 1; j < rects.length; j++) {
        var a = rects[i], b = rects[j];
        if (Math.abs(a.x - b.x) < (a.hw + b.hw) && Math.abs(a.y - b.y) < 13) {
          overlaps.push(i + '↔' + j);
        }
      }
    }
    return {
      n: rects.length,
      overlaps: overlaps,
      positions: rects.map(function(r){ return Math.round(r.x) + ',' + Math.round(r.y); }),
    };
  })()`);

  results.push(d);
  console.log('  #' + (k + 1) + ' 标签 ' + d.n + ' 重叠 ' + d.overlaps.length +
    (d.overlaps.length ? '  [' + d.overlaps.join(',') + ']' : ''));

  await new Promise(r => setTimeout(r, 300));
}

console.log();
const totalOverlap = results.reduce((s, r) => s + r.overlaps.length, 0);
console.log('总计重叠次数: ' + totalOverlap + ' / ' + (results.length * 10) + ' 次采样');

if (totalOverlap === 0) {
  console.log();
  console.log('✓ 逻辑上无重叠');
  console.log('  截图中的重叠可能是：');
  console.log('   · 标签底衬半透明，两个接近的标签视觉上"看起来"叠');
  console.log('   · 或者节点标签与节点本体重叠（节点在标签区域内）');
} else {
  console.log('✗ 存在真实重叠');
}

console.log();
console.log('最后 3 次的位置快照:');
for (const r of results.slice(-3)) {
  console.log('  ' + r.positions.join(' | '));
}

cdp.close();
