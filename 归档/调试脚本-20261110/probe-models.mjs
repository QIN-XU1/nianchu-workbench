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
    close() { try { ws.close(); } catch { /* ignore */ } }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();

// 用主页面查（工作台的页面能访问 window.app 的 IPC）
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

try {
  console.log('=== 工作台的 IPC 能力探测 ===');
  const apis = await cdp.eval(`(function(){
    return {
      appKeys: Object.keys(window.app || {}),
      hasListScenarios: typeof window.app?.listScenarios,
      hasGetHarnessUrl: typeof window.app?.getHarnessUrl,
    };
  })()`);
  console.log('  window.app 方法:', JSON.stringify(apis.appKeys.filter(k => k !== 'on').slice(0, 40)));

  console.log();
  console.log('=== 直接问引擎：有哪些可用模型 ===');
  // 通过引擎 webview 的 CDP 查
} finally {
  cdp.close();
}

// 从引擎侧查模型列表
const engWv = targets.filter(t => t.type === 'webview' && t.url.includes('3080'));
if (engWv.length > 0) {
  const cdp2 = CDP(engWv[0].webSocketDebuggerUrl);
  await cdp2.connect();
  try {
    // 用引擎页面的 fetch 调它自己的 API
    const r = await cdp2.eval(`(async function(){
      try {
        // 引擎页面里有会话状态，看看能不能找到模型配置
        var out = {};
        // 从 localStorage / sessionStorage 找
        out.localStorage = {};
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (/model|provider|channel/i.test(k)) out.localStorage[k] = (localStorage.getItem(k) || '').slice(0, 80);
        }
        out.sessionStorage = {};
        for (var j = 0; j < sessionStorage.length; j++) {
          var k2 = sessionStorage.key(j);
          if (/model|provider|channel/i.test(k2)) out.sessionStorage[k2] = (sessionStorage.getItem(k2) || '').slice(0, 80);
        }
        return out;
      } catch(e) { return { error: String(e) }; }
    })()`);
    console.log();
    console.log('=== 引擎 localStorage 里的模型配置 ===');
    console.log(JSON.stringify(r, null, 2).slice(0, 600));
  } finally {
    cdp2.close();
  }
}
