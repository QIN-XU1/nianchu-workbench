const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve('evidence/inline-code');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.png': 'image/png' };
const srv = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const fp = path.join(ROOT, urlPath === '/' ? 'harness.html' : urlPath);
  if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});
srv.listen(8917, '127.0.0.1', () => console.log('static 8917 ready'));
