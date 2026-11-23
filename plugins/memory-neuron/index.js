/**
 * 记忆神经元 —— Host 侧
 *
 * 提供两个只读 JSON 路由：
 *   GET /memory-neuron/overview   场景总览（全部数据源合成）
 *   GET /memory-neuron/health     健康度与台账快照
 *
 * ══════════════════════════════════════════════════════════════
 *  API 依据（照抄已安装且能正常工作的 @wxg-prc-cpg/browser-skill-dsh-plugin）
 * ══════════════════════════════════════════════════════════════
 *
 *  ctx.inject(['webServer'], (injected) => {
 *    const webServer = injected.get('webServer');
 *    if (webServer === void 0) return () => {};   // 可选依赖必须判空
 *    webServer.register({ kind: 'exact', path, handler })  → 返回 disposer
 *  });
 *
 *  apply 不能有返回值：Cordis 把 apply 的返回值当 effect 解析，
 *  返回普通对象会 "Invalid effect" 导致整包激活失败。
 *
 * ══════════════════════════════════════════════════════════════
 *  已修正的 API 错误（曾导致 "web boot: 1 entry did not activate"）
 * ══════════════════════════════════════════════════════════════
 *
 *  × 错：把注入回调参数当 Cordis Scope，用 scope.effect / scope.webServer
 *    → Cannot read properties of undefined (reading 'effect')
 *    ✓ 对：injected 是「注入了依赖的派生 ctx」，服务用 injected.get(name) 取
 *
 *  × 错：kind: 'prefix'（会抢占整个前缀）
 *    ✓ 对：kind: 'exact'
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAll } from './loader.js';

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

export const ROUTE = '/memory-neuron';

// 缓存（5 秒 TTL，避免每次请求都全盘扫描）
let cache = null;
const TTL_MS = 5000;

async function getData(force) {
  const now = Date.now();
  if (!force && cache && now - cache.at < TTL_MS) return cache.value;
  const value = await loadAll(PLUGIN_DIR);
  cache = { at: now, value };
  return value;
}

export function apply(ctx) {
  ctx.inject(['webServer'], (injected) => {
    const webServer = injected.get('webServer');
    if (webServer === void 0) return () => {};

    const routes = [];

    // ── /overview ──
    routes.push(webServer.register({
      kind: 'exact',
      path: ROUTE + '/overview',
      handler: async (req, res) => {
        if (!isReadable(req, res)) return;
        if (rejected(injected, req, res)) return;
        try {
          const data = await getData(req.url && req.url.includes('force=1'));
          sendJson(res, 200, data, req.method === 'HEAD');
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }));

    // ── /health ──
    routes.push(webServer.register({
      kind: 'exact',
      path: ROUTE + '/health',
      handler: async (req, res) => {
        if (!isReadable(req, res)) return;
        if (rejected(injected, req, res)) return;
        try {
          const data = await getData(false);
          sendJson(res, 200, {
            ok: data.ok,
            counts: data.counts,
            coverage: data.coverage,
            health: data.shared && data.shared.health,
            dispatch: data.shared && data.shared.dispatch,
            evolution: data.shared && data.shared.evolution,
            todo: data.shared && data.shared.todo,
          }, req.method === 'HEAD');
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }));

    injected.effect(() => () => {
      for (const d of routes) {
        try { d(); } catch { /* ignore */ }
      }
    }, 'memory-neuron: 路由');
  });
}

function isReadable(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  res.writeHead(405, { allow: 'GET, HEAD' });
  res.end();
  return false;
}

/**
 * 复用 connection 的 Host/Origin 检查。
 * 取不到 connection 时保守放行（只读路由，监听在 loopback）。
 */
function rejected(ctx, req, res) {
  const connection = ctx.get('connection');
  if (connection === void 0) return false;
  if (typeof connection.requestRejection !== 'function') return false;
  const code = connection.requestRejection(req);
  if (code === undefined) return false;
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(code === 401 ? 'unauthorized' : 'forbidden');
  return true;
}

function sendJson(res, status, payload, headOnly = false) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(headOnly ? undefined : body);
}
