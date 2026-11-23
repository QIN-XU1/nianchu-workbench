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
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 25000); });
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
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

console.log('═══ AI 面板状态诊断 ═══');
console.log();

const r = await cdp.eval(`(function(){
  var out = { harnessPanels: [], webviews: [], engineUrl: '' };

  // harness 面板
  document.querySelectorAll('.panel-body[data-kind="harness"]').forEach(function(b, i){
    var wv = b.querySelector('webview');
    var pin = b.querySelector('[class*="pin"], [title*="钉"]');
    out.harnessPanels.push({
      i: i,
      wvSrc: wv ? (wv.getAttribute('src') || '').slice(0, 60) : '(无 webview)',
      wvW: wv ? Math.round(wv.getBoundingClientRect().width) : 0,
      panelText: (b.innerText || '').slice(0, 80).replace(/\\n/g, ' | '),
      pinText: pin ? (pin.textContent || '').trim().slice(0, 20) : '',
    });
  });

  // 所有 webview
  document.querySelectorAll('webview').forEach(function(w){
    var rc = w.getBoundingClientRect();
    out.webviews.push({
      src: (w.getAttribute('src') || '').slice(0, 50),
      w: Math.round(rc.width),
      h: Math.round(rc.height),
    });
  });

  return out;
})()`);

console.log('harness 面板 ' + r.harnessPanels.length + ' 个:');
for (const p of r.harnessPanels) {
  console.log('  [' + p.i + '] webview=' + p.wvSrc + ' 宽=' + p.wvW);
  console.log('      文本: "' + p.panelText + '"');
  console.log('      pin: "' + p.pinText + '"');
}

console.log();
console.log('全部 webview:');
for (const w of r.webviews) {
  console.log('  ' + w.w + 'x' + w.h + '  ' + w.src);
}

cdp.close();
