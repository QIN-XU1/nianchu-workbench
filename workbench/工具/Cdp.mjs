#!/usr/bin/env node
/**
 * CDP 直连渲染进程 —— 不需要点击，直接执行 JS
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么需要这个（极其重要）
 * ══════════════════════════════════════════════════════════════
 *
 *  我在验证「点击文件 → 右侧显示 Markdown」时，卡了很久：
 *    · 截图看到文件列表了，但点不动
 *    · 没有 click 日志（console-message 转发是我后来才加的）
 *    · 只能靠猜：坐标对不对？事件绑定了吗？body 高度塌陷了？
 *
 *  **真正的解法是：直接在渲染进程里执行 JS，看真实状态。**
 *
 *  启动时带 --inspect-electron <port>，主进程会开
 *  remote-debugging-port → 然后用 CDP 连上去。
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/Cdp.mjs --eval "document.title"
 *  node 工具/Cdp.mjs --click ".rv-item"       按选择器点击
 *  node 工具/Cdp.mjs --dump                   看页面上有什么
 *
 * ══════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import http from 'node:http';

const PORT = process.env.CDP_PORT || '9333';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/** 找渲染进程的 target */
async function listTargets() {
  const raw = await httpGet('http://127.0.0.1:' + PORT + '/json/list');
  return JSON.parse(raw);
}

/** 用 CDP WebSocket 执行 JS */
async function evalJs(expr) {
  const targets = await listTargets();
  // 只处理 page 类型（渲染进程）
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) {
    throw new Error('找不到渲染进程 target。可用的: ' +
      targets.map((t) => t.type + ':' + (t.title || t.url || '').slice(0, 30)).join(' | '));
  }

  // Node 24 有全局 WebSocket
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const id = 1;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error('CDP 超时')); }, 20000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: {
          expression: expr,
          returnByValue: true,
          awaitPromise: true,
        },
      }));
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== id) return;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      if (msg.error) { reject(new Error(JSON.stringify(msg.error))); return; }
      const r = msg.result;
      if (r && r.exceptionDetails) {
        reject(new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400)));
        return;
      }
      resolve(r && r.result ? r.result.value : undefined);
    };

    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('WebSocket 错误（端口 ' + PORT + ' 可能没开）'));
    };
  });
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

if (has('--targets')) {
  const t = await listTargets();
  console.log(JSON.stringify(t.map((x) => ({ type: x.type, title: x.title, url: x.url })), null, 2));
} else if (has('--eval')) {
  const r = await evalJs(val('--eval'));
  console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2));
} else if (has('--dump')) {
  const r = await evalJs(`(function(){
    return {
      title: document.title,
      bodyChildren: [...document.body.children].map(function(e){ return e.tagName + '.' + (e.className||''); }),
      panels: [...document.querySelectorAll('[class*=panel]')].slice(0,10).map(function(e){
        const r = e.getBoundingClientRect();
        return { cls: e.className, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      }),
      rvItems: [...document.querySelectorAll('.rv-item')].map(function(e){
        const r = e.getBoundingClientRect();
        return { name: e.getAttribute('data-name'), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      }),
      rvBound: !!(document.querySelector('.rv-item') && document.querySelector('.rv-item').closest('[class]')),
    };
  })()`);
  console.log(JSON.stringify(r, null, 2));
} else if (has('--click')) {
  const sel = val('--click');
  const r = await evalJs(`(function(){
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return { ok:false, err:'找不到 ' + ${JSON.stringify(sel)} };
    const rect = el.getBoundingClientRect();
    el.click();
    return {
      ok: true,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      rightHtmlLen: (function(){
        const all = [...document.querySelectorAll('div')];
        const right = all.find(function(d){ return d.style && d.style.overflow === 'auto' && d.style.padding; });
        return right ? right.innerHTML.length : -1;
      })(),
    };
  })()`);
  console.log(JSON.stringify(r, null, 2));
} else {
  console.log('用法:');
  console.log('  node 工具/Cdp.mjs --targets           列出可调试的 target');
  console.log('  node 工具/Cdp.mjs --eval "<js>"       执行 JS');
  console.log('  node 工具/Cdp.mjs --dump              看页面结构');
  console.log('  node 工具/Cdp.mjs --click "<选择器>"   点击元素');
  console.log();
  console.log('⚠ 需要启动时带 --inspect-electron ' + PORT + '（或在 启动.ps1 里设 SEA_DEBUG_PORT）');
}
