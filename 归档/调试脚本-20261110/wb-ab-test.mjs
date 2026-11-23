/**
 * A/B 实验：关闭 4 个免费 AI 站，看 GPU 内存掉多少
 *
 * 假设：GPU 进程 438MB 主要是这 4 个后台站的合成层。
 * 验证：点 webai-btn 收起它们 → 等 → 再量 GPU 进程。
 *
 * 这是一个真正的对照实验，不是猜。
 */

import { execFileSync } from 'node:child_process';

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

/** 量所有 electron 进程的内存 */
function measureMemory() {
  const script = `
$procs = Get-Process -Name electron -ErrorAction SilentlyContinue
$ws = 0; $priv = 0; $gpu = $null
foreach ($p in $procs) {
  $w = $p.WorkingSet64 / 1MB
  $pr = $p.PrivateMemorySize64 / 1MB
  $ws += $w
  $priv += $pr
}
[PSCustomObject]@{
  ProcessCount = $procs.Count
  TotalWS_MB = [math]::Round($ws)
  TotalPriv_MB = [math]::Round($priv)
} | ConvertTo-Json -Compress
`;
  try {
    return JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 30000 }).trim());
  } catch { return null; }
}

/** 量 GPU 进程（通过 ID 列表逐个判断，GPU 进程的典型特征是线程多但无窗口） */
function measureGpu() {
  const script = `
$gpus = @()
$procs = Get-Process -Name electron -ErrorAction SilentlyContinue
foreach ($p in $procs) {
  $gpus += [PSCustomObject]@{
    Id = $p.Id
    WS_MB = [math]::Round($p.WorkingSet64/1MB)
    Priv_MB = [math]::Round($p.PrivateMemorySize64/1MB)
    Threads = $p.Threads.Count
    HasWindow = ($p.MainWindowTitle -ne '')
  }
}
$gpus | ConvertTo-Json -Compress
`;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 30000 }).trim();
    const arr = JSON.parse(out);
    return Array.isArray(arr) ? arr : [arr];
  } catch { return []; }
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();

