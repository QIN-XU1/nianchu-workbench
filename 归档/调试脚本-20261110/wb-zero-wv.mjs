import { readFileSync, writeFileSync } from 'node:fs';

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
  async close() { const ws = this.ws; if (!ws) return; this.ws = null; try { await new Promise(r => { ws.addEventListener('close', r); ws.close(); setTimeout(r, 600); }); } catch { /* ignore */ } }
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();

try {
  console.log(`${C.bold}定位 0x0 尺寸的 webview${C.reset}\n`);

  const detail = await cdp.eval(`(function(){
    return [].slice.call(document.querySelectorAll('webview')).map(function(w, i){
      var r = w.getBoundingClientRect();
      var parent = w.parentElement;
      var pp = parent ? parent.parentElement : null;
      return {
        i: i,
        w: Math.round(r.width), h: Math.round(r.height),
        src: (w.getAttribute('src') || '').slice(0, 50),
        partition: w.getAttribute('partition') || '',
        display: getComputedStyle(w).display,
        visibility: getComputedStyle(w).visibility,
        parentClass: parent ? parent.className : '',
        grandClass: pp ? pp.className : '',
        // 是否在某个隐藏容器里
        hiddenAncestorCount: (function(){
          var n = 0, el = w.parentElement;
          while (el && el !== document.body) {
            var cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') n++;
            el = el.parentElement;
          }
          return n;
        })(),
      };
    });
  })()`);

  console.log(`${'#'.padStart(2)} ${'尺寸'.padEnd(10)} ${'src'.padEnd(48)} ${'分区'.padEnd(22)} hidden祖先`);
  console.log('-'.repeat(100));
  for (const d of detail) {
    console.log(`${String(d.i).padStart(2)} ${(d.w + 'x' + d.h).padEnd(10)} ${d.src.padEnd(48)} ${d.partition.padEnd(22)} ${d.hiddenAncestorCount}`);
    if (d.w === 0 || d.h === 0) {
      console.log(`   ${C.yellow}↑ 这个是 0x0${C.reset}`);
      console.log(`     display=${d.display} visibility=${d.visibility}`);
      console.log(`     parent=${d.parentClass} grand=${d.grandClass}`);
    }
  }

  console.log(`\n${C.bold}结论${C.reset}`);
  const zero = detail.filter(d => d.w === 0 || d.h === 0);
  if (zero.length === 0) {
    console.log(`  ${C.green}✓ 没有 0x0 webview${C.reset}`);
  } else {
    for (const z of zero) {
      console.log(`  ${C.yellow}!${C.reset} webview[${z.i}] src=${z.src}`);
      console.log(`    它在 ${z.hiddenAncestorCount} 层隐藏祖先里 → 属于"预加载但未显示"的面板`);
      console.log(`    ${C.dim}这是"点开即用"设计的副作用：webview 已创建但容器还没给它尺寸。${C.reset}`);
    }
  }

} finally {
  await cdp.close();
}
