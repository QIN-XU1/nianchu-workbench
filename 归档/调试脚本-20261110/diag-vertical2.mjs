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
const eng = targets.filter(t => t.type === 'webview' && t.url.includes('3080'));

for (const t of eng) {
  const cdp = CDP(t.webSocketDebuggerUrl);
  try {
    await cdp.connect();
    const d = await cdp.eval(`(function(){
      var out = {
        title: document.title,
        winW: window.innerWidth,
        winH: window.innerHeight,
        centerW: 0,
        // 找竖排的元素：宽小高大的叶子节点
        narrow: [],
      };

      var center = document.querySelector('[class*="centerCol"]');
      if (center) out.centerW = Math.round(center.getBoundingClientRect().width);

      // 找所有文字被压窄的元素
      document.querySelectorAll('div, span, p, h1, h2, h3').forEach(function(el){
        if (el.children.length > 0) return;
        var r = el.getBoundingClientRect();
        var txt = (el.textContent || '').trim();
        if (!txt || txt.length < 3 || txt.length > 60) return;
        // 窄高比异常 = 竖排
        if (r.width > 0 && r.width < 40 && r.height > r.width * 2) {
          out.narrow.push({
            cls: String(el.className).slice(0, 30),
            w: Math.round(r.width),
            h: Math.round(r.height),
            txt: txt.slice(0, 15),
          });
        }
      });

      return out;
    })()`);

    console.log('--- ' + (d.title || '').slice(0, 35) + ' ---');
    console.log('  窗口: ' + d.winW + 'x' + d.winH + '  centerCol: ' + d.centerW);
    console.log('  竖排元素: ' + d.narrow.length + ' 个');
    for (const n of d.narrow.slice(0, 5)) {
      console.log('    .' + n.cls.padEnd(28) + n.w + 'x' + n.h + '  "' + n.txt + '"');
    }

    // 如果 centerCol 够宽但文字还竖排，检查是不是 zoom 问题
    if (d.centerW >= 300 && d.narrow.length > 0) {
      console.log('  ⚠ centerCol 够宽但文字仍竖排 —— 可能是 zoom/transform 问题');
      const zoom = await cdp.eval(`(function(){
        return {
          dpr: window.devicePixelRatio,
          zoom: getComputedStyle(document.body).zoom,
          transform: getComputedStyle(document.body).transform,
          htmlFontSize: getComputedStyle(document.documentElement).fontSize,
          bodyFontSize: getComputedStyle(document.body).fontSize,
        };
      })()`);
      console.log('    zoom 信息: ' + JSON.stringify(zoom));
    }
  } catch (e) {
    console.log('  ERR: ' + e.message.slice(0, 50));
  } finally {
    cdp.close();
  }
  console.log();
}
