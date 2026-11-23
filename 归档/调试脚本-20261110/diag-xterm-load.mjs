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

console.log('═══ 诊断 xterm 加载失败 ═══');
console.log();

// ① 当前页面 URL
const url = await cdp.eval(`location.href`);
console.log('① 页面 URL: ' + url);

// ② 试直接加载 xterm.js，看真实错误
const loadTest = await cdp.eval(`(async function(){
  return new Promise(function(resolve){
    var s = document.createElement('script');
    s.src = './node_modules/xterm/lib/xterm.js';
    s.onload = function(){ resolve({ ok: true, hasTerminal: !!window.Terminal }); };
    s.onerror = function(e){
      resolve({ ok: false, err: 'script onerror', src: s.src });
    };
    document.head.appendChild(s);
    setTimeout(function(){ resolve({ ok: false, err: 'timeout', src: s.src }); }, 5000);
  });
})()`);
console.log();
console.log('② 相对路径加载: ' + JSON.stringify(loadTest));

// ③ 算出绝对路径
const absPath = await cdp.eval(`(function(){
  var u = location.href;
  // file:///D:/.../renderer/index.html → 去掉文件名
  var base = u.slice(0, u.lastIndexOf('/') + 1);
  return base + 'node_modules/xterm/lib/xterm.js';
})()`);
console.log();
console.log('③ 绝对路径: ' + absPath);

// ④ 用绝对路径加载
const loadTest2 = await cdp.eval(`(async function(){
  return new Promise(function(resolve){
    var s = document.createElement('script');
    s.src = ${JSON.stringify(absPath)};
    s.onload = function(){ resolve({ ok: true, hasTerminal: !!window.Terminal }); };
    s.onerror = function(){ resolve({ ok: false, err: 'onerror' }); };
    document.head.appendChild(s);
    setTimeout(function(){ resolve({ ok: false, err: 'timeout' }); }, 5000);
  });
})()`);
console.log('④ 绝对路径加载: ' + JSON.stringify(loadTest2));

// ⑤ 检查文件是否真的在
const fileCheck = await cdp.eval(`(async function(){
  try {
    var r = await fetch(${JSON.stringify(absPath).replace(/^"|"$/g, '"')});
    return { status: r.status, ok: r.ok, size: r.headers.get('content-length') };
  } catch(e) { return { error: String(e) }; }
})()`);
console.log();
console.log('⑤ fetch 测试: ' + JSON.stringify(fileCheck));

cdp.close();
