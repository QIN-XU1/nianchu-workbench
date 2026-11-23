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
    close() { try { ws.close(); } catch { /* ignore */ } }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const engWv = targets.filter(t => t.type === 'webview' && t.url.includes('3080'));
const cdp = CDP(engWv[0].webSocketDebuggerUrl);
await cdp.connect();

try {
  console.log('=== 找模型选择器的真实 DOM 结构 ===');
  const st = await cdp.eval(`(function(){
    // 找含 DeepSeek-V4.1-Flash 的元素
    var hits = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      var el = walker.currentNode;
      var own = (el.textContent || '').trim();
      if (own && own.length < 50 && /DeepSeek-V4/.test(own)) {
        var r = el.getBoundingClientRect();
        hits.push({
          tag: el.tagName,
          cls: String(el.className).slice(0, 50),
          text: own.slice(0, 40),
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height),
          role: el.getAttribute('role') || '',
          clickable: !!(el.onclick || el.getAttribute('onclick')),
        });
      }
    }
    return hits;
  })()`);

  console.log('  命中元素:', st.length);
  for (const h of st) {
    console.log(`    ${h.tag} .${h.cls}`);
    console.log(`       "${h.text}"  @(${h.x},${h.y}) ${h.w}x${h.h} role=${h.role}`);
  }

  console.log();
  console.log('=== 尝试真实点击模型选择器位置 ===');
  if (st.length > 0) {
    const t = st[st.length - 1];
    const cx = t.x + t.w / 2;
    const cy = t.y + t.h / 2;

    // 用 Input.dispatchMouseEvent 真实点击
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });

    await new Promise(r => setTimeout(r, 1500));

    const after = await cdp.eval(`(function(){
      return {
        bodyTail: (document.body.innerText || '').slice(-600),
        dialogs: document.querySelectorAll('[role="dialog"], [class*="popover"], [class*="dropdown"]').length,
      };
    })()`);
    console.log('  点击后 dialog 数:', after.dialogs);
    console.log('  尾部文本:');
    console.log(after.bodyTail.slice(-400));
  }
} finally {
  cdp.close();
}
