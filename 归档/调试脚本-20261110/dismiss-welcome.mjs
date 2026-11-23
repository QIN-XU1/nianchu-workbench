import fs from 'node:fs';

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

// 找 3080 的 webview
const eng = targets.find(t => t.type === 'webview' && t.url.includes('3080'));
if (!eng) {
  console.log('找不到 3080 webview');
  process.exit(1);
}

console.log('=== 引擎 webview 状态 ===');
console.log('  title:', eng.title);
console.log('  url  :', eng.url);

const cdp = CDP(eng.webSocketDebuggerUrl);
await cdp.connect();

try {
  const info = await cdp.eval(`(function(){
    return {
      title: document.title,
      bodyLen: (document.body.innerText || '').length,
      bodyHead: (document.body.innerText || '').slice(0, 300),
      buttons: [].slice.call(document.querySelectorAll('button')).map(function(b){ return (b.textContent||'').trim().slice(0, 20); }).filter(Boolean).slice(0, 10),
      textareas: document.querySelectorAll('textarea').length,
      hasWelcome: /预览版说明|欢迎|继续/.test(document.body.innerText || ''),
    };
  })()`);
  console.log();
  console.log('  title  :', info.title);
  console.log('  正文长 :', info.bodyLen);
  console.log('  首段   :', JSON.stringify(info.bodyHead.slice(0, 150)));
  console.log('  按钮   :', JSON.stringify(info.buttons));
  console.log('  textarea:', info.textareas);
  console.log('  有欢迎页:', info.hasWelcome);

  // 点「继续」关掉欢迎页
  if (info.hasWelcome) {
    console.log();
    console.log('=== 点「继续」关掉欢迎页 ===');
    const clicked = await cdp.eval(`(function(){
      var btns = [].slice.call(document.querySelectorAll('button'));
      for (var i = 0; i < btns.length; i++) {
        var t = (btns[i].textContent || '').trim();
        if (t === '继续' || t === 'Continue' || t === '开始') {
          btns[i].click();
          return { ok: true, btn: t };
        }
      }
      return { ok: false };
    })()`);
    console.log('  ' + JSON.stringify(clicked));

    await new Promise(r => setTimeout(r, 2000));

    const after = await cdp.eval(`(function(){
      return {
        bodyLen: (document.body.innerText || '').length,
        bodyHead: (document.body.innerText || '').slice(0, 150),
        textareas: document.querySelectorAll('textarea').length,
      };
    })()`);
    console.log('  点击后正文长:', after.bodyLen);
    console.log('  点击后首段  :', JSON.stringify(after.bodyHead.slice(0, 100)));
    console.log('  输入框数    :', after.textareas);
  }
} finally {
  cdp.close();
}
