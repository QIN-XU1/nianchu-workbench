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

console.log('=== 所有 CDP target ===');
for (const t of targets) {
  console.log(`  [${t.type}] ${(t.title || '').slice(0, 40)}  |  ${(t.url || '').slice(0, 60)}`);
}

console.log();
console.log('=== 44401 的 webview 里是什么 ===');
const engTargets = targets.filter(t => t.type === 'webview' && t.url.includes('44401'));
console.log('  44401 webview 数:', engTargets.length);

for (const t of engTargets) {
  const cdp = CDP(t.webSocketDebuggerUrl);
  try {
    await cdp.connect();
    const info = await cdp.eval(`(function(){
      return {
        title: document.title,
        url: location.href,
        bodyLen: (document.body.innerText || '').length,
        bodyHead: (document.body.innerText || '').slice(0, 200),
        hasComposer: !!document.querySelector('[data-composer-card], textarea, [contenteditable]'),
        textareaCount: document.querySelectorAll('textarea').length,
      };
    })()`);
    console.log();
    console.log('  title:', info.title);
    console.log('  url  :', info.url);
    console.log('  body :', info.bodyLen, '字符');
    console.log('  首段 :', JSON.stringify(info.bodyHead.slice(0, 120)));
    console.log('  输入框:', info.hasComposer, '(textarea:', info.textareaCount + ')');
  } catch (e) {
    console.log('  ERR:', e.message);
  } finally {
    cdp.close();
  }
}
