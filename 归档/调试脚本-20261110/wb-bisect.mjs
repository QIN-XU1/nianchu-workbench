/**
 * 二分定位：逐个禁用 webview，量内存差，找出最耗资源的那个
 *
 * 方法借鉴：[VS Code Extension Bisect]
 *   VS Code 用二分法禁用扩展来定位性能问题。
 *   我们有 6 个 webview，用同样的思路：逐个禁用，量每个的边际成本。
 *
 * 为什么这比"看总量"有用：
 *   知道"总共 992MB"没用；知道"豆包单独吃 230MB"才能做决策。
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
    return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error(method + ' 超时')); } }, 30000); });
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 错误');
    return r.result?.value;
  }
  async close() { const ws = this.ws; if (!ws) return; this.ws = null; try { await new Promise(r => { ws.addEventListener('close', r); ws.close(); setTimeout(r, 500); }); } catch { /* ignore */ } }
}

function totalPrivateMB() {
  const script = `
$procs = Get-Process -Name electron -ErrorAction SilentlyContinue
$sum = 0
foreach ($p in $procs) { $sum += $p.PrivateMemorySize64 / 1MB }
[math]::Round($sum)
`;
  try {
    return Number(execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 25000 }).trim());
  } catch { return null; }
}

function processCount() {
  const script = `(Get-Process -Name electron -ErrorAction SilentlyContinue | Measure-Object).Count`;
  try {
    return Number(execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 20000 }).trim());
  } catch { return null; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();

try {
  console.log(`${C.bold}二分定位：每个 webview 的边际内存成本${C.reset}`);
  console.log(`${C.dim}方法借鉴 VS Code Extension Bisect${C.reset}\n`);

  // ---- 列出现有 webview ----
  const wvs = await cdp.eval(`(function(){
    return [].slice.call(document.querySelectorAll('webview')).map(function(w, i){
      var r = w.getBoundingClientRect();
      return {
        i: i,
        src: (w.getAttribute('src') || '').slice(0, 56),
        part: w.getAttribute('partition') || '',
        w: Math.round(r.width), h: Math.round(r.height),
      };
    });
  })()`);

  console.log(`发现 ${wvs.length} 个 webview：`);
  for (const w of wvs) {
    console.log(`  [${w.i}] ${String(w.w)}x${String(w.h).padEnd(5)} ${w.part.padEnd(24)} ${w.src}`);
  }

  // ---- 基线 ----
  const baseMem = totalPrivateMB();
  const baseProc = processCount();
  console.log(`\n${C.bold}【基线】${C.reset} 私有 ${baseMem}MB · ${baseProc} 个进程`);

  // ---- 逐个禁用（每次只禁一个，量差，然后恢复）----
  const results = [];
  for (const w of wvs) {
    // 跳过已空白
    if (w.src === 'about:blank' || w.src === '') {
      console.log(`  ${C.dim}[${w.i}] 已是空白，跳过${C.reset}`);
      continue;
    }

    // 禁用这一个
    const origSrc = w.src;
    await cdp.eval(`(function(){
      var wv = document.querySelectorAll('webview')[${w.i}];
      if (wv) { try { wv.setAttribute('src', 'about:blank'); } catch(e){} }
      return true;
    })()`);

    await sleep(12000);   // 等进程回收（上一轮教训：等太短会误判）

    const m1 = totalPrivateMB();
    const p1 = processCount();
    const delta = baseMem - m1;

    // 恢复
    await cdp.eval(`(function(){
      var wv = document.querySelectorAll('webview')[${w.i}];
      if (wv) { try { wv.setAttribute('src', ${JSON.stringify(origSrc)}); } catch(e){} }
      return true;
    })()`);

    await sleep(8000);   // 等恢复

    const host = (() => { try { return new URL(origSrc).hostname; } catch { return origSrc; } })();
    results.push({ i: w.i, host, src: origSrc, deltaMB: delta, procDelta: (baseProc || 0) - (p1 || 0) });

    const flag = delta >= 100 ? C.red + '很高' + C.reset : (delta >= 50 ? C.yellow + '中等' + C.reset : C.green + '很低' + C.reset);
    console.log(`  [${w.i}] ${host.padEnd(24)} 禁用后省 ${String(delta).padStart(4)}MB  ${flag}`);
  }

  // ---- 排行 ----
  console.log(`\n${C.bold}【排行】按边际成本${C.reset}`);
  const sorted = results.slice().sort((a, b) => b.deltaMB - a.deltaMB);
  for (const r of sorted) {
    const bar = '█'.repeat(Math.max(1, Math.round(r.deltaMB / 10)));
    console.log(`  ${r.host.padEnd(24)} ${String(r.deltaMB).padStart(5)}MB  ${C.yellow}${bar}${C.reset}`);
  }

  const totalDelta = sorted.reduce((a, b) => a + b.deltaMB, 0);
  console.log(`\n  合计边际成本 ${totalDelta}MB（基线 ${baseMem}MB，占比 ${baseMem ? Math.round(totalDelta / baseMem * 100) : 0}%）`);

  // ---- 建议 ----
  console.log(`\n${C.bold}【建议】${C.reset}`);
  if (sorted.length > 0 && sorted[0].deltaMB >= 100) {
    const worst = sorted[0];
    console.log(`  最贵的是 ${worst.host}（${worst.deltaMB}MB）。`);
    console.log(`  ${C.dim}如果这个站不常用，改成"点开才加载"（noWarm）能省下这部分。${C.reset}`);
  }
  console.log(`  ${C.dim}注：边际成本合计 ${totalDelta}MB 与实测"全部关闭省 1045MB"有差异，`);
  console.log(`     因为逐个测时其他站仍在运行，GPU/共享开销被重复计算。${C.reset}`);

  writeFileSync(String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\wb-bisect-report.json`, JSON.stringify({
    at: new Date().toISOString(),
    baseline: { privMB: baseMem, procs: baseProc },
    results: sorted,
    totalMarginalMB: totalDelta,
  }, null, 2), 'utf8');
  console.log(`\n${C.dim}报告: prototype/wb-bisect-report.json${C.reset}`);

} finally {
  await cdp.close();
}
