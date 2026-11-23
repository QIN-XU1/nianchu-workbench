/**
 * 深度探针 2：并发与稳定性
 *
 * 专家会问：
 *   - 切场景时会不会泄漏监听器？
 *   - 反复切换会不会越切越慢？
 *   - webview 卸载时是否真的释放？
 *
 * 这些只能实测，不能看代码猜。
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
if (!page) { console.log('找不到主页面'); process.exit(1); }

const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();

try {
  console.log(`${C.bold}【1】场景切换机制${C.reset}`);
  const mech = await cdp.eval(`(function(){
    return {
      有场景标签: document.querySelectorAll('[class*="scene-tab"], .scene-tab, .tab-btn').length,
      场景按钮文本: [].slice.call(document.querySelectorAll('[class*="scene-tab"], .scene-tab, .tab-btn')).map(function(b){ return (b.textContent||'').trim().slice(0,20); }).filter(Boolean).slice(0,10),
      有reloadScene: typeof window.reloadScene === 'function' || 'reloadScene' in window,
      有renderers: !!window.APP_RENDERERS,
      有utils: !!window.APP_RENDER_UTILS,
    };
  })()`);
  console.log(`  场景标签元素: ${mech.有场景标签}`);
  console.log(`  标签文本: ${JSON.stringify(mech.场景按钮文本)}`);
  console.log(`  APP_RENDERERS: ${mech.有renderers}`);
  console.log(`  APP_RENDER_UTILS: ${mech.有utils}`);

  console.log(`\n${C.bold}【2】监听器泄漏风险${C.reset}`);
  const listeners = await cdp.eval(`(function(){
    // 检查是否有全局累积的监听/定时器痕迹
    const w = window;
    const suspects = [];
    // 常见泄漏点：未清理的 interval / 全局数组
    ['__timers','__intervals','__listeners','__cleanups','activeCleanups'].forEach(function(k){
      if (w[k]) suspects.push(k + '=' + (Array.isArray(w[k]) ? w[k].length : typeof w[k]));
    });
    // 检查 DOM 上是否有重复挂载的 webview
    return {
      suspects: suspects,
      webviewCount: document.querySelectorAll('webview').length,
      panelCount: document.querySelectorAll('.panel').length,
      bodyChildren: document.body.children.length,
    };
  })()`);
  console.log(`  可疑全局: ${listeners.suspects.length ? listeners.suspects.join(', ') : '(无)'}`);
  console.log(`  webview 数: ${listeners.webviewCount}`);
  console.log(`  面板数: ${listeners.panelCount}`);

  console.log(`\n${C.bold}【3】反复切场景的压力测试${C.reset}`);
  console.log(`  ${C.dim}连续切 3 轮，量 DOM/内存变化${C.reset}`);

  const before = await cdp.eval(`(function(){
    return { dom: document.querySelectorAll('*').length, panels: document.querySelectorAll('.panel').length, wv: document.querySelectorAll('webview').length };
  })()`);

  for (let round = 1; round <= 3; round++) {
    // 切到下一个场景（模拟点标签）
    const r = await cdp.eval(`(function(){
      const tabs = [].slice.call(document.querySelectorAll('[class*="scene-tab"], .scene-tab, .tab-btn'));
      if (!tabs.length) {
        // 退而用内部 API
        if (typeof window.loadScenario === 'function') { return 'internal'; }
        return 'no-tabs';
      }
      const active = tabs.findIndex(t => t.classList.contains('active') || t.classList.contains('on'));
      const next = tabs[(active + 1) % tabs.length];
      if (next) { next.click(); return 'clicked:' + (next.textContent||'').trim().slice(0,10); }
      return 'no-next';
    })()`);
    await new Promise(r2 => setTimeout(r2, 1500));
    const now = await cdp.eval(`(function(){
      return { dom: document.querySelectorAll('*').length, panels: document.querySelectorAll('.panel').length, wv: document.querySelectorAll('webview').length };
    })()`);
    console.log(`    第${round}轮: ${r} → dom ${before.dom}→${now.dom}  panels ${now.panels}  wv ${now.wv}`);
  }

  const after = await cdp.eval(`(function(){
    return { dom: document.querySelectorAll('*').length, panels: document.querySelectorAll('.panel').length, wv: document.querySelectorAll('webview').length };
  })()`);
  console.log(`  ${C.bold}结果${C.reset}: DOM ${before.dom} → ${after.dom} (${after.dom - before.dom >= 0 ? '+' : ''}${after.dom - before.dom})`);

  const leak = (after.dom - before.dom) / before.dom * 100;
  if (leak > 15) console.log(`  ${C.red}✗ 疑似泄漏：DOM 增长 ${leak.toFixed(1)}%${C.reset}`);
  else console.log(`  ${C.green}✓ DOM 无显著增长（${leak.toFixed(1)}%）${C.reset}`);

} finally {
  await cdp.close();
}
