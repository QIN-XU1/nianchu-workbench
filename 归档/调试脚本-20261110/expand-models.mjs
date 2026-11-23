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
  // 打开模型菜单
  await cdp.eval(`(function(){
    var b = document.querySelector('button._9r0rkG_trigger');
    if (b) b.click();
  })()`);
  await new Promise(r => setTimeout(r, 1200));

  // 点「模型」这一项（展开完整模型列表）
  const opened = await cdp.eval(`(function(){
    var menuitems = [].slice.call(document.querySelectorAll('[role="menuitem"], ._9r0rkG_menuItem, [class*="menuItem"]'));
    for (var m of menuitems) {
      var t = (m.textContent || '').trim();
      if (/^模型/.test(t)) { m.click(); return { ok: true, text: t.slice(0,40) }; }
    }
    // 退而用坐标点击「模型」文字
    var spans = [].slice.call(document.querySelectorAll('span, div'));
    for (var s of spans) {
      var t2 = (s.textContent || '').trim();
      if (t2 === '模型' && s.children.length === 0) {
        var r = s.getBoundingClientRect();
        return { ok: false, needClick: { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }, text: t2 };
      }
    }
    return { ok: false };
  })()`);
  console.log('点「模型」:', JSON.stringify(opened));

  if (opened.needClick) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: opened.needClick.x, y: opened.needClick.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: opened.needClick.x, y: opened.needClick.y, button: 'left', clickCount: 1 });
  }

  await new Promise(r => setTimeout(r, 2000));

  console.log();
  console.log('=== 模型列表 ===');
  const list = await cdp.eval(`(function(){
    var out = { models: [], bodyTail: '' };

    // 找所有可见的模型项
    var candidates = [];
    document.querySelectorAll('*').forEach(function(el){
      if (el.children.length > 0) return;
      var t = (el.textContent || '').trim();
      if (!t || t.length > 60) return;
      var r = el.getBoundingClientRect();
      if (r.width < 30 || r.height < 12) return;
      // 模型名特征：含 provider/ 或 DeepSeek 或 /
      if (/DeepSeek|official|account|raccoon|flash|pro|v4/i.test(t)) {
        candidates.push({ text: t.slice(0, 50), x: Math.round(r.x), y: Math.round(r.y) });
      }
    });

    // 去重
    var seen = {};
    for (var c of candidates) { if (!seen[c.text]) { seen[c.text] = 1; out.models.push(c); } }

    out.bodyTail = (document.body.innerText || '').slice(-900);
    return out;
  })()`);

  console.log('  模型项:', list.models.length);
  for (const m of list.models.slice(0, 30)) {
    console.log(`    "${m.text}"  @(${m.x},${m.y})`);
  }

  console.log();
  console.log('  界面尾部:');
  console.log(list.bodyTail.slice(-600));

} finally {
  cdp.close();
}
