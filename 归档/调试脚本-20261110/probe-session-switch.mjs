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
      if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
      return r.result?.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } }
  };
}

// 连到主 Agent 的 webview（引擎首页）
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const engHome = targets.find(t => t.type === 'webview' && t.url.includes('3080') && t.title === 'DeepSeek Harness');
if (!engHome) { console.log('找不到引擎首页 webview'); process.exit(1); }

const cdp = CDP(engHome.webSocketDebuggerUrl);
await cdp.connect();

console.log('═══ 引擎页面里有哪些切会话的手段 ═══');
console.log();

// ① 看 URL 结构，是否有 session 参数
const url0 = await cdp.eval(`'url:' + location.href`);
console.log('① ' + url0);

// ② 找页面里的会话列表 DOM
const sidebar = await cdp.eval(`(function(){
  var out = { items: [], selectors: [] };

  // 找可能承载会话列表的容器
  ['[class*="sidebar"]', '[class*="session"]', '[class*="Session"]', '[role="list"]', '[role="listbox"]'].forEach(function(sel){
    var els = document.querySelectorAll(sel);
    if (els.length) out.selectors.push({ sel: sel, count: els.length });
  });

  return out;
})()`);
console.log();
console.log('② 可能的选择器: ' + JSON.stringify(sidebar.selectors));

// ③ 试探：改 URL 加 session 参数是否有效
console.log();
console.log('③ 尝试 URL 参数：');
for (const param of ['session', 'sessionId', 'id']) {
  const test = await cdp.eval(`(function(){
    var u = new URL(location.href);
    u.searchParams.set('${param}', 'session-49fac9b6-9736-4212-82ff-ca53f8e4b75e');
    return u.toString();
  })()`);
  console.log('   ' + param + ' → ' + test);
}

// ④ 检查 window 里有没有切会话的 API
console.log();
console.log('④ 页面全局对象:');
const globals = await cdp.eval(`(function(){
  var keys = [];
  for (var k in window) {
    if (/session|nav|route|switch/i.test(k) && typeof window[k] === 'function') keys.push(k);
  }
  return keys.slice(0, 25);
})()`);
console.log('   ' + JSON.stringify(globals));

cdp.close();
