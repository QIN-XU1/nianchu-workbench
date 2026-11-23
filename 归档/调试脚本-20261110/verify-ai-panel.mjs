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
const page = targets.find(t => t.type === 'page');
if (!page) { console.log('无主页面'); process.exit(1); }
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

console.log('=== 场景清单（含 sessionId）===');
const scenes = await cdp.eval(`(async function(){ return await window.app.listScenarios(); })()`);
for (const s of scenes) {
  console.log(`  ${s.id.padEnd(20)} ${s.name}`);
}

console.log();
console.log('=== 切到命令场景 ===');
await cdp.eval(`(async function(){ try { await window.loadScenario('command'); return 'ok'; } catch(e){ return 'err:'+e.message; } })()`);
await new Promise(r => setTimeout(r, 4000));

const panel = await cdp.eval(`(function(){
  var p = [].slice.call(document.querySelectorAll('.panel')).find(function(x){
    return (x.querySelector('.panel-body')||{}).dataset?.kind === 'harness';
  });
  if (!p) return null;
  var body = p.querySelector('.panel-body');
  var wv = body.querySelector('webview');
  return {
    id: p.dataset.panelId,
    hasWebview: !!wv,
    wvSrc: wv ? (wv.getAttribute('src')||'').slice(0, 60) : '',
    text: (body.innerText || '').slice(0, 200),
  };
})()`);
console.log('  AI 面板:', JSON.stringify(panel, null, 2));

console.log();
console.log('=== 检查 AI 面板的 webview target ===');
const all = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
console.log('  总 target:', all.length);
for (const t of all) {
  if (t.type === 'webview') {
    console.log(`    ${(t.title||'').slice(0,40).padEnd(42)} ${(t.url||'').slice(0,50)}`);
  }
}

cdp.close();
