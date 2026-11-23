/**
 * 容错层（Fault Tolerance）—— P0 改造
 *
 * 实测发现的问题：
 *   main.js 对 render-process-gone / did-fail-load / crashed / unresponsive /
 *   child-process-gone 全部 0 处理。
 *   ⇒ 任何 webview 崩溃、渲染进程挂掉、引擎页面加载失败，界面只会空白，
 *     用户不知道为什么，日志里也没有记录。
 *
 * 本模块：
 *   ① 捕获 5 类崩溃/失败事件
 *   ② 全部写入 server.log（可追溯）
 *   ③ 通知渲染层显示明确错误（不是空白）
 *   ④ 可恢复的尝试自动重载
 *
 * CommonJS（main.js 是 CJS）
 */

'use strict';

const fs = require('fs');
const path = require('path');

function makeLogger(logDir) {
  const logPath = path.join(logDir, 'server.log');
  return function log(msg) {
    const line = '[' + new Date().toISOString() + '] [fault] ' + msg + '\n';
    try { fs.appendFileSync(logPath, line, 'utf8'); } catch (e) { /* ignore */ }
    try { console.log('[fault]', msg); } catch (e) { /* ignore */ }
  };
}

/**
 * 安装主进程级容错。
 * @param {object} opts { app, getWindow, logDir }
 */
function installFaultHandlers(opts) {
  opts = opts || {};
  const app = opts.app;
  const getWindow = opts.getWindow || function () { return null; };
  const logDir = opts.logDir || process.cwd();
  const log = makeLogger(logDir);

  const stats = {
    renderGone: 0,
    childGone: 0,
    unresponsive: 0,
    failedLoad: 0,
    preloadError: 0,
    uncaught: 0,
    unhandled: 0,
    lastAt: null,
    events: [],
  };

  const MAX_EVENTS = 50;

  function record(kind, detail) {
    stats.lastAt = new Date().toISOString();
    stats.events.push({ kind: kind, detail: detail, at: stats.lastAt });
    if (stats.events.length > MAX_EVENTS) stats.events.shift();
    log(kind + ' ' + JSON.stringify(detail));
    // 通知渲染层（窗口还活着才发）
    try {
      const win = getWindow();
      if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send('fault:event', { kind: kind, detail: detail, at: stats.lastAt });
      }
    } catch (e) {
      log('通知渲染层失败：' + (e && e.message));
    }
  }

  if (!app || typeof app.on !== 'function') {
    log('installFaultHandlers：app 无效，跳过');
    return { stats: stats, ok: false };
  }

  // ---- ① 渲染进程崩溃（最严重）----
  try {
    app.on('render-process-gone', function (_event, webContents, details) {
      stats.renderGone++;
      const reason = (details && details.reason) || 'unknown';
      const exitCode = details && details.exitCode;
      let url = '(unknown)';
      try { url = webContents && webContents.getURL ? webContents.getURL() : url; } catch (e) { /* ignore */ }
      record('render-process-gone', { reason: reason, exitCode: exitCode, url: url });

      // 可恢复的尝试重载，避免永久空白
      const recoverable = reason === 'crashed' || reason === 'oom' || reason === 'abnormal-exit';
      if (recoverable && webContents && !webContents.isDestroyed()) {
        try {
          log('尝试重载崩溃页面：' + url);
          setTimeout(function () {
            try { if (!webContents.isDestroyed()) webContents.reload(); } catch (e) { /* ignore */ }
          }, 1500);
        } catch (e) { /* ignore */ }
      }
    });
    log('已安装 render-process-gone');
  } catch (e) { log('安装 render-process-gone 失败：' + (e && e.message)); }

  // ---- ② 子进程消失（GPU / utility / plugin）----
  try {
    app.on('child-process-gone', function (_event, details) {
      stats.childGone++;
      record('child-process-gone', {
        type: (details && details.type) || 'unknown',
        reason: (details && details.reason) || 'unknown',
        exitCode: details && details.exitCode,
      });
    });
    log('已安装 child-process-gone');
  } catch (e) { log('安装 child-process-gone 失败：' + (e && e.message)); }

  // ---- ③④⑤ webContents 级：无响应 / 加载失败 / preload 失败 ----
  try {
    app.on('web-contents-created', function (_event, contents) {
      try {
        contents.on('unresponsive', function () {
          stats.unresponsive++;
          let url = '(unknown)';
          try { url = contents.getURL(); } catch (e) { /* ignore */ }
          record('unresponsive', { url: url });
        });
      } catch (e) { /* ignore */ }

      try {
        contents.on('did-fail-load', function (_e, errorCode, errorDescription, validatedURL, isMainFrame) {
          // -3 是 ABORTED（用户主动导航取消），不算故障
          if (errorCode === -3) return;
          stats.failedLoad++;
          record('did-fail-load', {
            errorCode: errorCode,
            errorDescription: errorDescription,
            url: validatedURL,
            mainFrame: !!isMainFrame,
          });
        });
      } catch (e) { /* ignore */ }

      try {
        contents.on('preload-error', function (_e, preloadPath, error) {
          stats.preloadError++;
          record('preload-error', { preloadPath: preloadPath, message: error && error.message });
        });
      } catch (e) { /* ignore */ }
    });
    log('已安装 web-contents-created 级容错');
  } catch (e) { log('安装 web-contents-created 失败：' + (e && e.message)); }

  // ---- ⑥ 主进程自身兜底 ----
  try {
    process.on('uncaughtException', function (err) {
      stats.uncaught++;
      record('uncaughtException', {
        message: err && err.message,
        stack: err && err.stack ? String(err.stack).split('\n').slice(0, 4).join(' | ') : '',
      });
    });
    process.on('unhandledRejection', function (reason) {
      stats.unhandled++;
      record('unhandledRejection', {
        message: String((reason && reason.message) || reason).slice(0, 300),
      });
    });
    log('已安装主进程未捕获异常兜底');
  } catch (e) { log('安装进程级兜底失败：' + (e && e.message)); }

  log('容错层安装完成');

  return {
    ok: true,
    stats: stats,
    /** 测试用：主动触发一次通知 */
    _notify: record,
  };
}

module.exports = { installFaultHandlers: installFaultHandlers };
