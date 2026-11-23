/**
 * 深入测量：内存去向与 0x0 面板
 *
 * 问题：主进程占 2348MB，但界面 JS 堆只 10MB。钱花在哪了？
 */

const CDP_PORT = 9333;
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.ws = null; this.nextId = 1; this.pending = new Map(); }
  async connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl); this.ws = ws;
      const t = setTimeout(() => reject(new Error('超时')), 5000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('失败')); });
      ws.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) {
          const { resolve: r, reject: j } = this.pending.get(m.id); this.pending.delete(m.id);
          if (m.error) j(new Error(m.error.message)); else r(m.result);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')); } }, 15000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result?.value;
  }
  async close() { const ws = this.ws; if (!ws) return; this.ws = null; try { await new Promise(r => { ws.addEventListener('close', r); ws.close(); setTimeout(r, 600); }); } catch {} }
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();

console.log(`${C.bold}每个 target 的内存与状态${C.reset}\n`);
console.log(`${'类型'.padEnd(14)} ${'标题/URL'.padEnd(48)} ${'内存MB'.padStart(8)} ${'状态'}`);
console.log('-'.repeat(90));

const rows = [];
for (const t of targets) {
  if (!t.webSocketDebuggerUrl) continue;
  const c = new CDP(t.webSocketDebuggerUrl);
  let mem = null, extra = '';
  try {
    await c.connect();
    await c.send('Runtime.enable', {});
    // 用 Performance.getMetrics 拿真实堆
    const m = await c.send('Performance.enable', {}).catch(() => null);
    const metrics = await c.send('Performance.getMetrics', {}).catch(() => null);
    if (metrics && metrics.metrics) {
      const used = metrics.metrics.find(x => x.name === 'JSHeapUsedSize');
      if (used) mem = Math.round(used.value / 1048576);
    }
    // 额外信息
    if (t.type === 'webview' || t.type === 'page') {
      const info = await c.eval(`(function(){
        return {
          visibility: document.visibilityState,
          hidden: document.hidden,
          domNodes: document.querySelectorAll('*').length,
          hasVideo: document.querySelectorAll('video').length,
          iframes: document.querySelectorAll('iframe').length,
        };
      })()`).catch(() => null);
      if (info) extra = `dom=${info.domNodes} 视频=${info.hasVideo} iframe=${info.iframes} ${info.visibility}`;
    }
  } catch (e) { extra = 'ERR ' + e.message.slice(0, 20); }
  finally { await c.close(); }

  const label = t.type === 'page' ? 'PAGE(主界面)' : (t.type === 'webview' ? 'WEBVIEW' : t.type);
  const title = (t.title || t.url || '').slice(0, 46);
  rows.push({ type: label, title, mem, extra, url: t.url });
  console.log(`${label.padEnd(14)} ${title.padEnd(48)} ${String(mem ?? '?').padStart(8)} ${extra}`);
}

console.log('');
const sum = rows.reduce((a, b) => a + (b.mem || 0), 0);
console.log(`${C.bold}各 target JS 堆合计: ${sum}MB${C.reset}`);
console.log(`${C.dim}（注意：Electron 每个渲染进程还有 V8 之外的图形内存、DOM 内存，所以总 RSS 会远大于此）${C.reset}`);

// 找出"预加载但不可见"的 webview
console.log('');
console.log(`${C.bold}预加载分析${C.reset}`);
const webviews = rows.filter(r => r.type === 'WEBVIEW');
const aiSites = webviews.filter(r => /doubao|qianwen|chatglm|kimi|deepseek/.test(r.url || ''));
console.log(`  webview 共 ${webviews.length} 个，其中免费 AI 站 ${aiSites.length} 个`);
for (const a of aiSites) {
  const host = (() => { try { return new URL(a.url).hostname; } catch { return a.url; } })();
  console.log(`    ${host.padEnd(24)} JS堆=${a.mem}MB  ${a.extra}`);
}
console.log(`\n  ${C.yellow}这 ${aiSites.length} 个站即使在没点开时也占着 webContents —— 这就是"点开即用"的代价。${C.reset}`);
