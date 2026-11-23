/**
 * 定位最大的那个进程：PID 11052 占 478MB 工作集 / 438MB 私有
 *
 * 要弄清它承担什么角色：
 *   - 主界面渲染进程？
 *   - 某个免费 AI 站的 webview？
 *   - GPU 进程？
 *
 * 方法：
 *   ① 用 CDP 列每个 target 的进程（通过 processId 字段）
 *   ② 与 PowerShell 的 PID 对比
 */

const CDP_PORT = 9333;
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

console.log(`${C.bold}进程 ↔ target 映射${C.reset}\n`);

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();

console.log(`${'类型'.padEnd(12)} ${'进程PID'.padStart(8)} ${'标题/URL'}`);
console.log('-'.repeat(80));
for (const t of targets) {
  const title = (t.title || t.url || '').slice(0, 52);
  console.log(`${t.type.padEnd(12)} ${String(t.processId ?? '-').padStart(8)} ${title}`);
}

// 用 CDP browser endpoint 拿更详细的进程信息
try {
  const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(5000) })).json();
  if (version.webSocketDebuggerUrl) {
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('超时')), 5000);
      ws.addEventListener('open', () => { clearTimeout(t); res(); });
      ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('失败')); });
    });

    let id = 1;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pending.has(m.id)) { const { resolve } = pending.get(m.id); pending.delete(m.id); resolve(m.result); }
    });
    const send = (method, params = {}) => {
      const i = id++;
      return new Promise((res) => { pending.set(i, { resolve: res }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); res(null); } }, 15000); });
    };

    console.log(`\n${C.bold}SystemInfo.getProcessInfo${C.reset}`);
    let info = null;
    try {
      await send('SystemInfo.enable', {});
      const r = await send('SystemInfo.getProcessInfo', {});
      info = r && r.processInfo;
    } catch (e) { /* ignore */ }

    if (info && info.length) {
      console.log(`${'PID'.padStart(8)} ${'类型'.padEnd(14)} ${'CPU%'.padStart(8)}`);
      console.log('-'.repeat(40));
      const KNOWN = { 0: 'Browser(主进程)', 1: 'Renderer(渲染)', 2: 'GPU', 3: 'Pepper(插件)', 4: 'Unknown', 5: 'Utility', 6: 'Zygote', 7: 'SandboxHelper' };
      for (const p of info) {
        const type = KNOWN[p.type] || ('type' + p.type);
        console.log(`${String(p.id).padStart(8)} ${type.padEnd(14)} ${String(p.cpuTime ? p.cpuTime.toFixed(2) : '?').padStart(8)}`);
      }
    } else {
      console.log(`${C.dim}（不可用）${C.reset}`);
    }

    ws.close();
  }
} catch (e) {
  console.log(`${C.dim}拿进程信息失败：${e.message}${C.reset}`);
}

console.log(`\n${C.bold}解读${C.reset}`);
// 找出进程ID与 target 的对应
const byPid = {};
for (const t of targets) {
  if (t.processId) {
    if (!byPid[t.processId]) byPid[t.processId] = [];
    byPid[t.processId].push(t.type + ':' + (t.title || t.url || '').slice(0, 30));
  }
}
console.log(`  有 processId 的 target: ${Object.keys(byPid).length} 个进程`);
for (const [pid, list] of Object.entries(byPid)) {
  console.log(`    PID ${pid}: ${list.length} 个 target → ${list[0]}`);
}
