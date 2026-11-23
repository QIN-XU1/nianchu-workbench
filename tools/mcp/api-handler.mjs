#!/usr/bin/env node
/**
 * POST /api/mcp 的处理器（纯函数）。
 *
 * 为什么要有它：独立审计判 A13「部分」的理由是「客户端 20/20 通过并连了官方 SDK 真 server，
 * 但全仓产品侧 0 调用、0 端点、0 面板，只活在验收脚本里」。
 * 这个文件把 MCP 客户端接成产品可调用的端点。
 *
 * ## 安全边界（这是 API 设计，不是「越界拦截类机制」）
 * 客户端**只能传 serverId**，不能传 command。
 * 如果允许传 command，这个端点就等于无鉴权的任意进程执行 —— 那不是「机制」，是漏洞。
 * 命令来自 tools/mcp/servers.json 白名单，由服务端决定。
 *
 * ## 动作
 *   { serverId, action: 'probe' }                     → 起→握手→列工具→关
 *   { serverId, action: 'list' }                      → 只列工具
 *   { serverId, action: 'call', tool, args }          → 调一个工具
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpSession } from './client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVERS = join(HERE, 'servers.json');

/** 读白名单。坏 JSON 要报出来，不能静默当成「没有服务器」。 */
export function loadServers(file = SERVERS) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return { ok: true, servers: Array.isArray(j.servers) ? j.servers : [] };
  } catch (e) {
    return { ok: false, error: String(e && e.message), servers: [] };
  }
}

const ACTIONS = new Set(['probe', 'list', 'call']);

/**
 * @param {{ load?: typeof loadServers, sessionFactory?: (cmd: string, opts: any) => any }} [deps]
 */
export function createMcpHandler(deps = {}) {
  const load = deps.load || loadServers;
  const mkSession = deps.sessionFactory || ((cmd, opts) => new McpSession(cmd, opts));
  let busy = false;

  return async function handle(req, res, bodyText) {
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    };

    if (req.method !== 'POST') { send(405, { ok: false, error: '只接受 POST' }); return true; }
    if (busy) { send(429, { ok: false, error: '已有一次 MCP 调用在进行中' }); return true; }

    let body;
    try {
      body = JSON.parse(bodyText || '{}');
    } catch {
      send(400, { ok: false, error: '请求体不是合法 JSON' });
      return true;
    }

    const { serverId, action, tool, args } = body || {};
    if (!serverId || typeof serverId !== 'string') { send(400, { ok: false, error: '缺 serverId' }); return true; }
    if (!ACTIONS.has(action)) { send(400, { ok: false, error: 'action 只能是 probe/list/call' }); return true; }
    if (action === 'call' && (!tool || typeof tool !== 'string')) { send(400, { ok: false, error: 'call 需要 tool' }); return true; }

    const { ok: loaded, servers, error } = load();
    if (!loaded) { send(500, { ok: false, error: 'servers.json 读不了：' + error }); return true; }

    const srv = servers.find((s) => s.id === serverId);
    if (!srv) {
      send(404, { ok: false, error: '未知 serverId：' + serverId, known: servers.map((s) => s.id) });
      return true;
    }

    // 关键：命令只来自白名单，body 里的 command 字段一律忽略。
    // McpSession 用 spawn(cmd, [], { shell: true })，所以 command 必须是**字符串**。
    const cmd = typeof srv.command === 'string' && srv.command.trim() ? srv.command : null;
    if (!cmd) { send(500, { ok: false, error: '白名单里的 command 不是非空字符串' }); return true; }

    busy = true;
    const s = mkSession(cmd, { cwd: join(HERE, '..', '..'), timeoutMs: 20000 });
    try {
      const started = await s.start();
      if (started.state !== 'PASS') {
        send(200, { ok: false, serverId, action, state: started.state, why: started.why, stderr: s.stderr });
        return true;
      }
      const init = await s.initialize();
      if (init.state !== 'PASS') {
        send(200, { ok: false, serverId, action, state: init.state, why: init.why, stderr: s.stderr });
        return true;
      }

      if (action === 'probe' || action === 'list') {
        const list = await s.listTools();
        send(200, {
          ok: list.state === 'PASS',
          serverId,
          action,
          state: list.state,
          server: init.serverInfo || null,
          tools: list.tools || [],
          count: (list.tools || []).length,
        });
        return true;
      }

      const out = await s.callTool(tool, args || {});
      // callTool 返回 { state, why, content, isError }，没有 result 字段 —— 上一版取了 out.result 所以永远是 null
      send(200, {
        ok: out.state === 'PASS',
        serverId,
        action,
        state: out.state,
        tool,
        isError: out.isError === true,
        content: out.content === undefined ? null : out.content,
        why: out.why,
      });
      return true;
    } catch (e) {
      send(500, { ok: false, error: String(e && e.message) });
      return true;
    } finally {
      try { await s.close(); } catch { /* 关闭失败不影响响应 */ }
      busy = false;
    }
  };
}

/** Vite 中间件形式：需要自己读请求体 */
export function createMcpMiddleware(deps) {
  const handle = createMcpHandler(deps);
  return async function mcpApiMiddleware(req, res, next) {
    const url = String(req.url || '').split('?')[0];
    if (url !== '/api/mcp') { next(); return; }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', async () => {
      await handle(req, res, Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      try { res.writeHead(400); res.end('{"ok":false,"error":"请求体读取失败"}'); } catch { /* ignore */ }
    });
  };
}
