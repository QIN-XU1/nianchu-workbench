/**
 * 工作台启动器 —— Host 侧
 *
 * 职责：
 *   ① 探测当前 DSH 引擎的 token + 端口（通过 ctx.connection.authenticatedUrl）
 *   ② 拉起 Electron 工作台，把这些通过环境变量传进去
 *   ③ 报告状态（未启动 / 运行中 / PID）
 *   ④ 已启动时「切到前面」
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么这样做（方案 112）
 * ══════════════════════════════════════════════════════════════
 *
 *  DSH Harness（当前）
 *    └── 引擎在 31582，token 由 Harness 内部持有
 *              ↑
 *              │ 传 token + port
 *              │
 *  工作台（Electron）— 3D 神经记忆元 + 9 场景 + 面板
 *
 *  一套引擎、数据互通。不是在 DSH 里重建面板，
 *  而是给它开一扇通往老项目的门。
 *
 * ══════════════════════════════════════════════════════════════
 *  启动参数（从之前的调试经验得来，每条都是踩过坑的）
 * ══════════════════════════════════════════════════════════════
 *
 *  DSH_ENGINE_TOKEN   从 authenticatedUrl 解析 —— 工作台靠它调引擎
 *  DSH_PORT           同上 —— 引擎端口
 *  DSH_FRONTEND=v2    不设会用旧前端（实测）
 *  ELECTRON_RUN_AS_NODE  必须清空 —— 否则 electron 以纯 Node 运行，起不来窗口
 *  --disable-gpu 系列   本机 GPU 有问题（崩溃分析报告里有）
 */

import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

export const ROUTE = '/workbench-launcher';

// ══════════════════════════════════════════════════════════════
//  状态（进程级，插件重载会重置）
// ══════════════════════════════════════════════════════════════
const state = {
  child: null,        // ChildProcess
  pid: null,
  startedAt: null,
  lastError: null,
  launches: 0,        // 累计启动次数
};

