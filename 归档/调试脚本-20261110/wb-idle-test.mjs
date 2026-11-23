/**
 * 生命周期管理：闲置 webview 自动销毁
 *
 * 依据：
 *   · Electron 官方性能文档：避免持有不需要的内存
 *   · VS Code 的做法：不活跃的资源要及时释放
 *   · 项目原有 noWarm 只解决"启动不预热"，没解决"用完了不释放"
 *
 * 设计：
 *   · 记录每个 webview 最后一次被"看见"（可见或用户操作）的时间
 *   · 超过 idleMinutes 未活动的，导航到 about:blank 释放其 renderer 进程
 *   · 但不销毁元素本身 —— 下次点开时重新导航即可（保留"点开即用"的部分体验）
 *   · 可配置，默认关闭（不改变现有行为）
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
  console.log(`${C.bold}闲置销毁可行性验证${C.reset}\n`);

  // ---- 1 检查当前 webview 的生命周期能力 ----
  const caps = await cdp.eval(`(function(){
    var wv = document.querySelector('webview');
    if (!wv) return { error: 'no webview' };
    return {
      hasStop: typeof wv.stop === 'function',
      hasReload: typeof wv.reload === 'function',
      hasGetWebContentsId: typeof wv.getWebContentsId === 'function',
      // webview 的销毁方式：从 DOM 移除
      canRemove: true,
    };
  })()`);
  console.log(`  webview 能力: ${JSON.stringify(caps)}`);

  // ---- 2 验证:把 src 设为 about:blank 后,renderer 进程是否真的回收 ----
  console.log(`\n${C.bold}【验证】导航到 about:blank 后进程是否回收${C.reset}`);

  function procCount() {
    try {
      const { execFileSync } = require('node:child_process');
      return Number(execFileSync('powershell', ['-NoProfile', '-Command',
        '(Get-Process -Name electron -ErrorAction SilentlyContinue | Measure-Object).Count'
      ], { encoding: 'utf8', timeout: 20000 }).trim());
    } catch { return null; }
  }
  // ESM 里用 import
  const { execFileSync } = await import('node:child_process');
  const pc = () => {
    try {
      return Number(execFileSync('powershell', ['-NoProfile', '-Command',
        '(Get-Process -Name electron -ErrorAction SilentlyContinue | Measure-Object).Count'
      ], { encoding: 'utf8', timeout: 20000 }).trim());
    } catch { return null; }
  };
  const mem = () => {
    try {
      return Number(execFileSync('powershell', ['-NoProfile', '-Command',
        '$s=0; Get-Process -Name electron -ErrorAction SilentlyContinue | % { $s += $_.PrivateMemorySize64/1MB }; [math]::Round($s)'
      ], { encoding: 'utf8', timeout: 20000 }).trim());
    } catch { return null; }
  };

  const before = { procs: pc(), mem: mem() };
  console.log(`  销毁前: ${before.procs} 个进程, ${before.mem}MB`);

  // 找一个免费 AI 站，导航到空白
  const done = await cdp.eval(`(function(){
    var wvs = [].slice.call(document.querySelectorAll('webview'));
    for (var i = 0; i < wvs.length; i++) {
      var src = wvs[i].getAttribute('src') || '';
      if (/doubao|qianwen|chatglm|kimi/.test(src)) {
        wvs[i].setAttribute('src', 'about:blank');
        return { ok: true, src: src, index: i };
      }
    }
    return { ok: false };
  })()`);
  console.log(`  导航: ${JSON.stringify(done)}`);

  await new Promise(r => setTimeout(r, 20000));

  const after = { procs: pc(), mem: mem() };
  console.log(`  销毁后(20秒): ${after.procs} 个进程, ${after.mem}MB`);
  console.log(`  ${C.bold}差值${C.reset}: 进程 ${(before.procs || 0) - (after.procs || 0)} 个, 内存 ${(before.mem || 0) - (after.mem || 0)}MB`);

  if ((before.mem || 0) - (after.mem || 0) >= 40) {
    console.log(`  ${C.green}✓ 可行：导航到空白确实释放了内存${C.reset}`);
  } else {
    console.log(`  ${C.yellow}! 释放不明显（可能进程复用或尚未回收）${C.reset}`);
  }

  // ---- 3 恢复 ----
  if (done.ok) {
    await cdp.eval(`(function(){
      var wv = document.querySelectorAll('webview')[${done.index}];
      if (wv) wv.setAttribute('src', ${JSON.stringify(done.src)});
      return true;
    })()`);
    console.log(`\n  ${C.dim}已恢复${C.reset}`);
  }

} finally {
  await cdp.close();
}
