import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// 服务「我们自己构建出来的 OpenBitFun 前端」（来自 src/web-ui 源码，不是安装包产物），
// 并注入 IPC shim，让它在浏览器里跑起来。
// 这是「在 OpenBitFun 基础上修改」的第一步：先证明我们能自己构建并运行它。

const ROOT = path.resolve(process.env.ROOT || 'D:/refs/openbitfun-src/OpenBitFun-main/dist');
const PORT = Number(process.env.PORT || 47990);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
  '.map': 'application/json', '.md': 'text/markdown; charset=utf-8',
};

const SHIM = `<script>
(function () {
  var calls = []; window.__IPC__ = calls;
  var cbId = 1; var callbacks = new Map();
  function log(cmd, args) { calls.push({ cmd: cmd, args: args }); }
  var RESPONSES = {
    'get_config': { state: {}, version: 1, notFound: false },
    'list_pending_permission_requests': [],
    'subscribe_permission_requests': null,
    'dispatch_list_jobs': [],
    'set_tray_unread_count': null,
    'initialize_workspace_startup_state': { openedWorkspaces: [], activeWorkspaceId: null, recentWorkspaces: [], flags: {} },
    'miniapp_presentation': { apps: [], snapshot: { apps: [] } },
    'mark_miniapp_web_surface_ready': null,
    'computer_use_control_status': { enabled: false, running: false },
    'speech_get_realtime_config': { enabled: false, provider: null, voices: [] },
    'debug_devtools_available': false,
    'account_github_info': null,
    'i18n_get_current_language': 'zh-CN',
    'plugin:window|is_maximized': false,
    'plugin:window|is_fullscreen': false,
    'plugin:window|scale_factor': 1,
    'plugin:window|inner_size': { width: 1440, height: 900 },
    'plugin:window|inner_position': { x: 0, y: 0 },
    'plugin:webview|webview_position': { x: 0, y: 0 },
    'plugin:os|locale': 'zh-CN',
    'plugin:os|platform': 'windows',
    'startup_window_control': { isMaximized: false },
    'plugin:log|log': null
  };
  var INTERNALS = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
    transformCallback: function (cb, once) { var id = cbId++; callbacks.set(id, { cb: cb, once: !!once }); return id; },
    unregisterCallback: function (id) { callbacks.delete(id); },
    convertFileSrc: function (p) { return p; },
    invoke: function (cmd, args) {
      log(cmd, args);
      if (Object.prototype.hasOwnProperty.call(RESPONSES, cmd)) return Promise.resolve(RESPONSES[cmd]);
      return Promise.resolve(null);
    },
    plugins: { path: { sep: '\\\\' } }
  };
  window.__TAURI_INTERNALS__ = INTERNALS;
  window.__TAURI__ = { core: { invoke: INTERNALS.invoke }, window: {}, event: {} };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: function () {} };

  function dumpIpc() {
    try {
      var pre = document.getElementById('__ipc_dump');
      if (!pre) { pre = document.createElement('pre'); pre.id = '__ipc_dump'; pre.style.display = 'none'; (document.body || document.documentElement).appendChild(pre); }
      pre.textContent = JSON.stringify(window.__IPC__);
    } catch (e) {}
  }
  window.addEventListener('load', dumpIpc);
  setInterval(dumpIpc, 400);
  window.addEventListener('error', function (e) { calls.push({ cmd: '__ERROR__', args: { m: String(e.message) } }); });
  window.addEventListener('unhandledrejection', function (e) { calls.push({ cmd: '__REJECT__', args: { r: String(e.reason && (e.reason.message || e.reason)).slice(0, 300) } }); });
})();
</script>`;

if (!fs.existsSync(ROOT)) {
  console.error('ROOT_MISSING ' + ROOT);
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
        res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(inject(idx.toString('utf8')));
      });
      return;
    }
    if (p === '/index.html') {
      res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(inject(buf.toString('utf8')));
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
});

function inject(html) {
  const i = html.indexOf('<head>');
  return i >= 0 ? html.slice(0, i + 6) + '\n' + SHIM + '\n' + html.slice(i + 6) : SHIM + html;
}

server.listen(PORT, '127.0.0.1', () => console.log('READY http://127.0.0.1:' + PORT + '/  root=' + ROOT));
