import fs from 'node:fs';

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
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 20000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 错误');
      return r.result?.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

// 实测关键元素的真实颜色
const diag = await cdp.eval(`(function(){
  function c(el){ if(!el) return null; var s = getComputedStyle(el); return { color: s.color, bg: s.backgroundColor, fs: s.fontSize, fw: s.fontWeight }; }
  var out = {};
  out.body = c(document.body);
  out.grid = c(document.getElementById('grid'));
  var panel = document.querySelector('.panel');
  out.panel = c(panel);
  out.panelHead = c(document.querySelector('.panel-head'));
  out.panelBody = c(document.querySelector('.panel-body'));
  out.panelTitle = c(document.querySelector('.panel-title'));

  // 找一行文本
  var line = document.querySelector('.tui-line-label') || document.querySelector('.panel-body span');
  out.textLine = c(line);

  // token 变量是否生效
  var root = getComputedStyle(document.documentElement);
  out.tokens = {
    textPrimary: root.getPropertyValue('--text-primary').trim(),
    textSecondary: root.getPropertyValue('--text-secondary').trim(),
    surfaceBase: root.getPropertyValue('--surface-base').trim(),
    surfaceRaised: root.getPropertyValue('--surface-raised').trim(),
    neutral100: root.getPropertyValue('--neutral-100').trim(),
    neutral900: root.getPropertyValue('--neutral-900').trim(),
    accent: root.getPropertyValue('--accent').trim(),
  };

  // theme-rui.css 是否加载
  out.cssLoaded = Array.from(document.styleSheets).map(function(s){
    try { return s.href ? s.href.split('/').pop() : '(inline)'; } catch(e) { return '?'; }
  });

  return out;
})()`);

console.log(JSON.stringify(diag, null, 2));

cdp.close();
