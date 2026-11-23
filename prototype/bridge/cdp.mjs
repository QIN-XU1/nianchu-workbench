/**
 * CDP 最小客户端（零依赖，用 Node 24 内置 WebSocket）
 *
 * 为什么要自己写：本机没有 puppeteer / playwright。
 * CDP = Chrome DevTools Protocol，标准 HTTP + WebSocket，不需要任何 npm 包。
 *
 * 能力边界（必须诚实）：
 *   - 只能连**已经启动带 --remote-debugging-port** 的 Chrome
 *   - 不能启动/关闭用户正在用的 Chrome（那会打断人家）
 *   - 需要用户先手动登录一次，我们复用 profile
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_PORT = 9222;

/** 探测 CDP 是否可用 */
export async function probe(port = DEFAULT_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, browser: data.Browser, webSocketDebuggerUrl: data.webSocketDebuggerUrl };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

/** 列出标签页 */
export async function listTargets(port = DEFAULT_PORT) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const all = await res.json();
  return all.filter(t => t.type === 'page');
}

/** 极简 CDP 连接 */
export class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('CDP 连接超时（5s）')), 5000);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(this);
      });
      ws.addEventListener('error', (ev) => {
        clearTimeout(timer);
        reject(new Error('CDP 连接失败'));
      });
      ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
          else res(msg.result);
        } else if (msg.method) {
          this.events.push(msg);
        }
      });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} 超时`));
        }
      }, 30000);
    });
  }

  /** 在页面里跑 JS，返回结果 */
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails;
      const desc = ex.exception?.description
        || ex.exception?.value
        || ex.text
        || '(无描述)';
      // 取页面里报错的第一行（通常是 "TypeError: xxx is not a function"）
      const firstLine = String(desc).split('\n')[0];
      throw new Error(`页面脚本异常：${firstLine}`);
    }
    return r.result?.value;
  }

  /** 关闭连接：等待 socket 真正关闭，避免 Node 退出时 libuv 断言崩溃 */
  async close() {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    try {
      // 先清空 pending，避免悬挂 Promise
      for (const { reject } of this.pending.values()) {
        try { reject(new Error('CDP 已关闭')); } catch { /* ignore */ }
      }
      this.pending.clear();
      if (ws.readyState === 1 /* OPEN */ || ws.readyState === 2 /* CLOSING */) {
        await new Promise((resolve) => {
          let done = false;
          const fin = () => { if (!done) { done = true; resolve(); } };
          try { ws.addEventListener('close', fin); } catch { /* ignore */ }
          try { ws.close(); } catch { /* ignore */ }
          setTimeout(fin, 1000);   // 兜底，不无限等
        });
      }
    } catch { /* ignore */ }
  }
}

export { DEFAULT_PORT };
