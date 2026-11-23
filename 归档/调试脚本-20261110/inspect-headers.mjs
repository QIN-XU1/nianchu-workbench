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
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

console.log('═══ 三层头部的真实内容 ═══');
console.log();

const diag = await cdp.eval(`(function(){
  var out = {};

  ['tui-statusbar','titlebar','scenebar'].forEach(function(id){
    var el = document.getElementById(id);
    if (!el) { out[id] = { missing: true }; return; }
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    // 直接子元素
    var kids = [];
    for (var c of el.children) {
      var cr = c.getBoundingClientRect();
      if (cr.width < 2 || cr.height < 2) continue;
      kids.push({
        tag: c.tagName,
        cls: String(c.className).slice(0, 30),
        x: Math.round(cr.x),
        w: Math.round(cr.width),
        text: (c.textContent || '').trim().slice(0, 40),
      });
    }
    out[id] = {
      h: Math.round(r.h),
      w: Math.round(r.width),
      y: Math.round(r.y),
      kidCount: kids.length,
      kids: kids.slice(0, 14),
      position: cs.position,
      bg: cs.backgroundColor,
    };
  });

  // scenebar 里的标签
  var tabs = document.querySelectorAll('#scenebar .tab, #scenebar [class*="tab"]');
  out.sceneTabs = [];
  tabs.forEach(function(t){
    var r = t.getBoundingClientRect();
    out.sceneTabs.push({ text: (t.textContent||'').trim().slice(0,20), w: Math.round(r.width), h: Math.round(r.height) });
  });

  return out;
})()`);

for (const id of ['tui-statusbar', 'titlebar', 'scenebar']) {
  const d = diag[id];
  console.log('【' + id + '】' + d.h + 'px  y=' + d.y + '  ' + d.kidCount + ' 个子元素');
  for (const k of d.kids) {
    console.log('    ' + k.tag.padEnd(8) + ' .' + k.cls.padEnd(24) + ' x=' + String(k.x).padStart(4) + ' w=' + String(k.w).padStart(4) + '  "' + k.text + '"');
  }
  console.log();
}

console.log('场景标签: ' + diag.sceneTabs.length + ' 个');
for (const t of diag.sceneTabs.slice(0, 12)) {
  console.log('  "' + t.text + '"  ' + t.w + 'x' + t.h);
}

cdp.close();
