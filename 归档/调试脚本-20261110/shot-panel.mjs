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

// 拿 webview 的屏幕坐标
const rect = await cdp.eval(`(function(){
  var wvs = [].slice.call(document.querySelectorAll('webview'));
  var out = [];
  for (var w of wvs) {
    var src = w.getAttribute('src') || '';
    if (!src.includes('3080')) continue;
    var r = w.getBoundingClientRect();
    if (r.width < 100) continue;
    out.push({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), src: src.slice(0, 40) });
  }
  return out;
})()`);
console.log('3080 webview 位置: ' + JSON.stringify(rect));

if (rect.length > 0) {
  const r = rect[0];
  // 裁剪截图
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 },
  });
  if (shot && shot.data) {
    const fs = await import('node:fs');
    const out = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\screens\panel-only.png`;
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('已保存: ' + out);
  }
}

cdp.close();
