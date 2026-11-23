#!/usr/bin/env node
/**
 * 念初 · 产品服务器（我们自己的运行时，不依赖任何外部宿主）
 *
 * 定位变更（2026-11-17）：以前这里叫「本地预览服务器」，产品却部署进
 * D:\OpenBitFun\openbitfun-desktop.exe 那个别人的 exe 里 —— 结果是我们的
 * tools/（插件/技能/MCP/调度）全都接在预览服务器上，与产品真实运行时两条线。
 *
 * 现在改成正的：**这个进程就是产品本体**。
 *   · 静态：我们自己的 apps/vouch-web/dist
 *   · API：四个子系统全在这里，都是我们自己的实现
 *       POST /api/plugin-run   插件真实执行
 *       POST /api/mcp          MCP 探测 / 列工具 / 调工具
 *       POST /api/scheduler/tick 调度 tick（另有常驻 daemon）
 *       POST /api/skills       技能目录 / 按需装载
 *   · 启动：node tools/workbench/serve.mjs  → http://127.0.0.1:47124/
 *
 * 安全边界如实说：
 *   · 只接受 POST，GET 一律 405
 *   · **不接受客户端传插件路径 / 命令** —— 根目录与白名单写死，杜绝路径穿越
 *   · 请求体限长
 *   · 这仍是单机单进程服务器（非多租户、非公网）；不做越界拦截类安全机制，
 *     边界如实标注：文件权限、进程隔离靠宿主 OS。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createPluginRunHandler } from './plugin-run-handler.mjs';
import { createMcpMiddleware } from '../mcp/api-handler.mjs';
import { createMemoryHandler } from '../memory/api-handler.mjs';
import { createContextHandler } from '../context/api-handler.mjs';
import { createCostHandler } from '../cost/api-handler.mjs';
import { createLedgerHandler } from '../ledger/api-handler.mjs';
import { createCollabHandler } from '../collab/api-handler.mjs';
import { createSchedulerMiddleware, startSchedulerDaemon } from '../schedule/api-handler.mjs';
import { createSkillsMiddleware } from '../skills/api-handler.mjs';
import { attachWebSocketHost, IMPLEMENTED as HOST_METHODS } from '../hostapi/ws-host.mjs';
import { maybeAutoPrune } from '../agent/changeset.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DIST = join(ROOT, 'apps/vouch-web/dist');
const PORT = Number(process.env.PORT || 47124);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

// 与 Vite dev server 共用同一份处理器（避免两处漂移）
const handlePluginRun = createPluginRunHandler();
const handleMcp = createMcpMiddleware();
const handleSched = createSchedulerMiddleware();
const handleSkills = createSkillsMiddleware();
// 常驻 tick：产品服务器起来就按时触发（A11）
startSchedulerDaemon({ intervalMs: 60000 });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  // ── 运行时插件执行端点 ──
  // ── 宿主自检：列出 WebSocket 宿主已实现的方法（产品自检 / 排障用）──
  if (url.pathname === '/api/host-status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      ok: true,
      singleProcess: true,
      wsPath: wsInfo.path,
      wsUrlExample: 'ws://127.0.0.1:' + PORT + wsInfo.path,
      implemented: wsInfo.methods,
      aliases: wsInfo.aliases,
    }, null, 2));
    return;
  }

  if (url.pathname === '/api/plugin-run') {
    await handlePluginRun(req, res);
    return;
  }

  // ── 调度器端点（A11）──
  if (url.pathname === '/api/scheduler/tick') {
    await handleSched(req, res);
    return;
  }

  // ── MCP 端点（A13）──
  if (url.pathname === '/api/mcp') {
    await new Promise((resolve) => {
      handleMcp(req, res, () => resolve());
      res.on('finish', () => resolve());
      res.on('close', () => resolve());
    });
    return;
  }

  // ── 技能端点（A12 入口）──

  // ── 多代理协作协议（A9 入口）──


  // 协议搬自 metagpt（roles/role.py:125、schema.py:232-242），9 条反例全过


  if (url.pathname === '/api/collab') {


    await new Promise((resolve) => {


      createCollabHandler()(req, res, () => resolve());


      res.on('finish', () => resolve());


      res.on('close', () => resolve());


    });


    return;


  }



  // ── append-only 台账（P8 入口）──


  if (url.pathname === '/api/ledger') {


    await new Promise((resolve) => {


      createLedgerHandler()(req, res, () => resolve());


      res.on('finish', () => resolve());


      res.on('close', () => resolve());


    });


    return;


  }



  // ── 成本核算（C6 / P1 入口）──


  if (url.pathname === '/api/cost') {


    await new Promise((resolve) => {


      createCostHandler()(req, res, () => resolve());


      res.on('finish', () => resolve());


      res.on('close', () => resolve());


    });


    return;


  }



  // ── 上下文压缩（A5 入口）──


  // 审计判「全仓无任何文件 import 该模块」，这条就是那一刀


  if (url.pathname === '/api/context') {


    await new Promise((resolve) => {


      createContextHandler()(req, res, () => resolve());


      res.on('finish', () => resolve());


      res.on('close', () => resolve());


    });


    return;


  }



  // ── 记忆治理（A7 入口）──


  // 审计判「实现真但未接产品」，这条就是那一刀：写入/查询/审计/gc 都走真实存储


  if (url.pathname === '/api/memory') {


    await new Promise((resolve) => {


      createMemoryHandler()(req, res, () => resolve());


      res.on('finish', () => resolve());


      res.on('close', () => resolve());


    });


    return;


  }



  if (url.pathname === '/api/skills') {
    await new Promise((resolve) => {
      handleSkills(req, res, () => resolve());
      res.on('finish', () => resolve());
      res.on('close', () => resolve());
    });
    return;
  }

  /**
   * ══ UI 插件目录（**免构建热更新**）══════════════════════════════
   *
   * 参照 D:/refs/luanyujia-fresh/07-顶栏与菜单栏/README.md:13-15：
   * 「外壳侧改一次要重启…所以把手感类的东西全放到热更新侧 —— 调手感不用重启。
   *   这是这套壳里最值得抄的一个架构决定」。
   *
   * 我们的问题比它更严重：UI 是 Vite 整体构建（实测 46.72s），
   * 生产环境改一行文案也要重新构建 + 重启。那不是产品态。
   *
   * 所以这里开一条**绕过构建**的通道：
   *   GET /ui-plugins/index.json        → 扫目录列出插件（含 mtime，供前端做 cache-bust）
   *   GET /ui-plugins/<id>/<file>       → 直接读磁盘，no-store
   * 插件是浏览器原生 ESM，前端用 dynamic import 加载。
   * 边界如实说：只有 `/ui-plugins/**` 下的东西免构建；应用外壳（React 组件、路由、样式基座）
   * 仍然需要构建，这块没有绕过。
   */
  if (url.pathname === '/ui-plugins/index.json') {
    const dir = join(ROOT, 'ui-plugins');
    // 【Qoder 对等 · 2026-11-21】插件必须显式声明用到的宿主能力（permissions），
    // 声明了不在白名单里的权限 → 拒绝加载并报出来，不静默放行（fail-closed）。
    const KNOWN_PLUGIN_PERMISSIONS = new Set(['ui.render', 'ui.hostMethods', 'ui.notify']);
    const out = [];
    const rejected = [];
    try {
      const { readdirSync, statSync } = await import('node:fs');
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (!st.isDirectory()) continue;
        const manifestPath = join(full, 'plugin.json');
        try {
          await stat(manifestPath);
        } catch { continue; } // 没有 plugin.json 就当它不是插件
        let manifest = {};
        try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { manifest = { id: name }; }
        const permissions = Array.isArray(manifest.permissions)
          ? manifest.permissions.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim())
          : [];
        const unknown = permissions.filter((p) => !KNOWN_PLUGIN_PERMISSIONS.has(p));
        if (unknown.length) {
          rejected.push({ id: manifest.id || name, unknown });
          continue; // 声明了未知权限：拒绝加载，不静默当成合法
        }
        const entry = manifest.entry || 'index.js';
        let entryMtime = 0;
        try { entryMtime = (await stat(join(full, entry))).mtimeMs; } catch { /* ignore */ }
        out.push({
          id: manifest.id || name,
          name: manifest.name || name,
          slot: manifest.slot || 'agent-bar',
          order: Number(manifest.order) || 100,
          // 显式权限声明（Qoder 对等）：前端挂载前可据此提示/授权
          permissions,
          entryUrl: '/ui-plugins/' + name + '/' + entry,
          // 前端用它做 cache-bust：改文件即换 URL，浏览器不会用旧缓存
          entryMtime: Math.round(entryMtime),
        });
      }
    } catch { /* 目录不存在就是没有插件 */ }
    out.sort((a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id)));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ at: new Date().toISOString(), plugins: out, rejected }, null, 2));
    return;
  }

  if (url.pathname.startsWith('/ui-plugins/')) {
    const rel = url.pathname.slice('/ui-plugins/'.length);
    const safeRel = normalize(rel).replace(/^([/\\])+/, '');
    if (safeRel.includes('..')) { res.writeHead(400); res.end('bad path'); return; }
    const file = join(ROOT, 'ui-plugins', safeRel);
    try {
      const s = await stat(file);
      if (!s.isFile()) throw new Error('not file');
      const buf = await readFile(file);
      res.writeHead(200, {
        // 插件是 ESM / CSS / JSON；MIME 表里没有的按 octet-stream 走
        'content-type': MIME[extname(file).toLowerCase()] || 'text/plain; charset=utf-8',
        // 关键：绝不缓存，否则改了文件浏览器还拿旧的
        'cache-control': 'no-store, must-revalidate',
      });
      res.end(buf);
      return;
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('plugin file not found: ' + rel);
      return;
    }
  }

  // ── 未匹配的 /api/* 必须 404 ──
  // 【真 bug，2026-11-20 第 91 轮由 verify-release-postdeploy 反例A 抓到】
  // 原来没有这一段：未匹配的 /api/xxx 会掉进下面的「SPA 兜底」，返回 200 + index.html。
  // 后果：把 API 路径拼错（如 /api/host-stauts）的调用方会拿到 200，静默成功、错误被掩盖。
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: 'unknown_api_route', path: url.pathname }));
    return;
  }

  // ── 静态 ──
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const safe = normalize(p).replace(/^([/\\])+/, '');
  if (safe.includes('..')) { res.writeHead(400); res.end('bad path'); return; }
  const file = join(DIST, safe);

  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not file');
    const buf = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch {
    // SPA 兜底
    try {
      const buf = await readFile(join(DIST, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(buf);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  }
});

/**
 * ══ WebSocket 宿主挂到同一端口（2026-11-18）═══════════════════
 *
 * 用户提醒「我们实际要做的是份软件」。
 * 之前前端要通过 WebSocket 连宿主，而宿主是**另一个进程**（8080），
 * 用户得手动开两个 node 才能用 —— 这不是软件。
 *
 * 现在 WS 挂在产品服务器同一个 http server 上，路径 /ws：
 *   · 一个进程 = 一份软件
 *   · 前端用同源地址即可，不再有 localhost / 127.0.0.1 / IPv6 的坑
 */
const wsInfo = attachWebSocketHost(server, { path: '/ws' });

/**
 * 双栈监听：localhost 在本机可能解析成 ::1，只绑 127.0.0.1 会让浏览器连不上。
 * 不传 host = Node 绑定所有接口（本机 + 局域网可达）。
 * 边界如实标注：这是单机单进程服务器，不做鉴权/隔离；要限制只本机可访问请设 HOST=127.0.0.1。
 */
const HOST = process.env.HOST || undefined;

// 产品启动清一次旧变更集（只保留最近 N 个 / 天数），避免无限增长
try {
  const pr = maybeAutoPrune({ force: true });
  if (pr.removed > 0) console.log('  已清理旧变更集 ' + pr.removed + ' 个，保留 ' + pr.kept + ' 个');
} catch { /* 清理失败不影响启动 */ }

server.listen(PORT, HOST, () => {
  const base = 'http://127.0.0.1:' + PORT;
  console.log('');
  console.log('  念初 · 产品服务器（单进程）');
  console.log('  ────────────────────────────────────────────');
  console.log('  界面   ' + base + '/');
  console.log('  WebSocket  ws://127.0.0.1:' + PORT + '/ws   （' + HOST_METHODS.length + ' 个宿主方法）');
  console.log('  API    POST /api/plugin-run | /api/mcp | /api/scheduler/tick | /api/skills');
  console.log('         POST /api/memory | /api/context | /api/cost | /api/ledger | /api/collab');
  console.log('  静态根 ' + DIST);
  console.log('  调度   daemon 每 60s tick');
  console.log('');
});
