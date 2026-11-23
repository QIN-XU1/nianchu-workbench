const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  return {
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 8000);
        ws.addEventListener('open', () => { clearTimeout(t); res(); });
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('连接失败')); });
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

console.log('═══ xterm 加载状态 ═══');
console.log();

const st = await cdp.eval(`(function(){
  var css = document.getElementById('xterm-css');
  var tuiFrame = document.getElementById('ma-tui-frame');
  var xtermEl = tuiFrame ? tuiFrame.querySelector('.xterm') : null;
  return {
    hasXtermLib: !!window.Terminal,
    xtermCssLinked: !!css,
    xtermCssHref: css ? css.href : '(无)',
    xtermDom: !!xtermEl,
    xtermDomClasses: xtermEl ? xtermEl.className : '(无)',
    // xterm.css 关键规则是否生效（.xterm-viewport 应该有样式）
    viewportStyled: xtermEl ? (function(){
      var vp = xtermEl.querySelector('.xterm-viewport');
      if (!vp) return 'no viewport';
      var s = getComputedStyle(vp);
      return { position: s.position, overflowY: s.overflowY, bg: s.backgroundColor };
    })() : '(无 xterm)',
    frameText: tuiFrame ? (tuiFrame.textContent || '').slice(0, 60).replace(/\\s+/g,' ') : '',
  };
})()`);
console.log(JSON.stringify(st, null, 2));

cdp.close();
