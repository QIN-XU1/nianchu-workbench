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
console.log('=== 所有 3080 webview ===');
const eng = targets.filter(t => t.type === 'webview' && t.url.includes('3080'));
for (const t of eng) console.log('  ' + (t.title || '').slice(0, 40));

// 逐个检查内部布局
for (const t of eng) {
  const cdp = CDP(t.webSocketDebuggerUrl);
  try {
    await cdp.connect();
    const info = await cdp.eval(`(function(){
      var b = document.body;
      var br = b.getBoundingClientRect();

      // 找一个主内容容器
      var main = document.querySelector('[class*="centerCol"], main, [class*="chat"], [class*="Chat"]');
      var mr = main ? main.getBoundingClientRect() : null;

      // 检查是否有元素被压到极窄
      var narrow = [];
      document.querySelectorAll('div, span, p').forEach(function(el){
        var r = el.getBoundingClientRect();
        if (r.width > 0 && r.width < 120 && r.height > r.width * 3 && el.children.length === 0) {
          var txt = (el.textContent || '').trim();
          if (txt.length > 2 && txt.length < 40) {
            narrow.push({ cls: String(el.className).slice(0, 25), w: Math.round(r.width), h: Math.round(r.height), txt: txt.slice(0, 20) });
          }
        }
      });

      return {
        winW: window.innerWidth,
        winH: window.innerHeight,
        bodyW: Math.round(br.width),
        bodyWritingMode: getComputedStyle(b).writingMode,
        htmlW: Math.round(document.documentElement.getBoundingClientRect().width),
        devicePixelRatio: window.devicePixelRatio,
        zoom: Math.round((window.outerWidth / window.innerWidth) * 100) / 100,
        narrowCount: narrow.length,
        narrowSample: narrow.slice(0, 5),
        mainW: mr ? Math.round(mr.width) : 0,
        mainCls: main ? String(main.className).slice(0, 30) : '',
      };
    })()`);
    console.log();
    console.log('--- ' + (t.title || '').slice(0, 40) + ' ---');
    console.log('  win   ' + info.winW + 'x' + info.winH + '  dpr=' + info.devicePixelRatio);
    console.log('  body  ' + info.bodyW + 'px  writing-mode=' + info.bodyWritingMode);
    console.log('  main  ' + info.mainW + 'px  .' + info.mainCls);
    console.log('  极窄元素: ' + info.narrowCount);
    for (const n of info.narrowSample) {
      console.log('    .' + n.cls + '  ' + n.w + 'x' + n.h + '  "' + n.txt + '"');
    }
  } catch (e) {
    console.log('  ERR ' + e.message.slice(0, 50));
  } finally {
    cdp.close();
  }
}
