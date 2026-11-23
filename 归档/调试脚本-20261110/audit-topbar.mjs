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

console.log('═══ 顶栏所有可点击元素 ═══');
console.log();

const bars = await cdp.eval(`(function(){
  var out = {};

  // titlebar 的按钮
  var tb = document.getElementById('titlebar');
  out.titlebar = [];
  if (tb) {
    tb.querySelectorAll('button').forEach(function(b){
      var r = b.getBoundingClientRect();
      out.titlebar.push({
        id: b.id, cls: String(b.className).slice(0, 30),
        text: (b.textContent || '').trim().slice(0, 15),
        title: (b.title || '').slice(0, 40),
        x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height),
        visible: r.width > 0 && r.height > 0,
      });
    });
  }

  // topbar-status 注入的胶囊
  out.pills = [];
  document.querySelectorAll('[class*="tbs-"], [class*="pill"], .tb-pill').forEach(function(el){
    var r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      out.pills.push({
        cls: String(el.className).slice(0, 40),
        text: (el.textContent || '').trim().slice(0, 20),
        title: (el.title || '').slice(0, 40),
        x: Math.round(r.x), w: Math.round(r.width),
      });
    }
  });

  // 所有可见的 button（全页）
  out.allButtons = [];
  document.querySelectorAll('button').forEach(function(b){
    var r = b.getBoundingClientRect();
    if (r.width < 5 || r.height < 5) return;
    if (r.y > 100) return;   // 只看顶栏区
    out.allButtons.push({
      id: b.id, cls: String(b.className).slice(0, 25),
      text: (b.textContent || '').trim().slice(0, 12),
      title: (b.title || '').slice(0, 35),
      x: Math.round(r.x),
    });
  });

  return out;
})()`);

console.log('【titlebar 按钮】' + bars.titlebar.length + ' 个');
for (const b of bars.titlebar) {
  const flag = !b.visible ? ' (不可见)' : '';
  console.log(`  ${(b.id || '(无id)').padEnd(16)} "${b.text}"  title="${b.title}"${flag}`);
}

console.log();
console.log('【topbar-status 胶囊】' + bars.pills.length + ' 个');
for (const p of bars.pills) {
  console.log(`  .${p.cls.padEnd(28)} "${p.text}"  title="${p.title}"  x=${p.x}`);
}

console.log();
console.log('【顶栏区所有按钮】' + bars.allButtons.length + ' 个');
for (const b of bars.allButtons) {
  console.log(`  x=${String(b.x).padStart(4)} ${(b.id || '').padEnd(14)} "${b.text.padEnd(8)}" ${b.title}`);
}

cdp.close();
