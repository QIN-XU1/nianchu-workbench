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

// 用 Electron API 改窗口大小（模拟拖拽）
console.log('═══ 模拟窗口拖拽 ═══');
console.log();

const winInfo = await cdp.eval(`(function(){
  return {
    avail: { w: screen.availWidth, h: screen.availHeight },
    // 拿 Electron 的窗口尺寸需要走 preload，先看有哪些 API
    hasSysSetSize: typeof window.app?.sys?.setWindowSize,
    sysKeys: Object.keys(window.app?.sys || {}),
    windowKeys: Object.keys(window.app || {}).slice(0, 30),
  };
})()`);
console.log('  sys API: ' + JSON.stringify(winInfo.sysKeys));
console.log('  其他: ' + JSON.stringify(winInfo.windowKeys));

console.log();
console.log('═══ 检查 CSS 是否有固定的像素宽度 ═══');
const cssCheck = await cdp.eval(`(function(){
  var grid = document.getElementById('grid');
  var out = { gridInline: grid ? grid.style.gridTemplateColumns : '(无grid)', issues: [] };

  // 检查哪些元素有写死的 px 宽度
  var fixedW = [];
  document.querySelectorAll('body[data-tui-mode="on"] *').forEach(function(el){
    if (el.tagName === 'WEBVIEW') return;
    var cs = getComputedStyle(el);
    var w = cs.width;
    if (w && w.endsWith('px') && parseInt(w) > 200) {
      var parentW = el.parentElement ? el.parentElement.getBoundingClientRect().width : 0;
      // 如果元素宽度接近父级但不等于，或明显不符合比例
      fixedW.push({
        cls: String(el.className).slice(0, 25),
        w: Math.round(parseFloat(w)),
        parentW: Math.round(parentW),
        ratio: parentW > 0 ? Math.round(parseFloat(w) / parentW * 100) : 0,
      });
    }
  });
  out.fixedWidths = fixedW.slice(0, 15);
  return out;
})()`);
console.log('  grid 内联: "' + cssCheck.gridInline + '"');
console.log();
console.log('  可疑的固定宽度元素:');
for (const f of cssCheck.fixedWidths) {
  console.log('    .' + f.cls.padEnd(26) + f.w + 'px  父 ' + f.parentW + 'px  ' + f.ratio + '%');
}

cdp.close();
