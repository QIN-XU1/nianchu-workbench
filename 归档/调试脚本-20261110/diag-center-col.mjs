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
const eng = targets.filter(t => t.type === 'webview' && t.url.includes('3080') && t.title.includes('命令'));

if (!eng.length) { console.log('找不到 命令 webview'); process.exit(1); }

const cdp = CDP(eng[0].webSocketDebuggerUrl);
await cdp.connect();

console.log('=== .mP3x-q_centerCol 的完整样式 ===');
const info = await cdp.eval(`(function(){
  var c = document.querySelector('[class*="centerCol"]');
  if (!c) return { error: 'not found' };

  var cs = getComputedStyle(c);
  var r = c.getBoundingClientRect();

  // 父级链
  var chain = [];
  var cur = c.parentElement;
  var depth = 0;
  while (cur && depth < 5) {
    var cr = cur.getBoundingClientRect();
    var ccs = getComputedStyle(cur);
    chain.push({
      cls: String(cur.className).slice(0, 35),
      w: Math.round(cr.width),
      display: ccs.display,
      flex: ccs.flex,
      gridTemplate: ccs.gridTemplateColumns,
      position: ccs.position,
    });
    cur = cur.parentElement;
    depth++;
  }

  return {
    rect: { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x) },
    style: {
      width: cs.width,
      minWidth: cs.minWidth,
      maxWidth: cs.maxWidth,
      flex: cs.flex,
      flexBasis: cs.flexBasis,
      display: cs.display,
      position: cs.position,
      gridColumn: cs.gridColumn,
    },
    chain: chain,
    childCount: c.children.length,
    // 内部子元素宽度
    kids: Array.from(c.children).slice(0, 5).map(function(k){
      var kr = k.getBoundingClientRect();
      return { cls: String(k.className).slice(0, 30), w: Math.round(kr.width), display: getComputedStyle(k).display };
    }),
  };
})()`);

console.log(JSON.stringify(info, null, 2).slice(0, 1200));

cdp.close();
