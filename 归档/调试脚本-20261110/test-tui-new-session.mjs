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

console.log('═══ 用新会话测试 TUI 渲染 ═══');
console.log();

// 手动重启 TUI（不 resume）
const r = await cdp.eval(`(async function(){
  try {
    // 停掉旧的
    await window.app.tui.stop('main-agent');
    await new Promise(function(r){ setTimeout(r, 500); });
    // 用新会话启动（不传 sessionId）
    var res = await window.app.tui.start('main-agent', { cols: 60, rows: 20 });
    return res;
  } catch(e) { return { error: String(e) }; }
})()`);
console.log('① 启动结果: ' + JSON.stringify(r));

// 等 15 秒看渲染
console.log();
console.log('② 等待 15 秒…');
await new Promise(x => setTimeout(x, 15000));

const content = await cdp.eval(`(function(){
  var scr = document.querySelector('.xterm-screen');
  if (!scr) return { error: 'no screen' };
  // xterm 把每行渲染成 .xterm-rows 的 div
  var rows = scr.querySelector('.xterm-rows');
  if (rows) {
    var lines = [];
    for (var i = 0; i < rows.children.length; i++) {
      var t = (rows.children[i].textContent || '').trim();
      if (t) lines.push(t);
    }
    return { lines: lines.slice(0, 20), count: lines.length };
  }
  return { text: (scr.innerText || '').slice(0, 400) };
})()`);

console.log();
console.log('③ 终端渲染内容:');
if (content.lines) {
  console.log('   有内容的行数: ' + content.count);
  for (const l of content.lines) console.log('   | ' + l.slice(0, 100));
} else {
  console.log('   ' + JSON.stringify(content).slice(0, 300));
}

// PTY 状态
const st = await cdp.eval(`(async function(){ try { return await window.app.tui.status(); } catch(e){ return {error:String(e)}; } })()`);
console.log();
console.log('④ PTY 状态: ' + JSON.stringify(st));

cdp.close();
