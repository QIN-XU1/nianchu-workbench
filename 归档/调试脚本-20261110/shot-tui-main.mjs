import fs from 'node:fs';

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

// 展开主 Agent，切到 command 场景
await cdp.eval(`(async function(){
  document.body.dataset.mainAgent = 'on';
  try { await window.loadScenario('command'); } catch(e){}
  return true;
})()`);
await new Promise(r => setTimeout(r, 4000));

// 重启 TUI 到干净状态
console.log('重启 TUI…');
const r = await cdp.eval(`(async function(){
  try {
    await window.app.tui.stop('main-agent');
    await new Promise(function(r2){ setTimeout(r2, 600); });
    var res = await window.app.tui.start('main-agent', { cols: 52, rows: 30 });
    return res;
  } catch(e) { return { error: String(e) }; }
})()`);
console.log('启动: ' + JSON.stringify(r));

// 等引导页出现，然后 Esc 跳过
console.log('等 18 秒渲染引导页…');
await new Promise(r => setTimeout(r, 18000));

console.log('发送 Esc 跳过引导…');
await cdp.eval(`(async function(){ try { return await window.app.tui.input('main-agent', '\\u001b'); } catch(e){ return { error: String(e) }; } })()`);

console.log('等 6 秒进入主界面…');
await new Promise(r => setTimeout(r, 6000));

const OUT = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\screens`;
const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
if (s && s.data) {
  const f = OUT + '\\tui-02-main.png';
  fs.writeFileSync(f, Buffer.from(s.data, 'base64'));
  console.log('OK 截图: ' + f + '  ' + fs.statSync(f).size + ' bytes');
}

// 抓终端文本
const txt = await cdp.eval(`(function(){
  var rows = document.querySelector('.xterm-rows');
  if (!rows) return '';
  var out = [];
  for (var i = 0; i < rows.children.length; i++) {
    var t = (rows.children[i].textContent || '');
    out.push(t);
  }
  return out.join('\\n').replace(/\\n{3,}/g, '\\n\\n');
})()`);
console.log();
console.log('终端内容:');
console.log(String(txt).slice(0, 800));

cdp.close();
