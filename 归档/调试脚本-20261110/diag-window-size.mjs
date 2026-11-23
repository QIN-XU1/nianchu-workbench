const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  return {
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 5000);
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
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 25000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 错误');
      return r.result?.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

console.log('═══ 当前窗口与布局 ═══');
console.log();

const d = await cdp.eval(`(function(){
  var out = {
    window: { w: window.innerWidth, h: window.innerHeight },
    screen: { w: screen.width, h: screen.height, availW: screen.availWidth, availH: screen.availHeight },
    devicePixelRatio: window.devicePixelRatio,
  };

  // 关键容器尺寸
  var containers = {};
  ['grid','scenario-view','scenario-tabs','titlebar','scenebar'].forEach(function(id){
    var el = document.getElementById(id);
    if (el) {
      var r = el.getBoundingClientRect();
      containers[id] = { w: Math.round(r.width), h: Math.round(r.height) };
    }
  });
  out.containers = containers;

  // grid 列宽（看是否自适应）
  var g = document.getElementById('grid');
  if (g) {
    var gcs = getComputedStyle(g);
    out.grid = {
      cols: gcs.gridTemplateColumns,
      rows: gcs.gridTemplateRows,
      gap: gcs.gap,
    };
  }

  // 面板数
  out.panelCount = document.querySelectorAll('.panel').length;
  out.panels = [].slice.call(document.querySelectorAll('.panel')).map(function(p){
    var r = p.getBoundingClientRect();
    return { id: p.dataset.panelId, w: Math.round(r.width), h: Math.round(r.height) };
  });

  return out;
})()`);

console.log('  窗口: ' + d.window.w + 'x' + d.window.h);
console.log('  屏幕: ' + d.screen.w + 'x' + d.screen.h + '  (可用 ' + d.screen.availW + 'x' + d.screen.availH + ')');
console.log('  DPR: ' + d.devicePixelRatio);
console.log();
console.log('  容器:');
for (const [k, v] of Object.entries(d.containers)) {
  console.log('    ' + k.padEnd(16) + v.w + 'x' + v.h);
}
console.log();
console.log('  grid 列: ' + (d.grid ? d.grid.cols : '?'));
console.log('  grid 行: ' + (d.grid ? d.grid.rows : '?'));
console.log();
console.log('  面板 ' + d.panelCount + ' 个:');
for (const p of d.panels.slice(0, 6)) {
  console.log('    ' + String(p.id).padEnd(14) + p.w + 'x' + p.h);
}

cdp.close();
