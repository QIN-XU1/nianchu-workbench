#!/usr/bin/env node
/**
 * POST /api/plugin-run 的处理器（纯函数，不依赖 Vite / http 框架）。
 *
 * 为什么单独抽出来：
 *   ① 单元测试可以直接喂假 req/res，不需要起服务器
 *   ② Vite dev server 和预览服务器可以共用同一份实现（避免两处漂移）
 *
 * 独立审计指出的问题：产品 dev server 上 /api/plugin-run 是 404，
 * 端点只存在于本地预览服务器 ⇒ 「生产宿主没接」。这个文件就是接法。
 *
 * 安全边界（如实说，不是沙箱）：
 *   · 只接受 POST
 *   · **不接受客户端传插件路径** —— 根目录写死
 *   · 请求体不解析、不落盘
 *   · 同一时刻只允许一次执行（避免并发写证据文件）
 */
import { runPlugins } from '../plugin/run.mjs';

/**
 * @param {{ run?: typeof runPlugins }} [deps] 可注入，便于测试
 * @returns {(req: any, res: any) => Promise<boolean>} 返回 true 表示已处理
 */
export function createPluginRunHandler(deps = {}) {
  const run = deps.run || runPlugins;
  let running = false;

  return async function handle(req, res) {
    const send = (code, obj, extraHeaders = {}) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
        ...extraHeaders,
      });
      res.end(body);
    };

    if (req.method !== 'POST') {
      send(405, { ok: false, error: '只接受 POST' }, { allow: 'POST' });
      return true;
    }
    if (running) {
      send(429, { ok: false, error: '已有一次执行在进行中' });
      return true;
    }

    running = true;
    try {
      const out = await run({ writeEvidence: true });
      // 【第 94 轮修】原来恒 send(200, { ok:true, result: out })：
      // 但 run() 的返回里 kernelOk 可为 false、results[].ok 也可为 false
      // （CLI 侧 tools/plugin/run.mjs 就是按 `!kernelOk || results.some(!ok)` 判 exit 1 的）。
      // 于是插件真的跑失败了，HTTP 仍说 200 + ok:true —— 外层成功、内层失败。
      // 现在与 CLI 口径对齐：只要内核没激活或有插件失败，就返回 500 + 外层 ok:false。
      const failed = !!out && (out.kernelOk !== true
        || (Array.isArray(out.results) && out.results.some((x) => x.ok !== true)));
      if (failed) {
        const bad = (Array.isArray(out.results) ? out.results.filter((x) => x.ok !== true).map((x) => x.plugin) : []);
        send(500, {
          ok: false,
          at: new Date().toISOString(),
          error: out.kernelOk !== true ? '内核未激活' : '插件执行失败：' + bad.join(', '),
          result: out,
        });
        return true;
      }
      send(200, { ok: true, at: new Date().toISOString(), result: out });
    } catch (e) {
      send(500, { ok: false, error: String(e && e.message) });
    } finally {
      running = false;
    }
    return true;
  };
}

/** Vite 中间件形式：只在路径匹配时处理 */
export function createViteMiddleware(deps) {
  const handle = createPluginRunHandler(deps);
  return async function workbenchApiMiddleware(req, res, next) {
    const url = String(req.url || '').split('?')[0];
    if (url !== '/api/plugin-run') { next(); return; }
    await handle(req, res);
  };
}
