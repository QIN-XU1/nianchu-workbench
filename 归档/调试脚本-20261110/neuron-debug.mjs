/**
 * 深查神经元的两个问题：
 *   ① "路径失效 2" —— 它认为有 2 个路径无效
 *   ② "数据源 0 / 项目 0" —— 这两类根本没数据
 *   ③ file.read 返回 15 bytes —— 像是错误信息而不是文件内容
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
  console.log(`${C.bold}神经元深查${C.reset}\n`);

  // 1 file.read 真实行为
  console.log(`${C.bold}【1】app.file.read 的真实返回${C.reset}`);
  const readTest = await cdp.eval(`(async function(){
    var P = window.app.paths;
    var F = window.app.file;
    var out = { memRoot: P.memRoot, api: Object.keys(F || {}) };
    var root = P.memRoot;
    var tests = [
      root + '\\\\_共享记忆\\\\索引.json',
      root + '\\\\_共享记忆\\\\记忆地图.json',
      root + '\\\\命令\\\\场景私有记忆.md',
    ];
    out.reads = [];
    for (var t of tests) {
      try {
        var r = await F.read(t);
        out.reads.push({ path: t.replace(root, '<root>'), type: typeof r, len: r ? String(r).length : 0, head: r ? String(r).slice(0, 60) : '' });
      } catch(e) {
        out.reads.push({ path: t.replace(root, '<root>'), err: String(e).slice(0, 80) });
      }
    }
    return out;
  })()`);
  console.log(JSON.stringify(readTest, null, 2).slice(0, 700));

  // 2 神经元的"路径失效"是哪两个
  console.log(`\n${C.bold}【2】哪 2 个路径失效${C.reset}`);
  const brokenPaths = await cdp.eval(`(function(){
    // 从 neuron 的数据结构里找 broken 标记
    var res = { found: false, items: [] };
    var keys = Object.keys(window).filter(function(k){ return /neuron|memory|kunMem/i.test(k); });
    res.globals = keys;
    // 尝试从 DOM 上找 title 属性（失效节点通常有 title）
    var p = [].slice.call(document.querySelectorAll('.panel')).find(function(x){
      return (x.querySelector('.panel-body')||{}).dataset?.kind === 'neuron';
    });
    if (p) {
      var body = p.querySelector('.panel-body');
      // 找所有带 title 的元素
      var all = body.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var t = all[i].getAttribute && all[i].getAttribute('title');
        if (t && /失效|broken|不存在|missing/i.test(t)) {
          res.items.push({ tag: all[i].tagName, cls: all[i].className, title: t.slice(0, 100) });
        }
      }
    }
    return res;
  })()`);
  console.log(JSON.stringify(brokenPaths, null, 2).slice(0, 600));

  // 3 神经元的数据组装逻辑：它读哪些文件
  console.log(`\n${C.bold}【3】神经元的数据源清单${C.reset}`);
  const srcInfo = await cdp.eval(`(function(){
    // renderers.js 的 neuron 里定义了 MEM_KINDS 等常量
    var out = {};
    try {
      // 直接查全局（如果暴露了）
      if (typeof MEM_KINDS !== 'undefined') out.MEM_KINDS = MEM_KINDS;
    } catch(e){}
    // 从面板文本解析
    var p = [].slice.call(document.querySelectorAll('.panel')).find(function(x){
      return (x.querySelector('.panel-body')||{}).dataset?.kind === 'neuron';
    });
    if (p) {
      var txt = p.querySelector('.panel-body').innerText || '';
      out.stats = txt.split('·').map(function(s){ return s.trim(); }).filter(Boolean).slice(0, 15);
    }
    return out;
  })()`);
  console.log(JSON.stringify(srcInfo, null, 2).slice(0, 500));

} finally {
  await cdp.close();
}
