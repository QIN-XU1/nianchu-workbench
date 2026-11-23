/**
 * 查 webai API —— 能不能通过程序关闭免费 AI 站
 *
 * 目的：做 A/B 实验证明"4 个免费 AI 站 = GPU 内存大头"这个假设。
 * 不做实验就说"是它们"，那是猜。
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
    return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error(method + ' 超时')); } }, 20000); });
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
  console.log(`${C.bold}webai API 能力面${C.reset}\n`);

  const api = await cdp.eval(`(function(){
    var w = window.app && window.app.webai;
    if (!w) return { error: 'no webai' };
    var out = { keys: Object.keys(w), methods: [] };
    Object.keys(w).forEach(function(k){
      if (typeof w[k] === 'function') out.methods.push(k + '(' + (w[k].length || 0) + '参数)');
    });
    return out;
  })()`);
  console.log(`  keys: ${JSON.stringify(api.keys)}`);
  console.log(`  methods: ${JSON.stringify(api.methods)}`);

  // 看是否有隐藏/关闭面板的能力
  const caps = await cdp.eval(`(function(){
    var out = {};
    // 找顶栏那些 AI 图标的状态
    var icons = [].slice.call(document.querySelectorAll('[class*="webai"], [data-webai]'));
    out.iconCount = icons.length;
    out.icons = icons.slice(0, 12).map(function(el){
      return { cls: (el.className||'').slice(0, 30), title: (el.title||'').slice(0, 20), visible: el.getBoundingClientRect().width > 0 };
    });
    // 是否有隐藏的容器
    var hidden = [].slice.call(document.querySelectorAll('webview')).filter(function(w){
      var r = w.getBoundingClientRect();
      return r.width === 0 || r.height === 0;
    }).length;
    out.hiddenWebviews = hidden;
    return out;
  })()`);
  console.log(`\n  webai 图标/元素: ${caps.iconCount}`);
  console.log(`  隐藏的 webview: ${caps.hiddenWebviews}`);
  for (const i of caps.icons) {
    console.log(`    ${i.visible ? '可见' : '隐藏'}  cls=${i.cls}  title=${i.title}`);
  }

} finally {
  await cdp.close();
}
