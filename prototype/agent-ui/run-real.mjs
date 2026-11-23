import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// 目的：把「真实发布版前端」直接跑起来，而不是仿它。
// 做法：静态服务 D:\OpenBitFun\frontend\dist，并在 <head> 最前面注入一个
//       Tauri IPC shim —— 真实前端以为自己在 Tauri 里，于是会正常启动。
//       同时记录它调用了哪些 invoke，方便下一轮把返回值补对。

const ROOT = path.resolve('D:/OpenBitFun/frontend/dist');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
  '.map': 'application/json', '.md': 'text/markdown; charset=utf-8',
};

const SHIM = `<script>
(function () {
  'use strict';
  var calls = [];
  window.__IPC__ = calls;
  var cbId = 1;
  var callbacks = new Map();

  function log(cmd, args) {
    var rec = { cmd: cmd, args: args };
    calls.push(rec);
    try { console.log('[IPC] ' + cmd + ' ' + JSON.stringify(args || {}).slice(0, 300)); } catch (e) {}
  }

  // 一些前端启动就会读的内部接口。返回值先给"最像空数据库"的形状。
  // 形状不是猜的：每一条都是真实前端报错反推出来的——
  //   get_config 读 .state 崩 → 必须返回 { state: ... }
  //   list_pending_permission_requests 读 .filter 崩 → 必须是数组
  //   dispatch_list_jobs 读 .map 崩 → 必须是数组
  //   initialize_workspace_startup_state 读 .openedWorkspaces 崩 → 必须有该字段
  var RESPONSES = {
    // 配置：appearance / language / 主题等前端启动必备
    'get_config': { state: {}, version: 1, notFound: false },

    // 权限邮箱
    'list_pending_permission_requests': [],
    'subscribe_permission_requests': null,

    // 派单任务
    'dispatch_list_jobs': [],
    'set_tray_unread_count': null,

    // 工作区
    'initialize_workspace_startup_state': {
      openedWorkspaces: [], activeWorkspaceId: null, recentWorkspaces: [], flags: {},
    },

    // 小程序
    'miniapp_presentation': { apps: [], snapshot: { apps: [] } },
    'mark_miniapp_web_surface_ready': null,

    // 其它启动期命令
    'computer_use_control_status': { enabled: false, running: false },
    'speech_get_realtime_config': { enabled: false, provider: null, voices: [] },
    'debug_devtools_available': false,
    'account_github_info': null,
    'i18n_get_current_language': 'zh-CN',

    // window / os 插件
    'plugin:window|is_maximized': false,
    'plugin:window|is_fullscreen': false,
    'plugin:window|scale_factor': 1,
    'plugin:window|inner_size': { width: 1440, height: 900 },
    'plugin:window|inner_position': { x: 0, y: 0 },
    'plugin:webview|webview_position': { x: 0, y: 0 },
    'plugin:os|locale': 'zh-CN',
    'plugin:os|platform': 'windows',
    'startup_window_control': { isMaximized: false },
    'plugin:log|log': null,
  };

  var INTERNALS = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main', windowLabel: 'main' },
    },
    transformCallback: function (cb, once) {
      var id = cbId++;
      callbacks.set(id, { cb: cb, once: !!once });
      return id;
    },
    unregisterCallback: function (id) { callbacks.delete(id); },
    convertFileSrc: function (p) { return p; },
    invoke: function (cmd, args, options) {
      log(cmd, args);
      var key = cmd;
      if (Object.prototype.hasOwnProperty.call(RESPONSES, key)) {
        return Promise.resolve(RESPONSES[key]);
      }
      // 未实现的命令：返回 null，后端数据相关的由后续轮次补
      return Promise.resolve(null);
    },
    plugins: {
      path: { sep: '\\\\' },
    },
  };
  window.__TAURI_INTERNALS__ = INTERNALS;
  // Tauri v2 的 withGlobalTauri 会挂这个；前端有些回退路径会读它
  window.__TAURI__ = { core: { invoke: INTERNALS.invoke }, window: {}, event: {} };

  // 让前端拿到「事件系统」的外壳，避免 listen 直接抛
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: function () {} };

  window.addEventListener('error', function (e) {
    calls.push({ cmd: '__ERROR__', args: { message: String(e.message), stack: String(e.error && e.error.stack || '').slice(0, 500) } });
  });
  // 把收集结果写进 DOM —— headless --dump-dom 读得到，console 读不到
  function dumpIpc() {
    try {
      var pre = document.getElementById('__ipc_dump');
      if (!pre) { pre = document.createElement('pre'); pre.id = '__ipc_dump'; pre.style.display = 'none'; (document.body || document.documentElement).appendChild(pre); }
      pre.textContent = JSON.stringify(window.__IPC__);
    } catch (e) {}
  }
  window.addEventListener('load', dumpIpc);
  setInterval(dumpIpc, 400);

  window.addEventListener('unhandledrejection', function (e) {
    calls.push({ cmd: '__REJECT__', args: { reason: String(e.reason && (e.reason.message || e.reason)).slice(0, 400) } });
  });
})();
</script>`;

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';

  // 调试接口：把收集到的 IPC 调用吐出来
  if (p === '/__ipc') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(globalThis.__DUMP__ || [], null, 2));
    return;
  }

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
  // 必须比所有 module script 更早执行
  const i = html.indexOf('<head>');
  if (i >= 0) return html.slice(0, i + 6) + '\n' + SHIM + '\n' + html.slice(i + 6);
  return SHIM + html;
}

const PORT = Number(process.env.PORT || 47812);
server.listen(PORT, '127.0.0.1', () => console.log('READY http://127.0.0.1:' + PORT + '/'));
setTimeout(() => process.exit(0), 900000);
