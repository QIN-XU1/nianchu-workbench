/**
 * 实测窗口缩放：用 CDP Browser 域直接改窗口尺寸，观察布局响应
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

async function snapshot(label) {
  const d = await cdp.eval(`(function(){
    var grid = document.getElementById('grid');
    var view = document.getElementById('scenario-view');
    var tb = document.getElementById('titlebar');
    var sb = document.getElementById('scenebar');
    var out = {
      win: window.innerWidth + 'x' + window.innerHeight,
      grid: grid ? Math.round(grid.getBoundingClientRect().width) + 'x' + Math.round(grid.getBoundingClientRect().height) : '?',
      cols: grid ? getComputedStyle(grid).gridTemplateColumns : '?',
      view: view ? Math.round(view.getBoundingClientRect().width) + 'x' + Math.round(view.getBoundingClientRect().height) : '?',
      titlebar: tb ? Math.round(tb.getBoundingClientRect().width) : 0,
      scenebar: sb ? Math.round(sb.getBoundingClientRect().width) : 0,
      panels: [].slice.call(document.querySelectorAll('.panel')).map(function(p){
        var r = p.getBoundingClientRect();
        return Math.round(r.width) + 'x' + Math.round(r.height);
      }),
      webviews: [].slice.call(document.querySelectorAll('webview')).map(function(w){
        var r = w.getBoundingClientRect();
        return Math.round(r.width) + 'x' + Math.round(r.height);
      }),
    };
    return out;
  })()`);
  console.log('  [' + label + ']');
  console.log('    窗口      ' + d.win);
  console.log('    grid      ' + d.grid + '   列=' + d.cols);
  console.log('    view      ' + d.view);
  console.log('    titlebar  ' + d.titlebar + 'px   scenebar ' + d.scenebar + 'px');
  console.log('    面板      ' + d.panels.join(', '));
  console.log('    webview   ' + d.webviews.join(', '));
  return d;
}

// 拿 windowId
const win = await cdp.send('Browser.getWindowForTarget', { targetId: page.id });
const windowId = win.windowId;
const curBounds = win.bounds;
console.log('═══ 当前窗口 ═══');
console.log('  windowId=' + windowId + '  bounds=' + JSON.stringify(curBounds));
console.log();

console.log('═══ 基线 ═══');
await snapshot('baseline');

// 缩到 900x700（小于 minWidth 1000）
console.log();
console.log('═══ 拖到 900x700 ═══');
try {
  await cdp.send('Browser.setWindowBounds', {
    windowId,
    bounds: { width: 900, height: 700, windowState: 'normal' },
  });
  await new Promise(r => setTimeout(r, 1500));
  await snapshot('900x700');
} catch (e) {
  console.log('  ERR: ' + e.message.slice(0, 60));
}

// 放大到 1400x900
console.log();
console.log('═══ 拖到 1400x900 ═══');
try {
  await cdp.send('Browser.setWindowBounds', {
    windowId,
    bounds: { width: 1400, height: 900, windowState: 'normal' },
  });
  await new Promise(r => setTimeout(r, 1500));
  await snapshot('1400x900');
} catch (e) {
  console.log('  ERR: ' + e.message.slice(0, 60));
}

// 还原
console.log();
console.log('═══ 还原 ═══');
try {
  await cdp.send('Browser.setWindowBounds', {
    windowId,
    bounds: { windowState: curBounds.windowState || 'normal', width: curBounds.width, height: curBounds.height },
  });
} catch (e) { /* ignore */ }

cdp.close();
