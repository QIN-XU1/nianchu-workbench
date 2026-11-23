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
if (!engWv.length) { console.log('无 3080 webview'); process.exit(1); }

const cdp = CDP(engWv[0].webSocketDebuggerUrl);
await cdp.connect();

try {
  console.log('=== 关闭所有弹窗 / 欢迎页 ===');

  // 连续点击关闭按钮
  for (let round = 0; round < 5; round++) {
    const r = await cdp.eval(`(function(){
      var closed = [];
      // 关闭按钮特征
      var candidates = [].slice.call(document.querySelectorAll('button'));
      for (var b of candidates) {
        var t = (b.textContent || '').trim();
        var aria = b.getAttribute('aria-label') || '';
        if (/关闭|Close|×|✕|✖|继续|开始|知道了|了解/i.test(t + aria)) {
          b.click();
          closed.push((t || aria).slice(0, 20));
        }
      }
      // 点遮罩层
      document.querySelectorAll('[class*="mask"], [class*="overlay"]').forEach(function(el){
        var r = el.getBoundingClientRect();
        if (r.width > 200 && r.height > 200) {
          el.click();
          closed.push('mask');
        }
      });
      return closed;
    })()`);
    console.log('  round ' + round + ':', JSON.stringify(r));
    await new Promise(x => setTimeout(x, 800));
  }

  // 检查是否干净了
  const clean = await cdp.eval(`(function(){
    var bodyText = (document.body.innerText || '');
    return {
      len: bodyText.length,
      head: bodyText.slice(0, 200),
      hasWelcome: /预览版说明/.test(bodyText),
      hasPluginPrompt: /Our Free Model/.test(bodyText),
    };
  })()`);
  console.log();
  console.log('=== 关闭后状态 ===');
  console.log('  正文长:', clean.len);
  console.log('  欢迎页还在:', clean.hasWelcome);
  console.log('  插件提示还在:', clean.hasPluginPrompt);
  console.log('  首段:', JSON.stringify(clean.head.slice(0, 150)));

  console.log();
  console.log('=== 找输入框 ===');
  const input = await cdp.eval(`(function(){
    var els = document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]');
    var out = [];
    for (var e of els) {
      var r = e.getBoundingClientRect();
      out.push({ tag: e.tagName, w: Math.round(r.width), h: Math.round(r.height), placeholder: e.getAttribute('placeholder') || e.getAttribute('data-placeholder') || '' });
    }
    return out;
  })()`);
  console.log('  ' + JSON.stringify(input));

} finally {
  cdp.close();
}
