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

// 切到 pipeline
await cdp.eval(`(async function(){ try { await window.loadScenario('pipeline'); } catch(e){} })()`);
await new Promise(r => setTimeout(r, 3500));

console.log('═══ 定位竖排元素（架构梳理）═══');
console.log();

const r = await cdp.eval(`(function(){
  var out = { narrow: [], rows: [] };

  // 找窄高元素
  document.querySelectorAll('.panel-body *').forEach(function(el){
    if (el.children.length > 0) return;
    var rc = el.getBoundingClientRect();
    var txt = (el.textContent || '').trim();
    if (!txt || txt.length < 2 || txt.length > 30) return;
    if (rc.width > 0 && rc.width < 55 && rc.height > rc.width * 2.2) {
      out.narrow.push({
        cls: String(el.className).slice(0, 30),
        tag: el.tagName,
        w: Math.round(rc.width),
        h: Math.round(rc.height),
        txt: txt.slice(0, 12),
        parentCls: el.parentElement ? String(el.parentElement.className).slice(0, 30) : '',
      });
    }
  });

  // 找 sf-board 的行容器
  var rows = document.querySelectorAll('.panel-body[data-kind="sf-board"] *');
  var candidates = [];
  rows.forEach(function(el){
    var rc = el.getBoundingClientRect();
    if (rc.width > 100 && rc.height > 30 && rc.height < 120) {
      candidates.push({
        tag: el.tagName,
        cls: String(el.className).slice(0, 34),
        w: Math.round(rc.width),
        h: Math.round(rc.height),
        childCount: el.children.length,
        display: getComputedStyle(el).display,
        text: (el.textContent || '').trim().slice(0, 20),
      });
    }
  });
  out.rows = candidates.slice(0, 12);

  return out;
})()`);

console.log('竖排元素: ' + r.narrow.length + ' 个');
for (const n of r.narrow.slice(0, 8)) {
  console.log('  ' + n.tag + '.' + n.cls.padEnd(24) + n.w + 'x' + n.h + '  "' + n.txt + '"  父.' + n.parentCls);
}

console.log();
console.log('sf-board 行容器:');
for (const x of r.rows) {
  console.log('  ' + x.tag + '.' + x.cls.padEnd(30) + x.w + 'x' + x.h + '  display=' + x.display + ' 子' + x.childCount);
}

cdp.close();
