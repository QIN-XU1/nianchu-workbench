/**
 * 工作台运行时探针（通过 CDP 真实测量）
 *
 * 这是"深度"的关键：不看代码猜，而是连上真实运行的界面量数据。
 */

const CDP_PORT = 9333;
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) });
  return r.json();
}

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.ws = null; this.nextId = 1; this.pending = new Map(); }
  async connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('连接超时')), 5000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接失败')); });
      ws.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) {
          const { resolve: r, reject: j } = this.pending.get(m.id);
          this.pending.delete(m.id);
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')); } }, 20000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
  async close() {
    const ws = this.ws; if (!ws) return; this.ws = null;
    try { await new Promise((res) => { ws.addEventListener('close', res); ws.close(); setTimeout(res, 800); }); } catch { /* ignore */ }
  }
}

async function main() {
  console.log(`${C.bold}工作台运行时探针${C.reset} · ${C.dim}CDP :${CDP_PORT}${C.reset}\n`);

  const targets = await listTargets();
  const page = targets.find(t => t.type === 'page' && t.url.startsWith('file://'));
  if (!page) {
    console.log(`${C.red}找不到主页面 target${C.reset}`);
    process.exit(1);
  }

  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect();

  try {
    // ---------- 1 界面骨架 ----------
    const skeleton = await cdp.eval(`(function(){
      const out = {};
      out.title = document.title;
      out.grid = document.getElementById('grid') ? {
        panels: document.getElementById('grid').children.length,
        cols: document.getElementById('grid').style.gridTemplateColumns || '(默认)',
      } : null;
      out.panels = [].slice.call(document.querySelectorAll('.panel')).map(function(p){
        const r = p.getBoundingClientRect();
        return {
          id: p.dataset.panelId,
          kind: (p.querySelector('.panel-body')||{}).dataset?.kind,
          w: Math.round(r.width), h: Math.round(r.height),
          title: (p.querySelector('.panel-title')||{}).textContent,
        };
      });
      out.webviews = [].slice.call(document.querySelectorAll('webview')).map(function(w){
        const r = w.getBoundingClientRect();
        return { src: (w.getAttribute('src')||'').slice(0,50), w: Math.round(r.width), h: Math.round(r.height) };
      });
      out.sceneTabs = [].slice.call(document.querySelectorAll('[class*="scene-tab"], .tab, [data-scene]')).length;
      return out;
    })()`);

    console.log(`${C.bold}【界面骨架】${C.reset}`);
    console.log(`  标题: ${skeleton.title}`);
    console.log(`  网格面板数: ${skeleton.grid ? skeleton.grid.panels : '?'}`);
    console.log(`  面板明细: ${skeleton.panels.length} 个`);
    for (const p of skeleton.panels) {
      console.log(`    ${String(p.id).padEnd(16)} kind=${String(p.kind).padEnd(14)} ${p.w}x${p.h}  ${p.title || ''}`);
    }
    console.log(`  webview: ${skeleton.webviews.length} 个`);
    for (const w of skeleton.webviews) {
      console.log(`    ${w.w}x${w.h}  ${w.src}`);
    }

    // ---------- 2 面板尺寸是否异常 ----------
    console.log(`\n${C.bold}【布局健康度】${C.reset}`);
    const bad = skeleton.panels.filter(p => p.w < 100 || p.h < 80);
    if (bad.length === 0) {
      console.log(`  ${C.green}✓${C.reset} 没有过小的面板（阈值 100x80）`);
    } else {
      for (const p of bad) console.log(`  ${C.yellow}!${C.reset} ${p.id} 只有 ${p.w}x${p.h}`);
    }

    // ---------- 3 已注册的渲染器 vs 可见 ----------
    const regInfo = await cdp.eval(`(function(){
      try {
        return {
          count: Object.keys(window.APP_RENDERERS || {}).length,
          keys: Object.keys(window.APP_RENDERERS || {}),
        };
      } catch (e) { return { error: String(e) }; }
    })()`);
    console.log(`\n${C.bold}【渲染器注册】${C.reset}`);
    console.log(`  window.APP_RENDERERS: ${regInfo.count} 种`);
    if (regInfo.keys) console.log(`  ${C.dim}${regInfo.keys.join(', ')}${C.reset}`);

    // ---------- 4 错误与警告 ----------
    console.log(`\n${C.bold}【运行时报错】${C.reset}`);
    const errors = await cdp.eval(`(function(){
      // 从 console 拿不到历史，改看 DOM 上有没有 init-error / 未知类型提示
      const out = [];
      [].slice.call(document.querySelectorAll('.init-error')).forEach(function(e){ out.push('init-error: ' + e.textContent.slice(0,100)); });
      [].slice.call(document.querySelectorAll('.stat-sub')).forEach(function(e){
        const t = e.textContent || '';
        if (/未知|失败|出错/.test(t)) out.push(t.slice(0,100));
      });
      return out;
    })()`);
    if (errors.length === 0) console.log(`  ${C.green}✓${C.reset} 界面上没有错误提示`);
    else for (const e of errors) console.log(`  ${C.red}✗${C.reset} ${e}`);

    // ---------- 5 性能：面板渲染耗时 ----------
    console.log(`\n${C.bold}【内存与性能】${C.reset}`);
    const perf = await cdp.eval(`(function(){
      const nav = performance.getEntriesByType('navigation')[0] || {};
      return {
        domNodes: document.querySelectorAll('*').length,
        loadMs: Math.round(nav.duration || 0),
        jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : null,
      };
    })()`);
    console.log(`  DOM 节点: ${perf.domNodes}`);
    console.log(`  加载耗时: ${perf.loadMs}ms`);
    if (perf.jsHeapMB) console.log(`  JS 堆: ${perf.jsHeapMB}MB`);

  } finally {
    await cdp.close();
  }
}

await main();
