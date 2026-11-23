/**
 * 关键实验：销毁 webview 元素（从 DOM 移除）能否真正释放 renderer 进程
 *
 * 上一轮发现：导航到 about:blank 只释放 28MB，进程数不变。
 * 说明 renderer 进程绑在 webview 元素上，元素不销毁进程就不走。
 *
 * 本实验：真的把 webview 从 DOM 移除，看进程数和内存。
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
    return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error(method + ' 超时')); } }, 30000); });
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 错误');
    return r.result?.value;
  }
  async close() { const ws = this.ws; if (!ws) return; this.ws = null; try { await new Promise(r => { ws.addEventListener('close', r); ws.close(); setTimeout(r, 500); }); } catch { /* ignore */ } }
}

const { execFileSync } = await import('node:child_process');
const pc = () => { try { return Number(execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Process -Name electron -ErrorAction SilentlyContinue | Measure-Object).Count'], { encoding: 'utf8', timeout: 20000 }).trim()); } catch { return null; } };
const mem = () => { try { return Number(execFileSync('powershell', ['-NoProfile', '-Command', '$s=0; Get-Process -Name electron -ErrorAction SilentlyContinue | % { $s += $_.PrivateMemorySize64/1MB }; [math]::Round($s)'], { encoding: 'utf8', timeout: 20000 }).trim()); } catch { return null; } };

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();

try {
  console.log(`${C.bold}销毁 webview 元素 · 能否真正释放进程${C.reset}\n`);

  const before = { procs: pc(), mem: mem() };
  const list0 = await cdp.eval(`document.querySelectorAll('webview').length`);
  console.log(`【销毁前】${before.procs} 个进程 · ${before.mem}MB · ${list0} 个 webview`);

  // ---- 找到免费 AI 站的 webview，记录其容器结构，然后移除 ----
  const target = await cdp.eval(`(function(){
    var wvs = [].slice.call(document.querySelectorAll('webview'));
    for (var i = 0; i < wvs.length; i++) {
      var src = wvs[i].getAttribute('src') || '';
      if (/doubao|qianwen|chatglm|kimi/.test(src)) {
        var wv = wvs[i];
        var parent = wv.parentElement;
        var grand = parent ? parent.parentElement : null;
        // 记录关键信息以便恢复
        var info = {
          src: src,
          index: i,
          parentTag: parent ? parent.tagName : '',
          parentCls: parent ? parent.className : '',
          grandTag: grand ? grand.tagName : '',
          grandCls: grand ? grand.className : '',
          parentId: parent ? parent.id : '',
          // 记住它在父节点中的位置
          siblingIndex: parent ? Array.prototype.indexOf.call(parent.parentElement.children, parent) : -1,
        };
        window.__destroyedWebview = info;
        // 真的移除（移除父容器，因为 webview 通常需要容器）
        if (parent) { parent.remove(); }
        else { wv.remove(); }
        return { ok: true, info: info };
      }
    }
    return { ok: false };
  })()`);
  console.log(`\n【操作】移除 webview 及其容器`);
  console.log(`  ${JSON.stringify(target.info)}`);

  // ---- 等待进程回收 ----
  for (const wait of [10, 20, 30]) {
    await new Promise(r => setTimeout(r, wait * 1000));
    const now = { procs: pc(), mem: mem() };
    const listNow = await cdp.eval(`document.querySelectorAll('webview').length`).catch(() => -1);
    console.log(`  T+${wait}s: ${now.procs} 个进程 · ${now.mem}MB · ${listNow} 个 webview`);
    if (now.procs !== null && before.procs !== null && now.procs < before.procs) {
      console.log(`  ${C.green}✓ 进程数已减少：${before.procs} → ${now.procs}${C.reset}`);
    }
  }

  const after = { procs: pc(), mem: mem() };
  console.log(`\n${C.bold}【结果】${C.reset}`);
  console.log(`  进程: ${before.procs} → ${after.procs}  (${(before.procs || 0) - (after.procs || 0) >= 0 ? '释放 ' : '增加 '}${Math.abs((before.procs || 0) - (after.procs || 0))} 个)`);
  console.log(`  内存: ${before.mem}MB → ${after.mem}MB  (释放 ${(before.mem || 0) - (after.mem || 0)}MB)`);

  const freedProcs = (before.procs || 0) - (after.procs || 0);
  const freedMB = (before.mem || 0) - (after.mem || 0);

  if (freedProcs > 0 && freedMB > 50) {
    console.log(`\n  ${C.green}✓ 结论：销毁元素能真正释放进程（${freedProcs} 个进程，${freedMB}MB）${C.reset}`);
    console.log(`  ${C.dim}⇒ "闲置销毁"应该销毁元素，而不是只导航到 about:blank${C.reset}`);
  } else if (freedMB > 30) {
    console.log(`\n  ${C.yellow}~ 部分释放（${freedMB}MB），但进程未减少${C.reset}`);
    console.log(`  ${C.dim}⇒ Electron 可能缓存了 renderer 进程池${C.reset}`);
  } else {
    console.log(`\n  ${C.red}✗ 没有释放 —— 进程仍占着${C.reset}`);
  }

  // ---- 恢复：重建 webview ----
  console.log(`\n${C.bold}【恢复】${C.reset}`);
  const restored = await cdp.eval(`(function(){
    var info = window.__destroyedWebview;
    if (!info) return { error: 'no info' };
    // 用顶栏按钮重新打开该站（走项目自己的逻辑）
    var btns = [].slice.call(document.querySelectorAll('.webai-btn'));
    var target = btns.filter(function(b){
      var t = (b.getAttribute('title') || '');
      var src = info.src;
      if (/doubao/i.test(src) && /豆包/.test(t)) return true;
      if (/qianwen/i.test(src) && /通义|千问/.test(t)) return true;
      if (/chatglm/i.test(src) && /智谱/.test(t)) return true;
      if (/kimi/i.test(src) && /Kimi/i.test(t)) return true;
      return false;
    })[0];
    if (target) { target.click(); return { ok: true, btn: (target.getAttribute('title')||'').slice(0,20) }; }
    return { ok: false, reason: 'no matching button' };
  })()`);
  console.log(`  ${JSON.stringify(restored)}`);

  await new Promise(r => setTimeout(r, 8000));
  const final = { procs: pc(), mem: mem() };
  const listFinal = await cdp.eval(`document.querySelectorAll('webview').length`).catch(() => -1);
  console.log(`  恢复后: ${final.procs} 个进程 · ${final.mem}MB · ${listFinal} 个 webview`);

  const { writeFileSync } = await import('node:fs');
  writeFileSync(String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\wb-destroy-report.json`, JSON.stringify({
    at: new Date().toISOString(), before, after, freedProcs, freedMB,
    targetInfo: target.info, restoredOk: restored.ok,
  }, null, 2), 'utf8');

} finally {
  await cdp.close();
}
