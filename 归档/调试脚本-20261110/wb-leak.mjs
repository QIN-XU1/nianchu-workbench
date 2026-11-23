/**
 * 累积泄漏验证：连续切 6 次，看 webview 与内存是否持续增长
 *
 * 如果每切一次就多一个 webview，那是明确的泄漏。
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
  async close() { const ws = this.ws; if (!ws) return; this.ws = null; try { await new Promise(r => { ws.addEventListener('close', r); ws.close(); setTimeout(r, 600); }); } catch { /* ignore */ } }
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();

const snap = () => cdp.eval(`(function(){
  var heap = performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : null;
  return {
    wv: document.querySelectorAll('webview').length,
    zeroWv: [].slice.call(document.querySelectorAll('webview')).filter(function(w){
      var r = w.getBoundingClientRect(); return r.width === 0 || r.height === 0;
    }).length,
    dom: document.querySelectorAll('*').length,
    heap: heap,
    panels: document.querySelectorAll('.panel').length,
  };
})()`);

try {
  const scenes = await cdp.eval(`(async function(){ try { return await window.app.listScenarios(); } catch(e) { return []; } })()`);
  const ids = scenes.map(s => s.id);
  console.log(`${C.bold}累积泄漏测试${C.reset} · ${C.dim}连续切 6 次${C.reset}\n`);
  console.log(`场景: ${ids.join(' → ')}\n`);

  const base = await snap();
  console.log(`起点: webview=${base.wv} (0x0 ${base.zeroWv}) 面板=${base.panels} DOM=${base.dom} 堆=${base.heap}MB`);

  const rows = [];
  for (let i = 0; i < 6; i++) {
    const id = ids[i % ids.length];
    await cdp.eval(`(async function(){ try { await window.loadScenario(${JSON.stringify(id)}); } catch(e){} })()`);
    await new Promise(r => setTimeout(r, 2500));
    const s = await snap();
    const dwv = s.wv - base.wv;
    rows.push({ i: i + 1, scene: id, ...s, dwv });
    const flag = dwv > 0 ? C.red + `(+${dwv})` + C.reset : C.green + '(+0)' + C.reset;
    console.log(`  第${i + 1}次 → ${id.padEnd(14)} webview=${s.wv} ${flag}  0x0=${s.zeroWv}  DOM=${s.dom}  堆=${s.heap}MB`);
  }

  console.log(`\n${C.bold}结论${C.reset}`);
  const last = rows[rows.length - 1];
  const wvGrowth = last.wv - base.wv;
  const heapGrowth = (last.heap || 0) - (base.heap || 0);

  if (wvGrowth > 0) {
    console.log(`  ${C.red}✗ 泄漏确认：切 6 次后 webview 增加 ${wvGrowth} 个${C.reset}`);
    console.log(`     ${C.dim}每切一次场景，旧的 harness webview 没有被销毁${C.reset}`);
  } else {
    console.log(`  ${C.green}✓ 无 webview 泄漏${C.reset}`);
  }
  if (heapGrowth > 5) {
    console.log(`  ${C.yellow}! JS 堆增长 ${heapGrowth}MB${C.reset}`);
  } else {
    console.log(`  ${C.green}✓ JS 堆无明显增长（${heapGrowth}MB）${C.reset}`);
  }

  const { writeFileSync } = await import('node:fs');
  writeFileSync(String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\wb-leak-report.json`,
    JSON.stringify({ at: new Date().toISOString(), base, rows, wvGrowth, heapGrowth }, null, 2), 'utf8');
  console.log(`\n${C.dim}报告已落盘${C.reset}`);

} finally {
  await cdp.close();
}
