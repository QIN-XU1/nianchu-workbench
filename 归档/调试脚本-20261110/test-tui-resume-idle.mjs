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

// 找一个空闲的、有内容的会话（不是我们当前对话）
const SID = 'session-6b9e702a-f8ac-47b9-b3bf-39c600f6160d';   // command 场景会话

console.log('═══ 测试 TUI resume 空闲会话 ═══');
console.log('  目标会话: ' + SID + '（command 场景，seq=45，running=false）');
console.log();

const start = await cdp.eval(`(async function(){
  try {
    await window.app.tui.stop('main-agent');
    await new Promise(function(r){ setTimeout(r, 500); });
    if (window.__TUI_PANEL && window.__TUI_PANEL.term) {
      window.__TUI_PANEL.term.clear();
      window.__TUI_PANEL.term.resize(54, 30);
    }
    var res = await window.app.tui.start('main-agent', {
      sessionId: ${JSON.stringify(SID)},
      cols: 54, rows: 30
    });
    return res;
  } catch(e) { return { error: String(e) }; }
})()`);
console.log('① 启动: ' + JSON.stringify(start));

console.log();
console.log('② 等待 15 秒…');
await new Promise(r => setTimeout(r, 15000));

const txt = await cdp.eval(`(function(){
  var rows = document.querySelector('.xterm-rows');
  if (!rows) return null;
  var out = [];
  for (var i = 0; i < rows.children.length; i++) {
    var t = (rows.children[i].textContent || '').replace(/\\s+$/, '');
    if (t) out.push(t);
  }
  return out.join('\\n');
})()`);

console.log();
console.log('③ 终端内容:');
console.log('─'.repeat(60));
console.log(String(txt).slice(0, 800));
console.log('─'.repeat(60));

console.log();
console.log('④ 判断:');
const s = String(txt);
if (s.includes('already owned') || s.includes('cannot resume')) {
  console.log('   ❌ 会话被占用');
} else if (s.includes('dsh-TUI') || s.includes('欢迎')) {
  console.log('   ✅ TUI 界面渲染成功');
} else if (s.length > 100) {
  console.log('   ⚠ 有内容但不确定');
} else {
  console.log('   ⚠ 输出很少');
}

cdp.close();
