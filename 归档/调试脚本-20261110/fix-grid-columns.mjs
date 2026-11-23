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
const cdp = CDP(eng[0].webSocketDebuggerUrl);
await cdp.connect();

console.log('═══ 尝试直接在 grid 里重分配 ═══');
const fix = await cdp.eval(`(function(){
  var frame = document.querySelector('[class*="frame"]');
  var center = document.querySelector('[class*="centerCol"]');
  var out = { steps: [] };

  if (!frame || !center) return { error: 'not found' };

  var fr = frame.getBoundingClientRect();
  var fcs = getComputedStyle(frame);
  out.before = { frameW: Math.round(fr.width), template: fcs.gridTemplateColumns, centerW: Math.round(center.getBoundingClientRect().width) };

  // ① 直接改 grid 模板：让 centerCol 占满
  var kids = Array.from(frame.children);
  out.childCount = kids.length;
  out.children = kids.map(function(k, i){
    var r = k.getBoundingClientRect();
    return { i: i, cls: String(k.className).slice(0, 30), w: Math.round(r.width), vis: getComputedStyle(k).display };
  });

  // 尝试：把 grid 改成单列，让 centerCol 拿全部
  frame.style.gridTemplateColumns = '1fr';
  out.steps.push('set frame gridTemplateColumns=1fr');

  // centerCol 本来是 gridColumn 2，改回 auto
  center.style.gridColumn = 'auto';
  out.steps.push('centerCol gridColumn=auto');

  window.dispatchEvent(new Event('resize'));

  var after = {
    frameW: Math.round(frame.getBoundingClientRect().width),
    template: getComputedStyle(frame).gridTemplateColumns,
    centerW: Math.round(center.getBoundingClientRect().width),
  };
  out.after = after;
  return out;
})()`);

console.log(JSON.stringify(fix, null, 2).slice(0, 700));

await new Promise(r => setTimeout(r, 1500));

const check = await cdp.eval(`(function(){
  var center = document.querySelector('[class*="centerCol"]');
  var frame = document.querySelector('[class*="frame"]');
  return {
    centerW: center ? Math.round(center.getBoundingClientRect().width) : 0,
    frameW: frame ? Math.round(frame.getBoundingClientRect().width) : 0,
    template: frame ? getComputedStyle(frame).gridTemplateColumns : '',
    winW: window.innerWidth,
    bodyText: (document.body.innerText || '').slice(0, 120),
  };
})()`);
console.log();
console.log('=== 检查结果 ===');
console.log(JSON.stringify(check, null, 2));

cdp.close();
