/**
 * 诊断：为什么点了顶栏按钮 webview 没重建
 *
 * 现象：销毁 4 个站的 webview 元素后，点顶栏按钮，webview 数没增加（2→2）。
 *
 * 可能原因：
 *   ① webAiToggle 认为"已经开着"（状态没清）
 *   ② webAiEnsure 找不回归属容器
 *   ③ 销毁时把状态对象里也清了/没清
 */

const CDP_PORT = 9333;
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

class CDP {
  constructor(u) { this.u = u; this.ws = null; this.id = 1; this.p = new Map(); }
  async connect() {
    return new Promise((res, rej) => {
      const ws = new WebSocket(this.u); this.ws = ws;
      const t = setTimeout(() => rej(new Error('超时')), 5000);
      ws.addEventListener('open', () => { clearTimeout(t); res(); });
      ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('失败')); });
      ws.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.p.has(m.id)) { const { resolve, reject } = this.p.get(m.id); this.p.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
      });
    });
  }
  send(method, params = {}) {
    const id = this.id++;
    return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error(method + ' 超时')); } }, 25000); });
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 错误');
    return r.result?.value;
  }
  async close() { const ws = this.ws; if (!ws) return; this.ws = null; try { await new Promise(r => { ws.addEventListener('close', r); ws.close(); setTimeout(r, 500); }); } catch { /* ignore */ } }
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();

try {
  console.log(`${C.bold}诊断：为什么重建失败${C.reset}\n`);

  const diag = await cdp.eval(`(function(){
    var st = window.__kunWebAi;
    var out = {
      hasState: !!st,
      winsKeys: st ? Object.keys(st.wins) : [],
      warmed: st ? st.warmed : null,
      layerExists: !!(st && st.layer && document.body.contains(st.layer)),
      domWins: [].slice.call(document.querySelectorAll('.webai-win')).map(function(el){
        return el.dataset.key || '(no key)';
      }),
      webviews: document.querySelectorAll('webview').length,
      // 顶栏按钮
      btns: [].slice.call(document.querySelectorAll('.webai-btn')).map(function(b){
        return { key: b.dataset.key || '', title: (b.getAttribute('title')||'').slice(0,24), cls: b.className };
      }),
    };
    return out;
  })()`);

  console.log(`  __kunWebAi 状态存在: ${diag.hasState}`);
  console.log(`  wins 里记录的站点: ${JSON.stringify(diag.winsKeys)}`);
  console.log(`  warmed: ${diag.warmed}`);
  console.log(`  layer 还在 DOM: ${diag.layerExists}`);
  console.log(`  DOM 里的 .webai-win: ${JSON.stringify(diag.domWins)}`);
  console.log(`  当前 webview: ${diag.webviews}`);
  console.log(`\n  顶栏按钮:`);
  for (const b of diag.btns) {
    console.log(`    key=${b.key.padEnd(12)} cls=${b.cls.slice(0,30).padEnd(32)} ${b.title}`);
  }

  console.log(`\n${C.bold}判断${C.reset}`);
  const staleWins = diag.winsKeys.filter(k => !diag.domWins.includes(k));
  if (staleWins.length > 0) {
    console.log(`  ${C.red}✗ 找到根因：wins 里记录着已不存在的站点 ${JSON.stringify(staleWins)}${C.reset}`);
    console.log(`     webAiToggle 检查 wins[key] 存在就认为"已打开"，于是走"关闭"路径而不是"打开"`);
  } else {
    console.log(`  wins 与 DOM 一致`);
  }

  // 检查 webAiToggle 的实现
  const fnSrc = await cdp.eval(`(function(){
    try {
      if (typeof webAiToggle === 'function') return webAiToggle.toString().slice(0, 600);
      return '(webAiToggle 不在全局作用域)';
    } catch(e) { return String(e); }
  })()`);
  console.log(`\n  webAiToggle 前 600 字符:`);
  console.log(fnSrc);

} finally {
  await cdp.close();
}
