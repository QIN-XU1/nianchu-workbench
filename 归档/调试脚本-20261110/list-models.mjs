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
  // 先确保模型面板打开
  await cdp.eval(`(function(){
    var btns = [].slice.call(document.querySelectorAll('button'));
    for (var b of btns) {
      var t = (b.textContent || '').trim();
      if (/DeepSeek-V4/.test(t)) { b.click(); return true; }
    }
    return false;
  })()`);
  await new Promise(r => setTimeout(r, 1500));

  console.log('=== 模型选择面板内容 ===');
  const panel = await cdp.eval(`(function(){
    // 找所有可点击的模型项
    var out = { items: [], dropdowns: [] };

    // 找 dialog / popover
    var dlg = document.querySelector('[role="dialog"], [class*="popover"], [class*="dropdown"], [class*="menu"]');
    if (dlg) {
      out.dropdowns.push((dlg.textContent || '').slice(0, 400));
      // 里面的项
      dlg.querySelectorAll('[role="menuitem"], [role="option"], button, li').forEach(function(el){
        var t = (el.textContent||'').trim();
        if (t && t.length < 60) out.items.push(t);
      });
    }

    out.bodyTail = (document.body.innerText || '').slice(-500);
    return out;
  })()`);

  console.log('  下拉框文本:', JSON.stringify(panel.dropdowns.slice(0, 2)));
  console.log();
  console.log('  可点击项:', JSON.stringify(panel.items.slice(0, 25)));
  console.log();
  console.log('  界面尾部:');
  console.log(panel.bodyTail.slice(-400));

} finally {
  cdp.close();
}
