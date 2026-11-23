import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

/**
 * 用 CDP 取一次**渲染完成**的页面 DOM。
 *
 * 为什么不用 `--dump-dom`：它是一次性交卷，页面挂载（念初面板、插件、密度档位）
 * 都发生在之后。实测同一条命令两次分别拿到 55 KB 和 151 KB —— 断言时红时绿，
 * 看着像功能坏了，其实只是**采样早于挂载**。这里改成：导航后轮询 `waitExpr`
 * 直到它为真（或超时），再取 `document.documentElement.outerHTML`。
 *
 * @param {object} opts
 * @param {string} opts.url              目标地址
 * @param {string} opts.waitExpr        页面里求值、为真即「渲染完成」
 * @param {number} [opts.timeoutMs]     等待上限（默认 30s）
 * @param {string} [opts.userDataDir]   独立 profile 目录（不传则建临时目录）
 * @param {string} [opts.browser]       Chrome/Edge 可执行文件
 * @param {(msg: string) => void} [opts.log] 进度回调
 * @returns {Promise<{ html: string, ready: boolean, waitedMs: number }>}
 */
export async function dumpDomWithCdp(opts) {
  const {
    url, waitExpr, timeoutMs = 30000, userDataDir, browser, log = () => {},
  } = opts;
  const port = await freePort();
  const profile = userDataDir || mkdtempSync(join(tmpdir(), 'nianchu-cdp-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: 'ignore', detached: process.platform !== 'win32' });

  let ws = null;
  let ready = false;
  const startedAt = Date.now();
  try {
    const page = await waitForTarget(port, timeoutMs);
    if (!page) {
      log('CDP 端点没起来 → 返回空 DOM（断言会如实红）');
      return { html: '', ready: false, waitedMs: Date.now() - startedAt };
    }

    ws = new WebSocket(page.webSocketDebuggerUrl);
    const pending = new Map();
    let seq = 0;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const send = (method, params = {}) => new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      return m?.result?.result?.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ok = await evaluate(`(() => { try { return !!(${waitExpr}); } catch { return false; } })()`);
      if (ok) { ready = true; break; }
      await sleep(200);
    }
    if (!ready) log('等待渲染超时（返回当前 DOM，断言会如实红）');

    const html = await evaluate('document.documentElement.outerHTML');
    return { html: String(html || ''), ready, waitedMs: Date.now() - startedAt };
  } finally {
    try { ws?.close(); } catch { /* 忽略 */ }
    // 只 kill 主进程会在 Windows 上留下 renderer/zygote（实测每次残留 2~3 个），
    // 这些僵尸吃 CPU，会让后续渲染测量假红 —— 必须按进程树杀。
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    } catch { /* 已经退出就忽略 */ }
    if (!userDataDir) {
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* 清不掉不影响结果 */ }
    }
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForTarget(port, timeoutMs) {
  const deadline = Date.now() + Math.min(timeoutMs, 20000);
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = (Array.isArray(list) ? list : []).find((x) => x.type === 'page');
      if (page) return page;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
