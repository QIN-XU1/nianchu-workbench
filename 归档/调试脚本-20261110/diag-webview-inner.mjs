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
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 40000); });
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

console.log('═══ webview 内部状态 ═══');
console.log();

// ① webview 可见性 & 尺寸
const vis = await cdp.eval(`(function(){
  var wv = document.querySelector('[data-panel-type="harness"] webview');
  if(!wv) return {error:'no webview'};
  var r = wv.getBoundingClientRect();
  var s = getComputedStyle(wv);
  return {
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    display: s.display, visibility: s.visibility, opacity: s.opacity, zIndex: s.zIndex,
    inViewport: r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0,
  };
})()`);
console.log('① 可见性: ' + JSON.stringify(vis, null, 2));

// ② 连到 webview target 内部检查内容
const wvTarget = targets.find(t => t.type === 'webview');
if (wvTarget) {
  console.log();
  console.log('② 连 webview 内部: ' + (wvTarget.title || '').slice(0, 40));
  const wcdp = CDP(wvTarget.webSocketDebuggerUrl);
  try {
    await wcdp.connect();
    const inner = await wcdp.eval(`(function(){
      return {
        url: location.href.slice(0, 70),
        title: document.title,
        bodyText: (document.body.innerText || '').slice(0, 200).replace(/\\s+/g, ' '),
        hasChat: !!document.querySelector('[class*="chat"], [class*="Chat"], [class*="message"]'),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        readyState: document.readyState,
      };
    })()`);
    console.log(JSON.stringify(inner, null, 2).slice(0, 800));
    wcdp.close();
  } catch (e) {
    console.log('   连接失败: ' + e.message);
  }
}

cdp.close();
