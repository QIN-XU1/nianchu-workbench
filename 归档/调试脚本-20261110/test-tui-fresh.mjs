/**
 * 放弃 resume，验证「TUI 新会话」方案
 *
 * 逻辑：
 *   用户要的是「把对话搬进工作台」
 *   → 主 Agent 的 TUI 开自己的新会话
 *   → 以后用户就在这里对话，不再用外部 Web GUI
 *   → 不存在会话占用冲突
 */

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

console.log('═══ 方案：TUI 新会话（不 resume）═══');
console.log();

// ① 启动新会话
const start = await cdp.eval(`(async function(){
  try {
    await window.app.tui.stop('main-agent');
    await new Promise(function(r){ setTimeout(r, 600); });
    if (window.__TUI_PANEL && window.__TUI_PANEL.term) {
      window.__TUI_PANEL.term.clear();
      window.__TUI_PANEL.term.resize(54, 32);
    }
    // 不传 sessionId
    var res = await window.app.tui.start('main-agent', { cols: 54, rows: 32 });
    return res;
  } catch(e) { return { error: String(e) }; }
})()`);
console.log('① 启动: ' + JSON.stringify(start));

console.log();
console.log('② 等 20 秒渲染…');
await new Promise(r => setTimeout(r, 20000));

const txt = await cdp.eval(`(function(){
  var rows = document.querySelector('.xterm-rows');
  if (!rows) return '';
  var out = [];
  for (var i = 0; i < rows.children.length; i++) {
    var t = (rows.children[i].textContent || '').replace(/\\s+$/, '');
    if (t.trim()) out.push(t);
  }
  return out.join('\\n');
})()`);

console.log();
console.log('③ 终端内容:');
console.log('─'.repeat(60));
console.log(String(txt).slice(0, 1200));
console.log('─'.repeat(60));

console.log();
if (String(txt).includes('already owned') || String(txt).includes('startup failed')) {
  console.log('❌ 仍失败');
} else if (String(txt).includes('dsh-TUI') || String(txt).includes('欢迎')) {
  console.log('✅ TUI 正常运行');
} else if (String(txt).length > 200) {
  console.log('✅ 有大量内容（TUI 在跑）');
} else {
  console.log('⚠ 内容少');
}

// ④ 发送一个按键测试交互（Esc 跳过引导）
console.log();
console.log('④ 测试交互：发送 Esc 跳过引导');
const escRes = await cdp.eval(`(async function(){
  try {
    var r = await window.app.tui.input('main-agent', '\\u001b');
    return r;
  } catch(e) { return { error: String(e) }; }
})()`);
console.log('   输入结果: ' + JSON.stringify(escRes));

await new Promise(r => setTimeout(r, 5000));

const txt2 = await cdp.eval(`(function(){
  var rows = document.querySelector('.xterm-rows');
  if (!rows) return '';
  var out = [];
  for (var i = 0; i < rows.children.length; i++) {
    var t = (rows.children[i].textContent || '').replace(/\\s+$/, '');
    if (t.trim()) out.push(t);
  }
  return out.join('\\n');
})()`);

console.log();
console.log('⑤ Esc 之后:');
console.log('─'.repeat(60));
console.log(String(txt2).slice(0, 1000));
console.log('─'.repeat(60));

cdp.close();
