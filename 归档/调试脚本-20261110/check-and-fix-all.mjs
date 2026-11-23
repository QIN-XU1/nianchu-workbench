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

console.log('═══ 全部 webview 的当前状态 ═══');
console.log();

const eng = targets.filter(t => t.type === 'webview' && t.url.includes('3080'));
console.log('3080 webview: ' + eng.length);
console.log();

const results = [];

for (let i = 0; i < eng.length; i++) {
  const t = eng[i];
  const cdp = CDP(t.webSocketDebuggerUrl);
  try {
    await cdp.connect();
    const st = await cdp.eval(`(function(){
      var c = document.querySelector('[class*="centerCol"]');
      var f = document.querySelector('[class*="frame"]');
      return {
        winW: window.innerWidth,
        centerW: c ? Math.round(c.getBoundingClientRect().width) : 0,
        template: f ? getComputedStyle(f).gridTemplateColumns : '',
        title: document.title,
      };
    })()`);
    console.log(`[${i}] title="${(st.title||'').slice(0,32)}" win=${st.winW} centerCol=${st.centerW} tpl="${st.template}"`);

    if (st.centerW > 0 && st.centerW < 300) {
      console.log('     ⚠ 过窄，修复中…');
      const fix = await cdp.eval(`(function(){
        var f = document.querySelector('[class*="frame"]');
        var c = document.querySelector('[class*="centerCol"]');
        if (!f || !c) return { error: 'nf' };
        f.style.gridTemplateColumns = '1fr';
        c.style.gridColumn = 'auto';
        document.querySelectorAll('[class*="drawerMask"]').forEach(function(el){ el.style.display='none'; });
        window.dispatchEvent(new Event('resize'));
        return { before: 0, after: Math.round(c.getBoundingClientRect().width) };
      })()`);
      console.log('     → centerCol = ' + fix.after);
      results.push({ i, before: st.centerW, after: fix.after });
    } else {
      console.log('     ✅ 正常');
    }
  } catch (e) {
    console.log(`[${i}] ERR: ${e.message.slice(0, 50)}`);
  } finally {
    cdp.close();
  }
}

console.log();
console.log('修复了 ' + results.length + ' 个');
