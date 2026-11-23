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
const eng = targets.filter(t => t.type === 'webview' && t.url.includes('3080') && t.title.includes('调研'));

if (!eng.length) { console.log('找不到调研 webview'); process.exit(1); }

const cdp = CDP(eng[0].webSocketDebuggerUrl);
await cdp.connect();

console.log('═══ 对话区的实际布局 ═══');
console.log();

const d = await cdp.eval(`(function(){
  // 找对话消息容器
  var out = { regions: [] };

  // 遍历 centerCol 的直接子元素
  var center = document.querySelector('[class*="centerCol"]');
  if (center) {
    out.centerInfo = {
      w: Math.round(center.getBoundingClientRect().width),
      h: Math.round(center.getBoundingClientRect().height),
      childCount: center.children.length,
    };
    for (var c of center.children) {
      var r = c.getBoundingClientRect();
      var cs = getComputedStyle(c);
      out.regions.push({
        cls: String(c.className).slice(0, 35),
        w: Math.round(r.width),
        h: Math.round(r.height),
        display: cs.display,
        flex: cs.flex,
        minW: cs.minWidth,
        maxW: cs.maxWidth,
      });
    }
  }

  // 找消息气泡
  var bubbles = [];
  document.querySelectorAll('[class*="message"], [class*="bubble"], [class*="turn"]').forEach(function(el){
    var r = el.getBoundingClientRect();
    if (r.width > 0 && r.width < 200 && r.height > 200) {
      bubbles.push({ cls: String(el.className).slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) });
    }
  });
  out.narrowBubbles = bubbles.slice(0, 8);

  return out;
})()`);

console.log('  centerCol: ' + JSON.stringify(d.centerInfo));
console.log();
console.log('  centerCol 的子元素:');
for (const r of d.regions) {
  console.log('    .' + r.cls.padEnd(34) + r.w + 'x' + r.h + '  display=' + r.display + ' flex=' + r.flex);
  if (r.minW !== '0px' || r.maxW !== 'none') {
    console.log('       minW=' + r.minW + ' maxW=' + r.maxW);
  }
}
console.log();
console.log('  窄高消息气泡: ' + d.narrowBubbles.length + ' 个');
for (const b of d.narrowBubbles) {
  console.log('    .' + b.cls.padEnd(28) + b.w + 'x' + b.h);
}

cdp.close();
