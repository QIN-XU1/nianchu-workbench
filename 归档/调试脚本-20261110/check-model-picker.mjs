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
const engWv = targets.filter(t => t.type === 'webview' && t.url.includes('3080'));
const cdp = CDP(engWv[0].webSocketDebuggerUrl);
await cdp.connect();

try {
  console.log('=== 引擎里的模型选择器 ===');
  const models = await cdp.eval(`(function(){
    // 找模型相关元素
    var out = { texts: [], buttons: [] };
    // 顶栏区域
    var els = document.querySelectorAll('[class*="model"], [class*="Model"], [aria-label*="模型"], [title*="模型"]');
    for (var e of els) {
      var t = (e.textContent || '').trim();
      if (t && t.length < 40) out.texts.push(t);
    }
    // 所有按钮
    document.querySelectorAll('button').forEach(function(b){
      var t = (b.textContent||'').trim();
      if (t && t.length < 30) out.buttons.push(t);
    });
    return out;
  })()`);
  console.log('  模型相关文本:', JSON.stringify(models.texts.slice(0, 10)));
  console.log('  按钮:', JSON.stringify(models.buttons.slice(0, 20)));

  console.log();
  console.log('=== 打开模型选择器 ===');
  const opened = await cdp.eval(`(function(){
    var btns = [].slice.call(document.querySelectorAll('button'));
    for (var b of btns) {
      var t = (b.textContent || '').trim();
      if (/DeepSeek|模型|V4|Flash/.test(t) && t.length < 40) {
        b.click();
        return t;
      }
    }
    return null;
  })()`);
  console.log('  点了:', JSON.stringify(opened));

  await new Promise(r => setTimeout(r, 1500));

  const after = await cdp.eval(`(function(){
    return {
      bodyText: (document.body.innerText || '').slice(0, 600),
    };
  })()`);
  console.log();
  console.log('=== 点击后界面 ===');
  console.log(after.bodyText.slice(0, 500));

} finally {
  cdp.close();
}
