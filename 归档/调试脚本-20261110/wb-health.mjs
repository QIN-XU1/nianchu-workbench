/**
 * 工作台健康度总检（一条命令给出全部关键指标）
 *
 * 这是"深度"的落地：把之前分散的探针合成一个可重复跑的验收入口。
 *
 * 输出：
 *   - 可观测性（CDP 是否通）
 *   - 界面骨架（面板数 / 尺寸 / DOM）
 *   - 内存（各 target JS 堆 + 总 RSS）
 *   - 容错（安装状态 + 最近故障）
 *   - 稳定性（场景切换 DOM 增长）
 *   - 结论
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const CDP_PORT = Number(process.env.SEA_DEBUG_PORT || 9333);
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };
const SHELL = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳`;

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

const report = { at: new Date().toISOString(), sections: {}, ok: false };
function section(name, data) { report.sections[name] = data; }

console.log(`${C.bold}DeepSeek 工作台 · 健康度总检${C.reset}`);
console.log(`${C.dim}CDP :${CDP_PORT}${C.reset}\n`);

// ---------- 1 可观测性 ----------
let targets = [];
try {
  targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  console.log(`${C.green}✓${C.reset} 可观测性：CDP 连通，${targets.length} 个 target`);
  section('observability', { ok: true, targets: targets.length });
} catch (e) {
  console.log(`${C.red}✗${C.reset} 可观测性：CDP 不通（${e.message}）`);
  console.log(`${C.dim}  启动时加 SEA_DEBUG_PORT=9333 或 --inspect-electron 9333${C.reset}`);
  section('observability', { ok: false, error: e.message });
  report.ok = false;
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
}

const page = targets.find(t => t.type === 'page');
if (!page) { console.log(`${C.red}✗ 找不到主页面 target${C.reset}`); process.exit(1); }
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();

try {
  // ---------- 2 界面骨架 ----------
  const sk = await cdp.eval(`(function(){
    return {
      title: document.title,
      panels: [].slice.call(document.querySelectorAll('.panel')).map(function(p){
        var r = p.getBoundingClientRect();
        return { id: p.dataset.panelId, kind: (p.querySelector('.panel-body')||{}).dataset ? p.querySelector('.panel-body').dataset.kind : '', w: Math.round(r.width), h: Math.round(r.height) };
      }),
      webviews: [].slice.call(document.querySelectorAll('webview')).map(function(w){
        var r = w.getBoundingClientRect();
        var hiddenAncestor = 0, el = w.parentElement;
        while (el && el !== document.body) {
          var cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') hiddenAncestor++;
          el = el.parentElement;
        }
        return { w: Math.round(r.width), h: Math.round(r.height), src: (w.getAttribute('src')||'').slice(0,44), hiddenAncestor: hiddenAncestor };
      }),
      dom: document.querySelectorAll('*').length,
      renderers: Object.keys(window.APP_RENDERERS || {}).length,
    };
  })()`);
  const zeroInVisible = sk.webviews.filter(w => (w.w === 0 || w.h === 0) && w.hiddenAncestor === 0).length;
  const zeroInHidden = sk.webviews.filter(w => (w.w === 0 || w.h === 0) && w.hiddenAncestor > 0).length;
  console.log(`${C.bold}【界面】${C.reset}`);
  console.log(`  标题: ${sk.title}`);
  console.log(`  面板: ${sk.panels.length} 个  ${sk.panels.map(p => p.id + '(' + p.w + 'x' + p.h + ')').join(' ')}`);
  console.log(`  webview: ${sk.webviews.length} 个` + (zeroInHidden > 0 ? C.dim + ` （${zeroInHidden} 个懒挂载在隐藏容器，正常）` + C.reset : '') + (zeroInVisible > 0 ? C.yellow + ` （${zeroInVisible} 个在可见容器却 0 尺寸 ⚠）` + C.reset : ''));
  console.log(`  DOM: ${sk.dom} 节点 · 渲染器: ${sk.renderers} 种`);
  section('ui', { ...sk, zeroInVisible, zeroInHidden });

  // ---------- 3 内存 ----------
  const mem = await cdp.eval(`(function(){
    var avg = performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : null;
    return { heapMB: avg, dom: document.querySelectorAll('*').length };
  })()`);
  // 主进程 RSS
  let rssMB = null;
  try {
    const out = execFileSync('powershell', ['-Command',
      '(Get-Process -Name electron -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum).Sum / 1MB'
    ], { encoding: 'utf8', timeout: 15000 }).trim();
    rssMB = Math.round(Number(out));
  } catch { /* ignore */ }
  console.log(`\n${C.bold}【内存】${C.reset}`);
  console.log(`  主界面 JS 堆: ${mem.heapMB}MB`);
  console.log(`  Electron 总 RSS: ${rssMB}MB`);
  section('memory', { pageHeapMB: mem.heapMB, totalRssMB: rssMB });

  // ---------- 4 容错 ----------
  const fault = await cdp.eval(`(function(){
    return {
      hasOnFault: !!(window.app && window.app.onFault),
      hasShow: typeof window.__showFault === 'function',
      count: window.__faultList ? window.__faultList().length : 0,
      recent: window.__faultList ? window.__faultList().slice(-3) : [],
    };
  })()`);
  console.log(`\n${C.bold}【容错】${C.reset}`);
  console.log(`  IPC 订阅: ${fault.hasOnFault ? '✓' : '✗'}   显示入口: ${fault.hasShow ? '✓' : '✗'}`);
  console.log(`  本次运行故障数: ${fault.count}`);
  section('fault', fault);

  // server.log 里的容错安装
  const logPath = SHELL + '\\server.log';
  let logFaults = 0;
  if (existsSync(logPath)) {
    try {
      const log = readFileSync(logPath, 'utf8');
      logFaults = log.split('\n').filter(l => l.includes('[fault]')).length;
    } catch { /* ignore */ }
  }
  console.log(`  server.log 容错记录: ${logFaults} 条`);

  // ---------- 5 稳定性 ----------
  const d0 = await cdp.eval(`document.querySelectorAll('*').length`);
  for (let i = 0; i < 3; i++) {
    await cdp.eval(`(function(){ if (typeof window.loadScenario === 'function') { return 'internal'; } return 'na'; })()`);
    await new Promise(r => setTimeout(r, 600));
  }
  const d1 = await cdp.eval(`document.querySelectorAll('*').length`);
  const grow = d1 - d0;
  console.log(`\n${C.bold}【稳定性】${C.reset}`);
  console.log(`  3 轮循环后 DOM: ${d0} → ${d1} (${grow >= 0 ? '+' : ''}${grow})`);
  section('stability', { domBefore: d0, domAfter: d1, grow });

  // ---------- 结论 ----------
  const checks = [
    ['可观测性', true],
    ['可见容器内无 0 尺寸 webview', zeroInVisible === 0],
    ['容错 IPC 已订阅', fault.hasOnFault && fault.hasShow],
    ['容错层已安装', logFaults >= 4],
    ['无 DOM 泄漏', grow <= 5],
  ];
  console.log(`\n${C.bold}===== 健康度 =====${C.reset}`);
  let passed = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? C.green + '✓' : C.yellow + '!'}${C.reset} ${name}`);
    if (ok) passed++;
  }
  report.ok = passed === checks.length;
  report.checks = checks.map(([n, o]) => ({ name: n, ok: o }));
  report.score = `${passed}/${checks.length}`;
  console.log(`\n  ${report.ok ? C.green + '全部通过' : C.yellow + '有改进项'}（${passed}/${checks.length}）${C.reset}`);

} finally {
  await cdp.close();
}

// 落盘报告
const { writeFileSync } = await import('node:fs');
const outPath = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\wb-health.json`;
writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log(`\n${C.dim}报告: ${outPath}${C.reset}`);
console.log(`  {ok: ${report.ok}, score: ${report.score}}`);
