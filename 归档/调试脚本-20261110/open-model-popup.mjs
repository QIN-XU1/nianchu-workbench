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
  // 1. 点模型触发器
  const clicked = await cdp.eval(`(function(){
    var b = document.querySelector('button._9r0rkG_trigger');
    if (!b) {
      // 退而找带 DeepSeek-V4 的 button
      var bs = [].slice.call(document.querySelectorAll('button'));
      b = bs.find(function(x){ return /DeepSeek-V4/.test(x.textContent || ''); });
    }
    if (!b) return { ok: false };
    b.click();
    return { ok: true, text: (b.textContent||'').trim().slice(0,30) };
  })()`);
  console.log('点击触发器:', JSON.stringify(clicked));

  await new Promise(r => setTimeout(r, 2000));

  // 2. 看弹出内容
  const popup = await cdp.eval(`(function(){
    var out = { menus: [], options: [], bodyTail: '' };

    // 找所有可见的 role=menu / listbox
    ['[role="menu"]','[role="listbox"]','[class*="menu"]','[class*="Menu"]','[class*="popover"]','[class*="Popover"]'].forEach(function(sel){
      document.querySelectorAll(sel).forEach(function(el){
        var r = el.getBoundingClientRect();
        if (r.width > 100 && r.height > 50) {
          out.menus.push({ cls: String(el.className).slice(0,40), w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent||'').slice(0,300) });
        }
      });
    });

    // 找所有 option
    document.querySelectorAll('[role="option"], [role="menuitem"]').forEach(function(el){
      var t = (el.textContent||'').trim();
      if (t) out.options.push(t.slice(0, 50));
    });

    out.bodyTail = (document.body.innerText || '').slice(-700);
    return out;
  })()`);

  console.log();
  console.log('=== 弹出菜单 ===');
  console.log('  menus:', popup.menus.length);
  for (const m of popup.menus) {
    console.log(`    .${m.cls}  ${m.w}x${m.h}`);
    console.log(`       "${m.text.slice(0, 200).replace(/\n/g, ' | ')}"`);
  }
  console.log();
  console.log('  options:', JSON.stringify(popup.options.slice(0, 20)));
  console.log();
  console.log('  界面尾部:');
  console.log(popup.bodyTail.slice(-500));

} finally {
  cdp.close();
}
