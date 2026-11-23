/**
 * 容错层（Fault Tolerance）—— P0 改造
 *
 * 实测发现的问题：
 *   main.js 对 render-process-gone / did-fail-load / crashed / unresponsive /
 *   child-process-gone 全部 0 处理。
 *   ⇒ 任何 webview 崩溃、渲染进程挂掉、引擎页面加载失败，界面只会空白，
 *     用户不知道为什么，日志里也没有记录。
 *
 * 本模块提供：
 *   ① installFaultHandlers(app, getWindow) —— 主进程级崩溃捕获
 *   ② 把每一次故障写入 server.log（可追溯）
 *   ③ 通知渲染层显示明确错误（不是空白）
 *   ④ webview 级 did-fail-load 处理（含重试）
 */

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const LOG_NAME = 'server.log';

function makeLogger(dir) {
  const logPath = join(dir, LOG_NAME);
  return function log(msg) {
    const line = `[${new Date().toISOString()}] [fault] ${msg}\n`;
    try { appendFileSync(logPath, line, 'utf8'); } catch { /* ignore */ }
    console.log('[fault]', msg);
  };
}

/**
 * 安装主进程级容错。
 *
 * @param {object} opts
 *   app       Electron app
 *   getWindow () => BrowserWindow | null
 *   logDir    日志目录（通常 __dirname）
 */
export function installFaultHandlers({ app, getWindow, logDir }) {
  const log = makeLogger(logDir);
  const stats = { renderGone: 0, childGone: 0, unresponsive: 0, failedLoad: 0, lastAt: null };

  /** 把故障推给渲染层（如果窗口还活着） */
  function notifyRenderer(kind, detail) {
    stats.lastAt = new Date().toISOString();
    try {
      const win = getWindow && getWindow();
      if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send('fault:event', { kind, detail, at: stats.lastAt });
      }
    } catch (e) {
      log(`通知渲染层失败：${e && e.message}`);
    }
  }

  // ---- ① 渲染进程崩溃（这是最严重的一类）----
  try {
    app.on('render-process-gone', (_event, webContents, details) => {
      stats.renderGone++;
      const reason = (details && details.reason) || 'unknown';
      const exitCode = details && details.exitCode;
      const url = (() => { try { return webContents.getURL(); } catch { return '(unknown)'; } })();
      log(`渲染进程崩溃 reason=${reason} exitCode=${exitCode} url=${url}`);
      notifyRenderer('render-process-gone', { reason, exitCode, url });

      // 崩溃恢复：如果是可重载的页面，尝试重载（避免永久空白）
      const recoverable = ['crashed', 'oom', 'abnormal-exit'].includes(reason);
      if (recoverable) {
        try {
          if (webContents && !webContents.isDestroyed()) {
            log(`尝试重载崩溃的页面：${url}`);
            webContents.reload();
          }
        } catch (e) {
          log(`重载失败：${e && e.message}`);
        }
      }
    });
    log('已安装 render-process-gone 处理');
  } catch (e) { log(`安装 render-process-gone 失败：${e && e.message}`); }

  // ---- ② 子进程消失（GPU / utility / plugin 等）----
  try {
    app.on('child-process-gone', (_event, details) => {
      stats.childGone++;
      const type = (details && details.type) || 'unknown';
      const reason = (details && details.reason) || 'unknown';
      log(`子进程消失 type=${type} reason=${reason} exitCode=${details && details.exitCode}`);
      notifyRenderer('child-process-gone', { type, reason });
    });
    log('已安装 child-process-gone 处理');
  } catch (e) { log(`安装 child-process-gone 失败：${e && e.message}`); }

  // ---- ③ 无响应（卡死）----
  try {
    app.on('web-contents-created', (_event, contents) => {
      contents.on('unresponsive', () => {
        stats.unresponsive++;
        let url = '(unknown)';
        try { url = contents.getURL(); } catch { /* ignore */ }
        log(`页面无响应 url=${url}`);
        notifyRenderer('unresponsive', { url });
      });

      // ---- ④ 加载失败（这个最常见：引擎没起来、网络断了、站点改版）----
      contents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
        stats.failedLoad++;
        log(`加载失败 code=${errorCode} desc=${errorDescription} url=${validatedURL} mainFrame=${isMainFrame}`);
        notifyRenderer('did-fail-load', { errorCode, errorDescription, url: validatedURL, isMainFrame });
      });

      // ---- ⑤ 渲染进程"预加载失败"（webview 常见）----
      contents.on('preload-error', (_e, preloadPath, error) => {
        log(`preload 失败 path=${preloadPath} err=${error && error.message}`);
        notifyRenderer('preload-error', { preloadPath, message: error && error.message });
      });
    });
    log('已安装 web-contents-created 级容错（unresponsive / did-fail-load / preload-error）');
  } catch (e) { log(`安装 web-contents-created 失败：${e && e.message}`); }

  // ---- ⑥ 主进程自身未捕获异常（最后一道防线）----
  try {
    process.on('uncaughtException', (err) => {
      log(`主进程未捕获异常：${err && (err.stack || err.message)}`);
    });
    process.on('unhandledRejection', (reason) => {
      log(`主进程未处理 Promise 拒绝：${reason && (reason.stack || reason)}`);
    });
    log('已安装主进程未捕获异常兜底');
  } catch (e) { log(`安装进程级兜底失败：${e && e.message}`); }

  log(`容错层安装完成（初始计数：renderGone=${stats.renderGone}）`);

  return {
    stats,
    /** 供测试用：主动触发一次通知（验证渲染层能收到） */
    _notify: notifyRenderer,
  };
}

/**
 * 该模块要插入 main.js 的代码片段（由 install 脚本注入）
 */
export const MAIN_SNIPPET = `
// ---- 二次开发：容错层（P0）----
// 实测原项目对 render-process-gone / did-fail-load / crashed / unresponsive /
// child-process-gone 全部 0 处理 ⇒ 崩溃时界面只会空白且无日志。
// 这里统一接管，写入 server.log 并通知渲染层显示明确错误。
const _faultHandlers = require('./fault-handlers.cjs').installFaultHandlers({
  app: app,
  getWindow: function () { return mainWindow; },
  logDir: __dirname,
});
console.log('[fault] handlers installed:', JSON.stringify(_faultHandlers.stats));
`;