// ══════════════════════════════════════════════════════════════
//  找工作台目录
// ══════════════════════════════════════════════════════════════
async function findWorkbench() {
  // 从插件目录逐级往上找 workbench/外壳
  const candidates = [];
  let dir = resolve(PLUGIN_DIR);
  for (let i = 0; i < 6; i++) {
    candidates.push(join(dir, 'workbench', '外壳'));
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  // 也查 cwd
  candidates.push(join(process.cwd(), 'workbench', '外壳'));

  for (const c of candidates) {
    const electron = join(c, 'node_modules', 'electron', 'dist', 'electron.exe');
    const mainJs = join(c, 'main.js');
    if (existsSync(electron) && existsSync(mainJs)) {
      return {
        shellDir: c,
        electron,
        mainJs,
        ok: true,
      };
    }
  }
  return {
    ok: false,
    error: '找不到工作台目录（需要 workbench/外壳/{main.js, node_modules/electron/dist/electron.exe}）',
    searched: candidates.slice(0, 6),
  };
}

// ══════════════════════════════════════════════════════════════
//  从 DSH 拿 token + 端口
// ══════════════════════════════════════════════════════════════
function getEngineCredential(ctx, webServer) {
  const out = { ok: false };

  // 端口
  let origin = null;
  try {
    origin = webServer.getOrigin();
    out.origin = origin;
  } catch (e) {
    out.originError = String(e?.message ?? e);
  }

  // token（通过 authenticatedUrl）
  const connection = ctx.get('connection');
  if (!connection || typeof connection.authenticatedUrl !== 'function') {
    out.error = 'connection.authenticatedUrl 不可用';
    return out;
  }

  const base = (typeof origin === 'string' && origin.startsWith('http'))
    ? origin
    : 'http://127.0.0.1:3080';

  try {
    const authUrl = connection.authenticatedUrl(base);
    out.authUrl = authUrl;
    const u = new URL(authUrl);
    const token = u.searchParams.get('token');
    if (!token) {
      out.error = 'authenticatedUrl 里没有 token';
      return out;
    }
    out.ok = true;
    out.port = u.port || '80';
    out.token = token;
    return out;
  } catch (e) {
    out.error = 'authenticatedUrl 抛错: ' + String(e?.message ?? e);
    return out;
  }
}

// ══════════════════════════════════════════════════════════════
//  启动工作台
// ══════════════════════════════════════════════════════════════
async function launchWorkbench(ctx, webServer, opts) {
  const o = opts || {};

  // 已启动 → 切到前面
  if (state.child && state.pid && !state.child.killed) {
    try {
      // Windows: 用 PowerShell 把窗口提到前台
      await new Promise((res) => {
        execFile('powershell', [
          '-NoProfile', '-Command',
          `$p = Get-Process -Id ${state.pid} -ErrorAction SilentlyContinue; if ($p) { $h = $p.MainWindowHandle; if ($h -ne 0) { Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W{[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);}'; [W]::SetForegroundWindow($h) } }`,
        ], { timeout: 5000 }, () => res());
      });
      return { ok: true, action: 'focus', pid: state.pid };
    } catch (e) {
      return { ok: true, action: 'already-running', pid: state.pid };
    }
  }

  // 找路
  const wb = await findWorkbench();
  if (!wb.ok) return wb;

  // 拿凭据
  const cred = getEngineCredential(ctx, webServer);
  if (!cred.ok) {
    return {
      ok: false,
      error: '拿不到引擎凭据: ' + (cred.error || '未知'),
      probe: cred,
    };
  }

  // 构造环境变量
  const env = Object.assign({}, process.env, {
    DSH_ENGINE_TOKEN: cred.token,
    DSH_PORT: cred.port,
    DSH_FRONTEND: 'v2',
    DSH_SHELL_DIR: wb.shellDir,
  });
  // ★ 必须清空，否则 electron 以纯 Node 运行，不起窗口
  delete env.ELECTRON_RUN_AS_NODE;

  // spawn
  const args = [
    '.',
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--no-sandbox',
  ];

  let child;
  try {
    child = spawn(wb.electron, args, {
      cwd: wb.shellDir,
      env,
      detached: true,      // 独立于 DSH，DSH 退出不影响它
      stdio: 'ignore',     // 不继承 stdio，避免管道问题
      windowsHide: false,  // 要窗口
    });
    child.unref();         // 不阻塞 DSH 退出
  } catch (e) {
    state.lastError = String(e?.message ?? e);
    return { ok: false, error: 'spawn 失败: ' + state.lastError };
  }

  state.child = child;
  state.pid = child.pid;
  state.startedAt = new Date().toISOString();
  state.launches += 1;
  state.lastError = null;

  child.on('exit', (code, signal) => {
    // 只清状态，不报错（正常关闭也会走到这）
    if (state.child === child) {
      state.child = null;
      state.pid = null;
      state.lastError = code === 0 || signal ? null : 'exited code=' + code;
    }
  });
  child.on('error', (e) => {
    state.lastError = String(e?.message ?? e);
    state.child = null;
    state.pid = null;
  });

  return {
    ok: true,
    action: 'launched',
    pid: state.pid,
    engine: {
      port: cred.port,
      tokenLength: cred.token.length,
    },
    workbench: {
      shellDir: wb.shellDir,
    },
  };
}

// ══════════════════════════════════════════════════════════════
//  插件入口
// ══════════════════════════════════════════════════════════════
export function apply(ctx) {
  ctx.inject(['webServer'], (injected) => {
    const webServer = injected.get('webServer');
    if (webServer === void 0) return () => {};

    const disposers = [];

    // ── GET /status：当前状态 ──
    disposers.push(webServer.register({
      kind: 'exact',
      path: ROUTE + '/status',
      handler: async (req, res) => {
        const connection = ctx.get('connection');
        let engineOk = false;
        let enginePort = null;
        try {
          const origin = webServer.getOrigin();
          enginePort = new URL(origin).port;
          engineOk = !!connection;
        } catch { /* ignore */ }

        const wb = await findWorkbench();

        sendJson(res, 200, {
          ok: true,
          running: !!(state.child && state.pid),
          pid: state.pid,
          startedAt: state.startedAt,
          launches: state.launches,
          lastError: state.lastError,
          engine: { ok: engineOk, port: enginePort },
          workbench: wb.ok
            ? { ok: true, shellDir: wb.shellDir }
            : { ok: false, error: wb.error },
        });
      },
    }));

    // ── POST /launch：启动 ──
    disposers.push(webServer.register({
      kind: 'exact',
      path: ROUTE + '/launch',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' });
          res.end();
          return;
        }
        try {
          const result = await launchWorkbench(ctx, webServer);
          sendJson(res, result.ok ? 200 : 500, result);
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
        }
      },
    }));

    injected.effect(() => () => {
      for (const d of disposers) { try { d(); } catch { /* ignore */ } }
      // 不杀工作台：它是独立进程，DSH 卸载插件不该关掉它
    }, 'workbench-launcher: 路由');
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}
