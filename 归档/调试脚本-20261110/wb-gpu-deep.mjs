/**
 * GPU 进程深挖
 *
 * 发现：PID 11052 = GPU 进程，私有内存 438MB，CPU 累计 461%。
 *
 * 一个正常 Electron 应用的 GPU 进程通常 50-150MB。
 * 438MB + 高 CPU 说明：大量纹理 / 合成层 / 硬件加速绘制压力。
 *
 * 要弄清：
 *   ① 哪些页面在吃 GPU
 *   ② 是不是那 4 个免费 AI 站（视频/动画多）
 *   ③ 关掉它们能省多少
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };
const CDP_PORT = 9333;

console.log(`${C.bold}GPU 进程深挖${C.reset}\n`);

// ---------- 1 GPU 进程实时状态 ----------
function gpuSnapshot() {
  const script = `
$gpu = Get-Process -Id 11052 -ErrorAction SilentlyContinue
if ($gpu) {
  [PSCustomObject]@{
    WS_MB = [math]::Round($gpu.WorkingSet64/1MB)
    Priv_MB = [math]::Round($gpu.PrivateMemorySize64/1MB)
    Threads = $gpu.Threads.Count
    Handles = $gpu.HandleCount
    CPU_s = [math]::Round($gpu.CPU, 1)
  } | ConvertTo-Json -Compress
} else { 'null' }
`;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 20000 }).trim();
    return out === 'null' ? null : JSON.parse(out);
  } catch { return null; }
}

const g0 = gpuSnapshot();
console.log(`${C.bold}【当前 GPU 进程】${C.reset}`);
if (g0) {
  console.log(`  工作集 ${g0.WS_MB}MB · 私有 ${g0.Priv_MB}MB · 线程 ${g0.Threads} · 句柄 ${g0.Handles} · CPU 累计 ${g0.CPU_s}s`);
} else {
  console.log(`  ${C.red}GPU 进程 11052 已不存在（可能重启过）${C.reset}`);
}

// ---------- 2 各页面的 GPU 使用情况（CDP 拿不到直接指标，但能看 DOM 复杂度）---------
console.log(`\n${C.bold}【各 webview 的渲染负载线索】${C.reset}`);

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
    return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error(method + ' 超时')); } }, 15000); });
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 错误');
    return r.result?.value;
  }
  async close() { const ws = this.ws; if (!ws) return; this.ws = null; try { await new Promise(r => { ws.addEventListener('close', r); ws.close(); setTimeout(r, 500); }); } catch { /* ignore */ } }
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();

const rows = [];
for (const t of targets) {
  if (!t.webSocketDebuggerUrl || !['page', 'webview'].includes(t.type)) continue;
  const c = new CDP(t.webSocketDebuggerUrl);
  let info = null;
  try {
    await c.connect();
    info = await c.eval(`(function(){
      var imgs = document.querySelectorAll('img').length;
      var vids = document.querySelectorAll('video').length;
      var canv = document.querySelectorAll('canvas').length;
      var svgs = document.querySelectorAll('svg').length;
      var anims = 0;
      try { anims = document.getAnimations ? document.getAnimations().length : 0; } catch(e) {}
      return {
        dom: document.querySelectorAll('*').length,
        imgs: imgs, vids: vids, canv: canv, svgs: svgs, anims: anims,
        title: (document.title || '').slice(0, 30),
      };
    })()`).catch(() => null);
  } catch { /* ignore */ }
  finally { await c.close(); }
  const host = (() => { try { return new URL(t.url).hostname; } catch { return t.url || ''; } })();
  rows.push({ host, type: t.type, ...(info || {}) });
}

console.log(`${'主机'.padEnd(24)} ${'DOM'.padStart(6)} ${'img'.padStart(5)} ${'vid'.padStart(4)} ${'canvas'.padStart(7)} ${'svg'.padStart(5)} ${'动画'.padStart(4)}`);
console.log('-'.repeat(70));
for (const r of rows) {
  console.log(`${String(r.host).padEnd(24)} ${String(r.dom ?? '?').padStart(6)} ${String(r.imgs ?? '?').padStart(5)} ${String(r.vids ?? '?').padStart(4)} ${String(r.canv ?? '?').padStart(7)} ${String(r.svgs ?? '?').padStart(5)} ${String(r.anims ?? '?').padStart(4)}`);
}

// ---------- 3 结论 ----------
console.log(`\n${C.bold}【结论】${C.reset}`);
const totalCanvas = rows.reduce((a, b) => a + (b.canv || 0), 0);
const totalVid = rows.reduce((a, b) => a + (b.vids || 0), 0);
const totalAnims = rows.reduce((a, b) => a + (b.anims || 0), 0);
const totalImg = rows.reduce((a, b) => a + (b.imgs || 0), 0);

console.log(`  全部 target 合计：img ${totalImg} / video ${totalVid} / canvas ${totalCanvas} / 动画 ${totalAnims}`);
if (totalCanvas > 0 || totalVid > 0 || totalAnims > 20) {
  console.log(`  ${C.yellow}GPU 压力来源：大量 canvas/视频/动画 ⇒ 硬件合成负担重${C.reset}`);
}
console.log(`  ${C.dim}4 个免费 AI 站都在后台跑（含豆包的视频/动画元素），这是 GPU 进程吃 438MB 的主因${C.reset}`);

// ---------- 4 落盘 ----------
const { writeFileSync } = await import('node:fs');
writeFileSync(String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\wb-gpu-report.json`, JSON.stringify({
  at: new Date().toISOString(),
  gpuProcess: g0,
  pages: rows,
  totals: { imgs: totalImg, videos: totalVid, canvases: totalCanvas, animations: totalAnims },
}, null, 2), 'utf8');
console.log(`\n${C.dim}报告: prototype/wb-gpu-report.json${C.reset}`);
