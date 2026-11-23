/**
 * 实测窗口缩放 v2 —— 用 Emulation.setDeviceMetricsOverride 模拟视口变化
 * （这是页面级 API，不需要 browser 域）
 */

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

async function snap(label) {
  const d = await cdp.eval(`(function(){
    var grid = document.getElementById('grid');
    return {
      win: window.innerWidth + 'x' + window.innerHeight,
      cols: grid ? getComputedStyle(grid).gridTemplateColumns : '?',
      gridW: grid ? Math.round(grid.getBoundingClientRect().width) : 0,
      panels: [].slice.call(document.querySelectorAll('.panel')).map(function(p){ return Math.round(p.getBoundingClientRect().width); }),
      webviews: [].slice.call(document.querySelectorAll('webview')).map(function(w){ return Math.round(w.getBoundingClientRect().width); }),
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
    };
  })()`);
  console.log('  [' + label + '] 窗口 ' + d.win + '  横溢出=' + d.overflowX);
  console.log('    列: ' + d.cols);
  console.log('    面板宽: ' + d.panels.join(', ') + '   webview宽: ' + d.webviews.join(', '));
  return d;
}

console.log('═══ 视口缩放测试 ═══');
console.log();
await snap('基线 1536');

const SIZES = [
  [1200, 800],
  [1000, 700],
  [900, 700],
  [1600, 950],
];

for (const [w, h] of SIZES) {
  console.log();
  console.log('═══ 视口 ' + w + 'x' + h + ' ═══');
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 1, mobile: false,
    });
    await new Promise(r => setTimeout(r, 1200));
    await snap(w + 'x' + h);
  } catch (e) {
    console.log('  ERR: ' + e.message.slice(0, 60));
  }
}

// 清除覆盖
await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => { });
console.log();
console.log('═══ 已清除覆盖，恢复原尺寸 ═══');
await new Promise(r => setTimeout(r, 800));
await snap('恢复');

cdp.close();
