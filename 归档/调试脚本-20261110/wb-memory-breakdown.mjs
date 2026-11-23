/**
 * 内存去向拆解（P3）
 *
 * 问题：Electron 总 RSS 2328MB，但各渲染层 JS 堆合计只有 186MB。
 * 剩下的 2100MB 在哪？必须拆开看，否则任何"优化"都是瞎猜。
 *
 * 方法：
 *   ① 按进程类型拆（main / renderer / GPU / utility / zygote）
 *   ② 每个进程的 PrivateWorkingSet（私有工作集，比 WorkingSet 准）
 *   ③ 用 Chrome 的 SystemInfo.getProcessInfo 拿逐进程类型
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
  async close() { const ws = this.ws; if (!ws) return; this.ws = null; try { await new Promise(r => { ws.addEventListener('close', r); ws.close(); setTimeout(r, 600); }); } catch { /* ignore */ } }
}

console.log(`${C.bold}内存去向拆解${C.reset}\n`);

// ---------- 方法 1：CDP SystemInfo.getProcessInfo（拿进程类型）----------
let procInfo = [];
try {
  const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(5000) })).json();
  if (version.webSocketDebuggerUrl) {
    const browserCdp = new CDP(version.webSocketDebuggerUrl);
    await browserCdp.connect();
    try {
      await browserCdp.send('SystemInfo.enable', {});
    } catch { /* 旧版本没有 */ }
    try {
      const r = await browserCdp.send('SystemInfo.getProcessInfo', {});
      procInfo = (r && r.processInfo) || [];
    } catch (e) {
      console.log(`${C.dim}SystemInfo.getProcessInfo 不可用：${e.message}${C.reset}`);
    }
    await browserCdp.close();
  }
} catch (e) {
  console.log(`${C.dim}拿 browser endpoint 失败：${e.message}${C.reset}`);
}

// ---------- 方法 2：PowerShell 按进程类型统计 ----------
console.log(`${C.bold}【A】按 Electron 进程统计（Windows）${C.reset}`);
const psScript = `
$procs = Get-Process -Name electron -ErrorAction SilentlyContinue
$rows = @()
foreach ($p in $procs) {
  $priv = $null
  try { $priv = [math]::Round($p.PrivateMemorySize64/1MB) } catch {}
  $ws = [math]::Round($p.WorkingSet64/1MB)
  $rows += [PSCustomObject]@{
    Id = $p.Id
    WS_MB = $ws
    Priv_MB = $priv
    Threads = $p.Threads.Count
    Handles = $p.HandleCount
    Title = if ($p.MainWindowTitle) { 'MAIN' } else { '' }
  }
}
$rows | Sort-Object WS_MB -Descending | ConvertTo-Json -Compress
`;
import { execFileSync } from 'node:child_process';
let psRows = [];
try {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', psScript], { encoding: 'utf8', timeout: 30000 }).trim();
  psRows = JSON.parse(out);
  if (!Array.isArray(psRows)) psRows = [psRows];
} catch (e) {
  console.log(`${C.red}PowerShell 统计失败：${e.message}${C.reset}`);
}

console.log(`${'PID'.padStart(6)} ${'工作集MB'.padStart(9)} ${'私有MB'.padStart(8)} ${'线程'.padStart(5)} ${'句柄'.padStart(5)}  角色`);
console.log('-'.repeat(60));
let totalWS = 0, totalPriv = 0;
for (const r of psRows) {
  totalWS += r.WS_MB || 0;
  totalPriv += r.Priv_MB || 0;
  console.log(`${String(r.Id).padStart(6)} ${String(r.WS_MB).padStart(9)} ${String(r.Priv_MB ?? '?').padStart(8)} ${String(r.Threads).padStart(5)} ${String(r.Handles).padStart(5)}  ${r.Title || ''}`);
}
console.log('-'.repeat(60));
console.log(`${''.padStart(6)} ${String(totalWS).padStart(9)} ${String(totalPriv).padStart(8)}`);
console.log(`${C.dim}（工作集=含共享内存；私有=独占，更接近真实占用）${C.reset}`);

// ---------- 方法 3：CDP 逐 target 的 JS 堆 ----------
console.log(`\n${C.bold}【B】各渲染 target 的 JS 堆${C.reset}`);
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
let heapSum = 0;
for (const t of targets) {
  if (!t.webSocketDebuggerUrl || !['page', 'webview'].includes(t.type)) continue;
  const c = new CDP(t.webSocketDebuggerUrl);
  let heap = null, domCount = null;
  try {
    await c.connect();
    await c.send('Performance.enable', {}).catch(() => {});
    const m = await c.send('Performance.getMetrics').catch(() => null);
    if (m && m.metrics) {
      const u = m.metrics.find(x => x.name === 'JSHeapUsedSize');
      if (u) heap = Math.round(u.value / 1048576);
    }
    domCount = await c.eval(`document.querySelectorAll('*').length`).catch(() => null);
  } catch { /* ignore */ }
  finally { await c.close(); }
  heapSum += heap || 0;
  const label = (t.title || t.url || '').slice(0, 44);
  console.log(`  ${label.padEnd(46)} 堆=${String(heap).padStart(4)}MB  DOM=${domCount ?? '?'}`);
}
console.log(`  ${'合计'.padEnd(46)} 堆=${String(heapSum).padStart(4)}MB`);

// ---------- 结论 ----------
console.log(`\n${C.bold}【C】差额分析${C.reset}`);
console.log(`  Electron 总工作集 : ${totalWS} MB`);
console.log(`  私有内存合计     : ${totalPriv} MB`);
console.log(`  渲染层 JS 堆合计 : ${heapSum} MB`);
const gap = totalPriv - heapSum;
console.log(`  ${C.yellow}未解释差额       : ${gap} MB${C.reset}`);
console.log(`\n  ${C.dim}差额的常见来源：${C.reset}`);
console.log(`  ${C.dim}  · GPU 进程（图形纹理、合成层）${C.reset}`);
console.log(`  ${C.dim}  · 每个渲染进程的 V8 之外内存（DOM 树、CSS、图片解码）${C.reset}`);
console.log(`  ${C.dim}  · Blink 的 DOM/布局对象（不计入 JS 堆）${C.reset}`);
console.log(`  ${C.dim}  · 每个 webview 的独立 renderer 进程开销${C.reset}`);
console.log(`  ${C.dim}  · 共享内存被重复计入工作集${C.reset}`);

// ---------- 落盘 ----------
const { writeFileSync } = await import('node:fs');
const report = {
  at: new Date().toISOString(),
  processes: psRows,
  totalWorkingSetMB: totalWS,
  totalPrivateMB: totalPriv,
  jsHeapSumMB: heapSum,
  unexplainedGapMB: gap,
  targets: targets.filter(t => ['page', 'webview'].includes(t.type)).map(t => ({ type: t.type, title: t.title, url: t.url })),
};
writeFileSync(String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\wb-memory-breakdown.json`, JSON.stringify(report, null, 2), 'utf8');
console.log(`\n${C.dim}报告: prototype/wb-memory-breakdown.json${C.reset}`);
