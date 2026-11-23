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
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

console.log('=== 引擎连接状态 ===');
const st = await cdp.eval(`(async function(){
  try {
    var url = await window.app.getHarnessUrl();
    var ready = await window.app.isHarnessReady();
    return { url: url, ready: ready };
  } catch(e) { return { error: String(e) }; }
})()`);
console.log('  引擎 URL :', st.url || st.error);
console.log('  引擎就绪 :', st.ready);

console.log();
console.log('=== 引擎 webview 的实际内容 ===');
const wv = await cdp.eval(`(async function(){
  var out = [];
  var wvs = [].slice.call(document.querySelectorAll('webview'));
  for (var i = 0; i < wvs.length; i++) {
    var src = wvs[i].getAttribute('src') || '';
    out.push({ i: i, src: src.slice(0, 60), partition: wvs[i].getAttribute('partition') || '' });
  }
  return out;
})()`);
for (const w of wv) {
  console.log(`  [${w.i}] ${w.partition.padEnd(24)} ${w.src}`);
}

console.log();
console.log('=== 引擎 webview 里是不是真的连上了 ===');
// 通过 CDP 看 webview 的 target
const engines = targets.filter(t => t.type === 'webview' && t.url.includes('31238'));
console.log('  31238 的 webview target:', engines.length);
for (const e of engines) {
  console.log('    ' + (e.title || '').slice(0, 50) + '  |  ' + (e.url || '').slice(0, 50));
}

console.log();
console.log('=== 切到命令场景，看 AI 面板 ===');
await cdp.eval(`(async function(){ try { await window.loadScenario('command'); } catch(e){} })()`);
await new Promise(r => setTimeout(r, 3000));

const panels = await cdp.eval(`(function(){
  return [].slice.call(document.querySelectorAll('.panel')).map(function(p){
    var body = p.querySelector('.panel-body');
    return {
      id: p.dataset.panelId,
      kind: body ? body.dataset.kind : '',
      text: body ? (body.innerText || '').slice(0, 120) : '',
    };
  });
})()`);
for (const p of panels) {
  console.log(`  ${p.id.padEnd(14)} ${String(p.kind).padEnd(10)} "${p.text.replace(/\n/g, ' ').slice(0, 80)}"`);
}

cdp.close();
