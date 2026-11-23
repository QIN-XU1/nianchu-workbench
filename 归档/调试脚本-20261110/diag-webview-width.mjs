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

console.log('=== ① 工作台侧：webview 的尺寸 ===');
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();
const wvInfo = await cdp.eval(`(function(){
  var out = [];
  document.querySelectorAll('webview').forEach(function(w, i){
    var r = w.getBoundingClientRect();
    var pr = w.parentElement ? w.parentElement.getBoundingClientRect() : null;
    out.push({
      i: i,
      src: (w.getAttribute('src')||'').slice(0, 40),
      w: Math.round(r.width), h: Math.round(r.height),
      parentW: pr ? Math.round(pr.width) : 0,
      parentTag: w.parentElement ? w.parentElement.tagName : '',
      parentCls: w.parentElement ? String(w.parentElement.className).slice(0, 30) : '',
      style: (w.getAttribute('style')||'').slice(0, 100),
    });
  });
  return out;
})()`);
for (const w of wvInfo) {
  console.log(`  [${w.i}] ${w.w}x${w.h}  parent=${w.parentTag}.${w.parentCls} ${w.parentW}px  ${w.src}`);
  if (w.style) console.log(`      style="${w.style}"`);
}
await cdp.close();

console.log();
console.log('=== ② 引擎侧：webview 内部的实际宽度 ===');
const engWv = targets.filter(t => t.type === 'webview' && t.url.includes('3080'));
console.log('  3080 webview 数: ' + engWv.length);

for (const t of engWv.slice(0, 2)) {
  const cdp2 = CDP(t.webSocketDebuggerUrl);
  try {
    await cdp2.connect();
    const inner = await cdp2.eval(`(function(){
      var b = document.body;
      var br = b.getBoundingClientRect();
      // 找最宽的元素
      var widest = null, maxW = 0;
      document.querySelectorAll('div').forEach(function(el){
        var r = el.getBoundingClientRect();
        if (r.width > maxW) { maxW = r.width; widest = String(el.className).slice(0, 30); }
      });
      return {
        winW: window.innerWidth,
        winH: window.innerHeight,
        bodyW: Math.round(br.width),
        bodyH: Math.round(br.height),
        widestW: Math.round(maxW),
        widestCls: widest,
        bodyOverflowX: getComputedStyle(b).overflowX,
        writingMode: getComputedStyle(b).writingMode,
        bodyFontSize: getComputedStyle(b).fontSize,
      };
    })()`);
    console.log(`  title="${(t.title||'').slice(0,40)}"`);
    console.log('    ' + JSON.stringify(inner));
  } catch (e) {
    console.log('    ERR: ' + e.message.slice(0, 60));
  } finally {
    cdp2.close();
  }
}
