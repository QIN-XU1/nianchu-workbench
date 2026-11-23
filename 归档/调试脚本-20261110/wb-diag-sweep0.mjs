/**
 * 精确诊断 sweep 为什么销毁 0 个
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
  console.log(`${C.bold}sweep 为什么销毁 0 个 —— 逐条追踪${C.reset}\n`);

  // 1 看 GC 内部状态
  const st = await cdp.eval(`(function(){
    var st = window.__webaiIdleGC;
    return {
      enabled: st.enabled,
      idleMinutes: st.idleMinutes,
      lastSeenKeys: Object.keys(st.lastSeen || {}),
      lastSeenValues: (function(){
        var o = {};
        Object.keys(st.lastSeen || {}).forEach(function(k){
          o[k] = { ageMin: Math.round((Date.now() - st.lastSeen[k]) / 60000) };
        });
        return o;
      })(),
      destroyedCount: (st.destroyed || []).length,
    };
  })()`);
  console.log(`  enabled: ${st.enabled}`);
  console.log(`  idleMinutes: ${st.idleMinutes}`);
  console.log(`  lastSeen 键: ${JSON.stringify(st.lastSeenKeys)}`);
  console.log(`  lastSeen 时间: ${JSON.stringify(st.lastSeenValues)}`);

  // 2 逐个 webview 追踪判断过程
  const trace = await cdp.eval(`(function(){
    var out = [];
    var wvs = [].slice.call(document.querySelectorAll('webview'));
    wvs.forEach(function(wv, i){
      var src = wv.getAttribute('src') || '';
      var part = wv.getAttribute('partition') || '';
      var isAi = /doubao|qianwen|chatglm|kimi|deepseek/i.test(src);
      // 复现 isActive 判断
      var active = (function(){
        try {
          var p = wv.parentElement;
          while (p && p !== document.body) {
            var cs = getComputedStyle(p);
            if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') === 0) return false;
            p = p.parentElement;
          }
          var r = wv.getBoundingClientRect();
          if (r.width < 50 || r.height < 50) return false;
          return true;
        } catch(e) { return true; }
      })();
      var key = part || src;
      var last = (window.__webaiIdleGC.lastSeen || {})[key] || 0;
      out.push({
        i: i,
        src: src.slice(0, 40),
        isAi: isAi,
        isActive: active,
        key: key.slice(0, 30),
        lastSeenAgoMin: last ? Math.round((Date.now() - last) / 60000) : null,
        wouldDestroy: isAi && !active && last > 0 && (Date.now() - last) >= window.__webaiIdleGC.idleMinutes * 60000,
      });
    });
    return out;
  })()`);

  console.log(`\n  逐个 webview 判断:`);
  for (const t of trace) {
    const flag = t.wouldDestroy ? C.red + '会销毁' + C.reset : C.dim + '保留' + C.reset;
    console.log(`    [${t.i}] AI=${t.isAi ? 'Y' : 'N'} active=${t.isActive ? 'Y' : 'N'} idle=${t.lastSeenAgoMin === null ? '未记录' : t.lastSeenAgoMin + '分'} ${flag}  ${t.src}`);
  }

  console.log(`\n${C.bold}诊断结论${C.reset}`);
  const aiActive = trace.filter(t => t.isAi && t.isActive);
  const aiInactive = trace.filter(t => t.isAi && !t.isActive);
  console.log(`  AI 站中：活跃 ${aiActive.length} 个，不活跃 ${aiInactive.length} 个`);

  if (aiActive.length > 0) {
    console.log(`  ${C.red}✗ 问题所在：${aiActive.length} 个 AI 站被判定为"活跃"，所以不销毁${C.reset}`);
    console.log(`     原因：预热后窗口是 .webai-win warm（opacity:0 但 display 仍为 flex），`);
    console.log(`     isActive 只检查 display/visibility，没检查 opacity ⇒ 误判为可见`);
  }

} finally {
  await cdp.close();
}
