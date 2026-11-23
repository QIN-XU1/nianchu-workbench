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

console.log('═══ sf-board 注册状态 ═══');
console.log();

const r = await cdp.eval(`(function(){
  var out = {
    hasAPP_RENDERERS: !!window.APP_RENDERERS,
    rendererCount: window.APP_RENDERERS ? Object.keys(window.APP_RENDERERS).length : 0,
    hasSfBoard: window.APP_RENDERERS ? !!window.APP_RENDERERS['sf-board'] : false,
    keys: window.APP_RENDERERS ? Object.keys(window.APP_RENDERERS).slice(0, 40) : [],
    // 脚本加载情况
    scripts: [].slice.call(document.querySelectorAll('script[src]')).map(function(s){
      return s.getAttribute('src');
    }),
    renderersScript: !!document.getElementById('renderers-script'),
    sfExecuted: typeof window.__SF_BOARD_LOADED,
  };
  return out;
})()`);

console.log('  APP_RENDERERS 存在: ' + r.hasAPP_RENDERERS);
console.log('  渲染器数量: ' + r.rendererCount);
console.log('  有 sf-board: ' + r.hasSfBoard);
console.log('  已加载脚本:');
for (const s of r.scripts) console.log('    ' + s);

console.log();
console.log('=== 如果有 sf-board，测一下能不能渲染 ===');
if (r.hasSfBoard) {
  console.log('  ✓ sf-board 已注册');
} else {
  console.log('  ✗ sf-board 未注册 —— 手动补注册试试');
  const fix = await cdp.eval(`(function(){
    if (!window.APP_RENDERERS) return { error: 'no APP_RENDERERS' };
    if (typeof window.__renderSfBoard === 'function') {
      window.APP_RENDERERS['sf-board'] = window.__renderSfBoard;
      return { ok: true, method: 'from global' };
    }
    return { ok: false, reason: 'renderSfBoard 不在全局作用域（在 IIFE 闭包内）' };
  })()`);
  console.log('  ' + JSON.stringify(fix));
}

cdp.close();
