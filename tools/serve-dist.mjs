import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 极简静态服务：只服务 apps/agent-ui/dist，用于验收截图与断言。
// 不用 vite preview，是因为它在后台作业里启动不可靠（实测 http=000）。
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../apps/agent-ui/dist');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.map': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff',
};

if (!fs.existsSync(ROOT)) {
  console.error('DIST_MISSING ' + ROOT);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(fp, (e, buf) => {
    if (e) {
      fs.readFile(path.join(ROOT, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(idx);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
});

const PORT = Number(process.env.PORT || 5275);
server.listen(PORT, '127.0.0.1', () => console.log('READY http://127.0.0.1:' + PORT + '/'));
// 常驻：给用户一个可交互的地址，不自动退出。