try {
  console.log(`${C.bold}A/B 实验：关闭 4 个免费 AI 站${C.reset}\n`);

  // ---------- 基线 ----------
  const base = measureMemory();
  const baseWv = await cdp.eval(`document.querySelectorAll('webview').length`);
  const baseProcs = measureGpu();
  console.log(`${C.bold}【基线】${C.reset}`);
  console.log(`  进程数 ${base.ProcessCount} · 工作集 ${base.TotalWS_MB}MB · 私有 ${base.TotalPriv_MB}MB · webview ${baseWv} 个`);
  const topBefore = baseProcs.sort((a, b) => b.Priv_MB - a.Priv_MB).slice(0, 3);
  console.log(`  私有内存 TOP3: ${topBefore.map(p => p.Id + '=' + p.Priv_MB + 'MB' + (p.HasWindow ? '(窗口)' : '')).join(', ')}`);

  // ---------- 收起 4 个站 ----------
  console.log(`\n${C.bold}【操作】点 webai-btn 收起所有站${C.reset}`);
  const clicked = await cdp.eval(`(function(){
    var btns = [].slice.call(document.querySelectorAll('.webai-btn'));
    var before = [];
    var results = [];
    btns.forEach(function(b){
      var title = (b.getAttribute('title') || '').slice(0, 20);
      var isOn = b.classList.contains('on') || b.classList.contains('active');
      before.push(title + (isOn ? '[开]' : '[关]'));
      if (isOn) {
        try { b.click(); results.push('closed:' + title); } catch(e) { results.push('err:' + title); }
      }
    });
    return { total: btns.length, before: before, results: results };
  })()`);
  console.log(`  webai-btn 共 ${clicked.total} 个`);
  console.log(`  操作前状态: ${clicked.before.join(' ')}`);
  console.log(`  执行: ${clicked.results.length ? clicked.results.join(', ') : '（没有开着的，改用强制隐藏）'}`);

  // 若没有按钮被点，用另一条路：直接把 webview 的 src 清空
  if (clicked.results.length === 0) {
    const forced = await cdp.eval(`(function(){
      var wvs = [].slice.call(document.querySelectorAll('webview')).filter(function(w){
        var src = w.getAttribute('src') || '';
        return /doubao|qianwen|chatglm|kimi/.test(src);
      });
      wvs.forEach(function(w){
        try { w.stop(); w.setAttribute('src', 'about:blank'); } catch(e){}
      });
      return { count: wvs.length };
    })()`);
    console.log(`  强制导航到 about:blank: ${forced.count} 个`);
  }

  await new Promise(r => setTimeout(r, 6000));

  // ---------- 测量 ----------
  const after = measureMemory();
  const afterWv = await cdp.eval(`document.querySelectorAll('webview').length`);
  const afterProcs = measureGpu();
  console.log(`\n${C.bold}【6 秒后】${C.reset}`);
  console.log(`  进程数 ${after.ProcessCount} · 工作集 ${after.TotalWS_MB}MB · 私有 ${after.TotalPriv_MB}MB · webview ${afterWv} 个`);
  const topAfter = afterProcs.sort((a, b) => b.Priv_MB - a.Priv_MB).slice(0, 3);
  console.log(`  私有内存 TOP3: ${topAfter.map(p => p.Id + '=' + p.Priv_MB + 'MB').join(', ')}`);

  // ---------- 差值 ----------
  console.log(`\n${C.bold}【差值】${C.reset}`);
  const dWS = base.TotalWS_MB - after.TotalWS_MB;
  const dPriv = base.TotalPriv_MB - after.TotalPriv_MB;
  console.log(`  工作集: ${base.TotalWS_MB} → ${after.TotalWS_MB} (${dWS >= 0 ? '省 -' : '增 +'}${Math.abs(dWS)}MB)`);
  console.log(`  私有  : ${base.TotalPriv_MB} → ${after.TotalPriv_MB} (${dPriv >= 0 ? '省 -' : '增 +'}${Math.abs(dPriv)}MB)`);

  // 与基线同 Id 的进程逐一比较
  const baseById = {};
  for (const p of baseProcs) baseById[p.Id] = p;
  console.log(`\n  ${C.bold}逐进程变化（私有内存）${C.reset}`);
  let changed = 0;
  for (const p of afterProcs) {
    const b = baseById[p.Id];
    if (!b) continue;
    const d = b.Priv_MB - p.Priv_MB;
    if (Math.abs(d) >= 5) {
      console.log(`    PID ${p.Id}: ${b.Priv_MB} → ${p.Priv_MB} (${d > 0 ? '-' + d : '+' + (-d)}MB)`);
      changed++;
    }
  }
  if (changed === 0) console.log(`    （没有显著变化）`);

  console.log(`\n${C.bold}【判定】${C.reset}`);
  if (dPriv > 150) {
    console.log(`  ${C.green}✓ 假设成立：关闭 4 个站省了 ${dPriv}MB 私有内存${C.reset}`);
  } else if (dPriv > 50) {
    console.log(`  ${C.yellow}~ 部分成立：省了 ${dPriv}MB，但不是大头${C.reset}`);
  } else {
    console.log(`  ${C.red}✗ 假设不成立：只省了 ${dPriv}MB —— GPU 内存不是这些站造成的${C.reset}`);
    console.log(`  ${C.dim}  需要另找原因（见 wb-memory-breakdown.json 的逐进程数据）${C.reset}`);
  }

  // 落盘
  const { writeFileSync } = await import('node:fs');
  writeFileSync(String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\wb-ab-report.json`, JSON.stringify({
    at: new Date().toISOString(),
    baseline: base, after: after,
    processDetail: { before: baseProcs, after: afterProcs },
    deltaWS: dWS, deltaPriv: dPriv,
  }, null, 2), 'utf8');
  console.log(`\n${C.dim}报告: prototype/wb-ab-report.json${C.reset}`);

} finally {
  await cdp.close();
}
