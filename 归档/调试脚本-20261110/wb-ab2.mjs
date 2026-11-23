/**
 * 重做 A/B 实验（这次量准）
 *
 * 上一版 A/B 的缺陷：
 *   ① 只等 6 秒 —— renderer 进程还没回收完
 *   ② 只看了 GPU 侧差额，没看 renderer 进程
 *   ③ 结论"只省 52MB"是错的
 *
 * 对比证据：
 *   · 刚启动（AI 站已加载）：11 个 renderer，私有 1001MB
 *   · 上一版 A/B 后（AI 站 about:blank）：11 个 renderer，私有 500MB
 *   ⇒ 真实差 ~500MB，不是 52MB
 *
 * 本版：
 *   ① 等 30 秒让进程回收
 *   ② 量 renderer 进程数与总私有内存
 *   ③ 对比 GPU / 主进程 / 渲染三类
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

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
  async close() { const ws = this.ws; if (!ws) return; this.ws = null; try { await new Promise(r => { ws.addEventListener('close', r); ws.close(); setTimeout(r, 500); }); } catch { /* ignore */ } }
}

function measure() {
  const script = `
$procs = Get-Process -Name electron -ErrorAction SilentlyContinue
$out = @()
foreach ($p in $procs) {
  $out += [PSCustomObject]@{
    id = $p.Id
    privMB = [math]::Round($p.PrivateMemorySize64/1MB)
    wsMB = [math]::Round($p.WorkingSet64/1MB)
    threads = $p.Threads.Count
    hasWindow = ($p.MainWindowTitle -ne '')
  }
}
$out | ConvertTo-Json -Compress
`;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 25000 }).trim();
    const arr = JSON.parse(out || '[]');
    return Array.isArray(arr) ? arr : [arr];
  } catch { return []; }
}

function classify(procs) {
  const gpu = procs.filter(p => p.privMB > 250 && !p.hasWindow);
  const main = procs.filter(p => !gpu.includes(p) && (p.hasWindow || p.threads >= 34));
  const render = procs.filter(p => !gpu.includes(p) && !main.includes(p));
  const sum = a => a.reduce((x, y) => x + (y.privMB || 0), 0);
  return {
    count: procs.length,
    total: sum(procs),
    gpu: { n: gpu.length, mb: sum(gpu) },
    main: { n: main.length, mb: sum(main) },
    render: { n: render.length, mb: sum(render), perMB: render.length ? Math.round(sum(render) / render.length) : 0 },
    procs,
  };
}

function show(label, m) {
  console.log(`\n${C.bold}${label}${C.reset}`);
  console.log(`  进程 ${m.count} 个 · 私有 ${m.total}MB`);
  console.log(`  GPU ${m.gpu.n}个/${m.gpu.mb}MB · 主 ${m.main.n}个/${m.main.mb}MB · 渲染 ${m.render.n}个/${m.render.mb}MB（每个约 ${m.render.perMB}MB）`);
}

const targets0 = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets0.find(t => t.type === 'page');
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();

try {
  console.log(`${C.bold}重做 A/B：关闭 4 个免费 AI 站（量准版）${C.reset}`);

  // ===== 基线：AI 站已加载 =====
  const before = classify(measure());
  show('【A】AI 站已加载（基线）', before);

  const wvList = await cdp.eval(`(function(){
    return [].slice.call(document.querySelectorAll('webview')).map(function(w){
      var src = w.getAttribute('src') || '';
      return { src: src, isAi: /doubao|qianwen|chatglm|kimi/.test(src) };
    });
  })()`);
  console.log(`  webview: ${wvList.length} 个，其中 AI 站 ${wvList.filter(w => w.isAi).length} 个`);

  // ===== 操作：把 AI 站导航到 about:blank =====
  console.log(`\n${C.bold}【操作】把 AI 站导航到 about:blank${C.reset}`);
  const done = await cdp.eval(`(function(){
    var wvs = [].slice.call(document.querySelectorAll('webview'));
    var n = 0;
    wvs.forEach(function(w){
      var src = w.getAttribute('src') || '';
      if (/doubao|qianwen|chatglm|kimi/.test(src)) {
        try { w.setAttribute('src', 'about:blank'); n++; } catch(e){}
      }
    });
    return n;
  })()`);
  console.log(`  已导航 ${done} 个`);

  // ===== 等 30 秒让进程回收 =====
  console.log(`\n${C.dim}等待 30 秒，让 renderer 进程回收…${C.reset}`);
  await new Promise(r => setTimeout(r, 30000));

  const after = classify(measure());
  show('【B】AI 站已关闭（30 秒后）', after);

  // ===== 差值 =====
  console.log(`\n${C.bold}【C】差值${C.reset}`);
  const dTotal = before.total - after.total;
  const dGpu = before.gpu.mb - after.gpu.mb;
  const dRender = before.render.mb - after.render.mb;
  const dRn = before.render.n - after.render.n;

  console.log(`  私有总计: ${before.total} → ${after.total}  ${C.green}省 ${dTotal}MB${C.reset}`);
  console.log(`  GPU      : ${before.gpu.mb} → ${after.gpu.mb}  省 ${dGpu}MB`);
  console.log(`  渲染     : ${before.render.mb} → ${after.render.mb}  省 ${dRender}MB（进程 ${before.render.n} → ${after.render.n}）`);

  // ===== 判定 =====
  console.log(`\n${C.bold}【D】判定${C.reset}`);
  if (dTotal >= 200) {
    console.log(`  ${C.green}✓ 假设成立：关闭 4 个免费 AI 站省 ${dTotal}MB${C.reset}`);
    console.log(`     占总量 ${Math.round(dTotal / before.total * 100)}%`);
    console.log(`     ${C.dim}（上一版只省 52MB 是因为只等 6 秒、且只看 GPU 侧）${C.reset}`);
  } else if (dTotal >= 50) {
    console.log(`  ${C.yellow}~ 部分成立：省 ${dTotal}MB${C.reset}`);
  } else {
    console.log(`  ${C.red}✗ 不成立：只省 ${dTotal}MB${C.reset}`);
  }

  // ===== 恢复 AI 站 =====
  console.log(`\n${C.bold}【E】恢复${C.reset}`);
  const restored = await cdp.eval(`(function(){
    if (!window.app || !window.app.webai) return { error: 'no webai api' };
    // 用顶栏按钮重新打开
    var btns = [].slice.call(document.querySelectorAll('.webai-btn'));
    var n = 0;
    btns.forEach(function(b){
      var t = (b.getAttribute('title') || '');
      if (/豆包|通义|智谱|Kimi|DeepSeek/.test(t)) {
        try { b.click(); n++; } catch(e){}
      }
    });
    return { clicked: n };
  })()`);
  console.log(`  已点 ${restored.clicked} 个按钮尝试恢复`);

  writeFileSync(String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\wb-ab2-report.json`, JSON.stringify({
    at: new Date().toISOString(),
    baseline: { count: before.count, total: before.total, gpu: before.gpu, main: before.main, render: before.render },
    after: { count: after.count, total: after.total, gpu: after.gpu, main: after.main, render: after.render },
    delta: { total: dTotal, gpu: dGpu, render: dRender, renderCount: dRn },
  }, null, 2), 'utf8');
  console.log(`\n${C.dim}报告: prototype/wb-ab2-report.json${C.reset}`);

} finally {
  await cdp.close();
}
