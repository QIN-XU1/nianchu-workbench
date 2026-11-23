const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  const buf = [];
  return {
    buf,
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 5000);
        ws.addEventListener('open', () => { clearTimeout(t); res(); });
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('失败')); });
        ws.addEventListener('message', (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch { return; }
          if (m.method === 'Runtime.consoleAPICalled') {
            const args = (m.params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || ''));
            buf.push(m.params.type + ': ' + args.join(' ').slice(0, 300));
          }
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

// 在页面里挂一个钩子，捕获所有 tui:data
const hook = await cdp.eval(`(function(){
  window.__tuiRaw = [];
  if (window.__tuiRawHooked) return 'already';
  window.__tuiRawHooked = true;
  // 直接监听 IPC（preload 已暴露 onData，但我们再包一层）
  if (window.app && window.app.tui && window.app.tui.onData) {
    window.app.tui.onData(function(id, data){
      window.__tuiRaw.push({ id: id, len: data.length, head: data.slice(0, 200) });
    });
  }
  return 'hooked';
})()`);
console.log('钩子: ' + hook);

console.log();
console.log('重启 TUI resume 空闲会话，捕获原始 PTY 输出…');

const SID = 'session-6b9e702a-f8ac-47b9-b3bf-39c600f6160d';
const r = await cdp.eval(`(async function(){
  try {
    await window.app.tui.stop('main-agent');
    await new Promise(function(r2){ setTimeout(r2, 500); });
    window.__tuiRaw = [];
    var res = await window.app.tui.start('main-agent', { sessionId: ${JSON.stringify(SID)}, cols: 54, rows: 30 });
    return res;
  } catch(e) { return { error: String(e) }; }
})()`);
console.log('启动: ' + JSON.stringify(r));

await new Promise(x => setTimeout(x, 12000));

const raw = await cdp.eval(`(function(){
  return {
    count: (window.__tuiRaw || []).length,
    total: (window.__tuiRaw || []).reduce(function(a,b){ return a + b.len; }, 0),
    samples: (window.__tuiRaw || []).slice(0, 6).map(function(x){ return { len: x.len, head: x.head.replace(/\\x1b/g, '␛') }; }),
  };
})()`);

console.log();
console.log('═══ 原始 PTY 输出 ═══');
console.log('  数据块数: ' + raw.count + '  总字符: ' + raw.total);
console.log();
for (const s of raw.samples) {
  console.log('  [' + s.len + ' 字符] ' + String(s.head).slice(0, 160));
}

console.log();
console.log('═══ 控制台日志 ═══');
for (const l of cdp.buf.slice(-10)) console.log('  ' + l);

cdp.close();
