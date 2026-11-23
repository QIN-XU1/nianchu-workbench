/**
 * BitFun 独立 app · 服务器（接真实念初/DSH agent）
 *
 * 生产：node server.mjs → http://127.0.0.1:5181
 * API：POST /api/chat  { sessionId?, message } → text/event-stream（SSE）
 *      事件：session（会话 id）、text（增量）、final（完整回复）
 *
 * 真实 agent：spawn `dsh --profile headless --json --session-id <id> <message>`
 * —— 发送消息收到真实回复；--session-id 实现会话持久化。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('.', import.meta.url));
const dist = join(root, 'dist');
const PORT = Number(process.env.PORT || 5181);
const DSH = process.env.DSH_BIN
  || 'D:\\file\\software\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

  // ---- 真实 agent 接口 ----
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    try {
      const { sessionId, message } = await readBody(req);
      if (!message || typeof message !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'message required' }));
        return;
      }
      const args = ['--profile', 'headless', '--json'];
      // 仅 DSH 会话 id 才恢复；app 的本地 id（demo-1 等）走新会话
      if (sessionId && String(sessionId).startsWith('session-')) {
        args.push('--session-id', sessionId);
      }
      args.push(message);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const child = spawn(`"${DSH}"`, args, {
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let buf = '';
      const send = (obj) => {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      };
      const handleLine = (line) => {
        if (!line.trim()) return;
        try {
          const ev = JSON.parse(line);
          send(ev);
        } catch {
          /* 非 JSON 诊断行，忽略 */
        }
      };
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      });
      child.stderr.on('data', () => {});
      child.on('close', () => {
        if (buf.trim()) handleLine(buf);
        res.end();
      });
      child.on('error', (err) => {
        res.write(`data: ${JSON.stringify({ type: 'error', message: String(err) })}\n\n`);
        res.end();
      });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  // ---- 静态资源 ----
  try {
    let path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!extname(path)) path = '/index.html';
    const file = join(dist, path);
    if (!file.startsWith(dist)) throw new Error('forbidden');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[bitfun] standalone app → http://127.0.0.1:${PORT}`);
});
