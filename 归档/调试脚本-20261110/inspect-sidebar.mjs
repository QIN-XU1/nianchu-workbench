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
  // 展开侧边栏 + 列出所有会话
  console.log('=== 侧边栏完整内容 ===');

  // 先展开「其余会话」
  await cdp.eval(`(function(){
    var btns = [].slice.call(document.querySelectorAll('button'));
    for (var b of btns) {
      var t = (b.textContent||'').trim();
      if (/展开|更多会话|其余/.test(t)) { b.click(); return t; }
    }
    return null;
  })()`);
  await new Promise(r => setTimeout(r, 1500));

  const list = await cdp.eval(`(function(){
    // 找所有可能的会话项
    var candidates = [];
    document.querySelectorAll('*').forEach(function(el){
      var txt = (el.textContent || '').trim();
      if (txt.length > 0 && txt.length < 40 && el.children.length === 0) {
        candidates.push(txt);
      }
    });
    // 去重
    var uniq = [];
    var seen = {};
    for (var c of candidates) { if (!seen[c]) { seen[c] = 1; uniq.push(c); } }
    return { all: uniq.slice(0, 120), bodyText: (document.body.innerText || '').slice(0, 800) };
  })()`);

  console.log('叶子文本项:', list.all.length);
  console.log();

  // 检查我们的 11 个场景名
  const names = ['命令', '调研', '竞品拆解', '逆向分析', '架构梳理', '实施计划', '管线', '关系军师', '自我复盘', 'B站', '本地电脑'];
  console.log('=== 场景名检查 ===');
  const body = list.bodyText;
  for (const n of names) {
    const found = body.includes(n);
    console.log(`  ${found ? '✓' : '✗'} ${n}`);
  }

  console.log();
  console.log('=== body 全文（前 700 字）===');
  console.log(list.bodyText.slice(0, 700));

} finally {
  cdp.close();
}
