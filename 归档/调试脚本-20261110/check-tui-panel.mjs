import fs from 'node:fs';

const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  const errs = [];
  return {
    errs,
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 5000);
        ws.addEventListener('open', () => { clearTimeout(t); res(); });
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('失败')); });
        ws.addEventListener('message', (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch { return; }
          if (m.method === 'Runtime.exceptionThrown') {
            errs.push(((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text || '').slice(0, 300));
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
      if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 300) };
      return r.result?.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Runtime.enable');

console.log('═══ dsh-TUI 面板状态 ═══');
console.log();

// ① 主 Agent 对话区现在是什么
const frame = await cdp.eval(`(function(){
  var frame = document.getElementById('ma-chat-frame');
  if (!frame) return { error: 'no ma-chat-frame' };
  return {
    tuiMounted: frame.dataset.tuiMounted || '',
    childTags: Array.from(frame.children).map(function(c){ return c.tagName + '.' + String(c.className).slice(0,20); }),
    innerLen: frame.innerHTML.length,
    hasXterm: !!frame.querySelector('.xterm'),
    hasWebview: !!frame.querySelector('webview'),
    rect: { w: Math.round(frame.getBoundingClientRect().width), h: Math.round(frame.getBoundingClientRect().height) },
  };
})()`);
console.log('① ma-chat-frame: ' + JSON.stringify(frame, null, 2));

// ② tui API 是否可用
const api = await cdp.eval(`(function(){
  return {
    hasTui: !!(window.app && window.app.tui),
    hasStart: !!(window.app && window.app.tui && window.app.tui.start),
    hasPanelApi: !!window.__TUI_PANEL_API,
    xtermLoaded: !!window.Terminal,
  };
})()`);
console.log();
console.log('② TUI API: ' + JSON.stringify(api));

// ③ PTY 会话状态
const status = await cdp.eval(`(async function(){
  try { var s = await window.app.tui.status(); return s; } catch(e){ return { error: String(e) }; }
})()`);
console.log();
console.log('③ PTY 会话: ' + JSON.stringify(status));

// ④ 看 xterm 里有什么内容
const termText = await cdp.eval(`(function(){
  var x = document.querySelector('.xterm');
  if (!x) return '(无 xterm)';
  var scr = x.querySelector('.xterm-screen');
  return scr ? (scr.innerText || '').slice(0, 300) : (x.innerText || '').slice(0, 200);
})()`);
console.log();
console.log('④ 终端内容: "' + String(termText).replace(/\n/g, ' | ').slice(0, 200) + '"');

// ⑤ JS 错误
console.log();
console.log('⑤ JS 错误:');
if (cdp.errs.length) {
  const uniq = [...new Set(cdp.errs)];
  for (const e of uniq.slice(0, 6)) console.log('   ✗ ' + e);
} else {
  console.log('   (无)');
}

cdp.close();
