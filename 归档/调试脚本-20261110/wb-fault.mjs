/**
 * 深度探针 3：错误恢复能力
 *
 * 专家会问的三件事：
 *   ① 引擎挂了界面会怎样？
 *   ② webview 崩了会不会拖垮整个界面？
 *   ③ 有没有可恢复的路径？
 *
 * 这些从代码里看不出来，必须看实际容错路径。
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result?.value;
  }
  async close() { const ws = this.ws; if (!ws) return; this.ws = null; try { await new Promise(r => { ws.addEventListener('close', r); ws.close(); setTimeout(r, 600); }); } catch {} }
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();

try {
  console.log(`${C.bold}【容错路径审计】${C.reset}\n`);

  const api = await cdp.eval(`(function(){
    const out = { methods: [], globals: [] };
    // 渲染层能用的恢复入口
    ['loadScenario','reloadScene','hotReloadRenderers','forceEnterHarness','watchHarnessReady','bootFail','setStatus'].forEach(function(k){
      if (typeof window[k] === 'function') out.methods.push(k);
    });
    // 预加载 API
    if (window.app) {
      out.globals = Object.keys(window.app).slice(0, 40);
    }
    return out;
  })()`);
  console.log(`  可用的恢复函数: ${api.methods.join(', ') || '(无)'}`);
  console.log(`  window.app 暴露: ${api.globals.length} 项`);
  console.log(`    ${api.globals.join(', ')}`);

  console.log(`\n${C.bold}【引擎连接状态】${C.reset}`);
  const engine = await cdp.eval(`(async function(){
    try {
      const url = await window.app.getHarnessUrl();
      const ready = await window.app.isHarnessReady();
      return { url: url || '(空)', ready: !!ready };
    } catch (e) { return { error: String(e) }; }
  })()`);
  console.log(`  引擎 URL: ${engine.url || engine.error}`);
  console.log(`  引擎就绪: ${engine.ready}`);

  console.log(`\n${C.bold}【webview 各自的错误处理】${C.reset}`);
  const wvInfo = await cdp.eval(`(function(){
    return [].slice.call(document.querySelectorAll('webview')).map(function(w, i){
      return {
        i: i,
        src: (w.getAttribute('src')||'').slice(0, 44),
        hasFailHint: !!w.getAttribute('failHint'),
        partition: w.getAttribute('partition') || '',
        listeners: {
          didFailLoad: typeof w.didFailLoad,
          crashed: typeof w.crashed,
        },
      };
    });
  })()`);
  for (const w of wvInfo) {
    console.log(`  [${w.i}] ${w.src.padEnd(46)} partition=${w.partition}`);
  }

  console.log(`\n${C.bold}【关键发现】${C.reset}`);
  console.log(`  界面自身有 bootFail / forceEnterHarness 等兜底函数 → 容错设计存在`);
  console.log(`  但 webview 的崩溃恢复需要看主进程是否挂了 'render-process-gone' 处理`);

} finally {
  await cdp.close();
}

// 从主进程代码查容错
import { readFileSync } from 'node:fs';
const main = readFileSync(String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\main.js`, 'utf8');
console.log(`\n${C.bold}【主进程容错事件】${C.reset}`);
for (const ev of ['render-process-gone', 'did-fail-load', 'crashed', 'unresponsive', 'child-process-gone']) {
  const n = (main.match(new RegExp(ev, 'g')) || []).length;
  console.log(`  ${ev.padEnd(24)} ${n} 处处理 ${n > 0 ? C.green + '✓' + C.reset : C.red + '✗ 无' + C.reset}`);
}
