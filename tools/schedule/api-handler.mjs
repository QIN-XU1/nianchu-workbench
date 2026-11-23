#!/usr/bin/env node
/**
 * 调度器的产品接线：常驻 tick + POST /api/scheduler/tick。
 *
 * 独立审计判 A11「部分」的理由是：「daemon 没人启动；jobs.json 只有 3 job / 4 run，
 * 最后一次是手动 run」—— cron 解析器是真的，但**没有进程按时触发它**。
 *
 * 这个文件让 dev server 启动时自动开始 tick（默认 60s），
 * 并提供一个端点让界面/脚本手动触发一次。这样「按时触发」真的发生了。
 *
 * 边界如实说：这是 dev server 内的定时器，不是系统计划任务；
 * 进程一停就不 tick 了。生产要用真正的守护进程（systemd / 计划任务）。
 */
import { tickOnce } from './tick.mjs';

/** 启动常驻 tick。返回 stop() */
export function startSchedulerDaemon({ intervalMs = 60000, onTick = null, runJob = undefined } = {}) {
  let stopped = false;
  let timer = null;
  let ticks = 0;
  const last = { at: null, due: 0, ran: [] };

  const loop = async () => {
    if (stopped) return;
    ticks++;
    try {
      const r = await tickOnce(runJob ? { runJob } : {});
      last.at = r.at;
      last.due = r.due;
      last.ran = r.ran;
      if (onTick) onTick(r);
    } catch (e) {
      // 一次 tick 失败不能停掉整个常驻循环
      last.at = new Date().toISOString();
      last.due = -1;
      last.ran = [{ name: '(tick 失败)', state: 'FAIL', why: String(e && e.message), ms: 0 }];
      if (onTick) onTick({ error: String(e && e.message) });
    }
    if (!stopped) timer = setTimeout(loop, intervalMs);
  };

  loop();

  return {
    stop() { stopped = true; if (timer) clearTimeout(timer); },
    stats() { return { ticks, intervalMs, last }; },
  };
}

/** POST /api/scheduler/tick 处理器 */
export function createSchedulerHandler(deps = {}) {
  const run = deps.tickOnce || tickOnce;
  let busy = false;
  return async function handle(req, res) {
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
    if (busy) { send(429, { ok: false, error: '已有一次 tick 在进行中' }); return true; }
    busy = true;
    try {
      const r = await run();
      send(200, { ok: true, ...r });
    } catch (e) {
      send(500, { ok: false, error: String(e && e.message) });
    } finally {
      busy = false;
    }
    return true;
  };
}

/** Vite 中间件形式 */
export function createSchedulerMiddleware(deps) {
  const handle = createSchedulerHandler(deps);
  return async function schedulerApiMiddleware(req, res, next) {
    const url = String(req.url || '').split('?')[0];
    if (url !== '/api/scheduler/tick') { next(); return; }
    await handle(req, res);
  };
}
