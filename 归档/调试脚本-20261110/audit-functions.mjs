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

console.log('═══ 功能真实性审计 ═══');
console.log();

// ① 主 Agent 面板状态
const ma = await cdp.eval(`(function(){
  var p = document.getElementById('main-agent-panel');
  if (!p) return { exists: false };
  var rc = p.getBoundingClientRect();
  return {
    exists: true,
    visible: rc.width > 0,
    agentRows: p.querySelectorAll('.ma-agent-row').length,
    selectOptions: Array.from((document.getElementById('ma-target')||{options:[]}).options || []).length,
    hasWebview: !!p.querySelector('#ma-webview'),
    webviewSrc: (p.querySelector('#ma-webview')||{getAttribute:()=>''}).getAttribute('src') || '',
  };
})()`);
console.log('① 主 Agent 面板: ' + JSON.stringify(ma));

// ② 引擎 URL 与 token
const url = await cdp.eval(`(async function(){
  try { return await window.app.getHarnessUrl(); } catch(e){ return 'ERR:'+e.message; }
})()`);
console.log();
console.log('② 引擎 URL: ' + url);

// ③ 测试派单能力（不真的派，只看 fetch 是否可达）
const dispatchTest = await cdp.eval(`(async function(){
  var u = await window.app.getHarnessUrl();
  var base = u.replace(/\\/\\?.*$/, '').replace(/\\/$/, '');
  var m = u.match(/[?&]token=([^&]+)/);
  var token = m ? m[1] : '';
  if (!token) return { error: 'no token in url', url: u };

  // 用 session/list 试探（不产生副作用）
  try {
    var r = await fetch(base + '/api/session/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'audit-1',
        method: 'session/list', payload: { args: {} }
      }),
      signal: AbortSignal.timeout(10000),
    });
    var t = await r.text();
    return { status: r.status, hasToken: true, bodyHead: t.slice(0, 150) };
  } catch(e) {
    return { error: String(e), hasToken: true };
  }
})()`);
console.log();
console.log('③ 派单通道可达性: ' + JSON.stringify(dispatchTest, null, 2));

cdp.close();
