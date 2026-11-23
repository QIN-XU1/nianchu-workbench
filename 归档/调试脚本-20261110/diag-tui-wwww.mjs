const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  const data = [];
  return {
    data,
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

console.log('═══ dsh-TUI 终端实际状态 ═══');
console.log();

// ① 终端真实行内容（xterm 用 rows 渲染）
const lines = await cdp.eval(`(function(){
  var frame = document.getElementById('ma-tui-frame');
  if (!frame) return { error: 'no frame' };
  var rows = frame.querySelector('.xterm-rows');
  if (rows) {
    var out = [];
    for (var i = 0; i < rows.children.length; i++) {
      var t = (rows.children[i].textContent || '');
      out.push(t);
    }
    // 找非空行
    return { rowsCount: rows.children.length, nonEmpty: out.filter(function(x){ return x.trim(); }), sample: out.slice(0, 20).join('\\n') };
  }
  // 兜底：读 innerText
  return { fallback: (frame.innerText || '').slice(0, 400) };
})()`);
console.log('① xterm rows:');
console.log(JSON.stringify(lines, null, 2).slice(0, 1200));

// ② PTY 状态
console.log();
const pty = await cdp.eval(`(async function(){
  try { return await window.app.tui.status(); } catch(e){ return {error:String(e)}; }
})()`);
console.log('② PTY 状态: ' + JSON.stringify(pty));

// ③ 终端尺寸
console.log();
const dims = await cdp.eval(`(function(){
  var frame = document.getElementById('ma-tui-frame');
  var r = frame.getBoundingClientRect();
  var T = window.Terminal;
  return { frameW: Math.round(r.width), frameH: Math.round(r.height) };
})()`);
console.log('③ 终端区域: ' + JSON.stringify(dims));

cdp.close();
