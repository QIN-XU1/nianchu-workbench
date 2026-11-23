/**
 * 念初 · 本地服务器
 *
 * 把 BitFun 界面（prototype/agent-ui/bitfun-full.html）跑起来，并接上真实的
 * 念初 agent（dsh headless）。
 *
 *   GET  /               → BitFun 界面
 *   POST /api/chat       → 把 { message } 交给 `dsh headless`，返回 { reply, ms }
 *   GET  /api/health     → { ok, dsh }
 *
 * 用法：node server.mjs   （默认 127.0.0.1:5199）
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..'); // Agent自研
const UI_FILE = join(ROOT, 'prototype', 'agent-ui', 'bitfun-full.html');
const DSH = process.env.DSH_BIN
  || 'D:\\file\\software\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd';

const PORT = Number(process.env.PORT || 5199);
const HOST = process.env.HOST || '127.0.0.1';

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function runHeadless(message) {
  const started = Date.now();
  return new Promise((resolve) => {
    // 用 cmd /c 包一层，避免 .cmd 的 shell 语义差异
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${DSH}" headless ${JSON.stringify(message)}`], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('close', (code) => {
      const text = (out || '').trim();
      resolve({
        ok: code === 0,
        reply: text || (code === 0 ? '（代理没有输出）' : `代理退出码 ${code}`),
        stderr: err.trim() || undefined,
        ms: Date.now() - started,
      });
    });
    child.on('error', (e) => resolve({ ok: false, reply: `无法启动代理：${e.message}`, ms: Date.now() - started }));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    if (!existsSync(UI_FILE)) return send(res, 500, 'text/plain; charset=utf-8', '找不到 BitFun 界面文件');
    return send(res, 200, 'text/html; charset=utf-8', readFileSync(UI_FILE));
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, 'application/json', JSON.stringify({ ok: existsSync(DSH), dsh: DSH }));
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let message = '';
    try { message = (JSON.parse(raw || '{}').message || '').trim(); } catch { /* ignore */ }
    if (!message) return send(res, 400, 'application/json', JSON.stringify({ ok: false, reply: '消息为空' }));
    const result = await runHeadless(message);
    return send(res, 200, 'application/json', JSON.stringify(result));
  }

  return send(res, 404, 'text/plain; charset=utf-8', 'not found');
});

server.listen(PORT, HOST, () => {
  console.log(`念初 · BitFun PKG  http://${HOST}:${PORT}`);
  console.log(`agent: ${DSH}`);
});
