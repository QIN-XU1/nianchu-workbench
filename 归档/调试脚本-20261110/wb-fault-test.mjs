/**
 * 故障注入测试 —— 验证容错层真的工作
 *
 * 一个永远通过的测试没有价值。这里主动制造故障：
 *   ① 让一个 webview 加载必然失败的地址 → 应触发 did-fail-load
 *   ② 检查渲染层 fault-bar 是否显示
 *   ③ 检查 server.log 是否记录
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

let pass = 0, total = 0;
function chk(name, ok, detail) {
  total++; if (ok) pass++;
  console.log(`${ok ? C.green + 'PASS' : C.red + 'FAIL'}${C.reset}  ${name}  ${C.dim}${detail}${C.reset}`);
}

console.log(`${C.bold}故障注入测试${C.reset} · ${C.dim}验证容错层真的能捕获并显示${C.reset}\n`);

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();

try {
  // ---------- 1 容错 API 是否就绪 ----------
  const api = await cdp.eval(`(function(){
    return {
      hasOnFault: !!(window.app && window.app.onFault),
      hasShowFault: typeof window.__showFault === 'function',
      hasFaultList: typeof window.__faultList === 'function',
      faultBarExists: !!document.getElementById('fault-bar'),
    };
  })()`);
  chk('preload 暴露 onFault', api.hasOnFault, `hasOnFault=${api.hasOnFault}`);
  chk('渲染层有 show 函数', api.hasShowFault, `__showFault=${api.hasShowFault}`);

  // ---------- 2 主动触发一次故障，看是否显示 ----------
  console.log(`\n${C.bold}【注入故障】${C.reset}`);
  const injectResult = await cdp.eval(`(function(){
    if (typeof window.__showFault !== 'function') return { error: 'no __showFault' };
    window.__showFault('did-fail-load', {
      errorCode: -105,
      errorDescription: 'NAME_NOT_RESOLVED（故障注入测试）',
      url: 'http://this-host-does-not-exist-12345.invalid/',
      mainFrame: true,
    });
    const bar = document.getElementById('fault-bar');
    return {
      barVisible: bar ? bar.style.display : '(无)',
      barText: bar ? bar.textContent.slice(0, 120) : '',
      faultListLen: window.__faultList ? window.__faultList().length : 0,
    };
  })()`);
  chk('故障条已显示', injectResult.barVisible === 'flex', `display=${injectResult.barVisible}`);
  chk('故障条有可读文本', (injectResult.barText || '').includes('加载失败'), `文本="${(injectResult.barText || '').slice(0, 60)}"`);
  chk('故障被记入列表', injectResult.faultListLen > 0, `记录 ${injectResult.faultListLen} 条`);

  // ---------- 3 真实制造一次加载失败（让 webview 加载坏地址）----------
  console.log(`\n${C.bold}【真实故障：让 webview 加载不存在的地址】${C.reset}`);
  const beforeCount = await cdp.eval(`(function(){ return window.__faultList ? window.__faultList().length : 0; })()`);

  const realTry = await cdp.eval(`(function(){
    try {
      const wv = document.querySelector('webview');
      if (!wv) return { error: '无 webview' };
      // 记下原 src，注入坏地址，稍后恢复
      const orig = wv.getAttribute('src');
      wv.setAttribute('src', 'http://this-host-does-not-exist-12345.invalid/');
      return { ok: true, orig: orig };
    } catch (e) { return { error: String(e) }; }
  })()`);

  if (realTry.ok) {
    await new Promise(r => setTimeout(r, 4000));
    const afterCount = await cdp.eval(`(function(){
      return {
        count: window.__faultList ? window.__faultList().length : 0,
        last: window.__faultList ? window.__faultList().slice(-1)[0] : null,
        barVisible: (document.getElementById('fault-bar') || {}).style?.display,
      };
    })()`);
    const grew = afterCount.count > beforeCount;
    chk('真实加载失败被捕获', grew, `故障数 ${beforeCount} → ${afterCount.count}`);
    if (afterCount.last) {
      chk('捕获到的是 did-fail-load', afterCount.last.kind === 'did-fail-load', `kind=${afterCount.last.kind}`);
    }
    // 恢复原地址
    await cdp.eval(`(function(){
      const wv = document.querySelector('webview');
      if (wv) wv.setAttribute('src', ${JSON.stringify(realTry.orig)});
      return true;
    })()`);
    console.log(`  ${C.dim}已恢复 webview 原地址${C.reset}`);
  } else {
    chk('真实加载失败被捕获', false, realTry.error || '无法注入');
  }

  // ---------- 4 server.log 是否有记录 ----------
  console.log(`\n${C.bold}【日志检查】${C.reset}`);
  const { readFileSync, existsSync } = await import('node:fs');
  const logPath = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\server.log`;
  if (existsSync(logPath)) {
    const log = readFileSync(logPath, 'utf8');
    const faultLines = log.split('\n').filter(l => l.includes('[fault]'));
    const hasFailLoad = faultLines.some(l => l.includes('did-fail-load'));
    chk('server.log 记录容错安装', faultLines.length > 0, `${faultLines.length} 条 fault 日志`);
    chk('server.log 记录真实加载失败', hasFailLoad, hasFailLoad ? '有 did-fail-load 记录' : '无（可能注入未生效）');
    if (hasFailLoad) {
      const line = faultLines.find(l => l.includes('did-fail-load'));
      console.log(`  ${C.dim}${line.slice(0, 160)}${C.reset}`);
    }
  } else {
    chk('server.log 记录', false, '日志文件不存在');
  }

} finally {
  await cdp.close();
}

console.log(`\n${C.bold}===== 故障注入测试：${pass}/${total} =====${C.reset}`);
console.log(pass === total
  ? `${C.green}容错层可用：故障能被捕获、显示、记录${C.reset}`
  : `${C.yellow}有项未通过 —— 见上面${C.reset}`);
process.exit(pass === total ? 0 : 1);
