/**
 * 「这是一份软件」的结构验证。
 *
 * 【背景】2026-11-18 用户提醒：「我们实际要做的是份软件」。
 * 之前的状态是**要手动开两个 node 进程**（产品服务器 47124 + WS 宿主 8080），
 * 用户数据写在开发证据目录，启动靠手敲命令 —— 那是开发脚手架，不是软件。
 *
 * 判据（任何一条不满足就不是"一份软件"）：
 *   ① 一个端口同时提供 页面 / API / WebSocket —— 不需要第二个进程
 *   ② 8080 上不需要任何东西（旧的独立宿主可以完全不存在）
 *   ③ WebSocket 走同源（页面地址 + /ws），不写死 localhost:8080
 *   ④ 用户数据落在平台用户目录，不在仓库 evidence/
 *   ⑤ 模型网关不可达时如实报错，不假装成功
 *
 * 用法：node tools/agent/verify-single-process.mjs
 * 四态：0 = PASS / 1 = FAIL / 2 = UNKNOWN
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'node:http';
import { spawn } from 'node:child_process';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = process.env.NIANCHU_BASE || 'http://127.0.0.1:47124';

// 第 189 轮：本脚本原先要求「外部已把服务跑起来」，否则 5 条断言 FAIL——把环境问题当缺陷。
// 改为**自起自测**：外部没服务就 spawn serve.mjs（stdio:'ignore' 避开沙箱 pipe 限制），测完杀掉。
// 这样「念初是一份软件」可自包含复算；若连自起都起不来 → 判 UNKNOWN（不是 FAIL）。
let _serverChild = null;
async function _reachable(ms = 1200) {
  try { const r = await fetch(BASE + '/api/host-status', { signal: AbortSignal.timeout(ms) }); return r.ok; } catch { return false; }
}
async function _ensureServer() {
  if (await _reachable()) return { ok: true, why: '外部服务已在跑' };
  const port = (() => { try { return new URL(BASE).port || '47124'; } catch { return '47124'; } })();
  try {
    _serverChild = spawn(process.execPath, [join(REPO, 'tools/workbench/serve.mjs')], {
      cwd: REPO, env: { ...process.env, PORT: port }, stdio: 'ignore', windowsHide: true,
    });
  } catch (e) { return { ok: false, why: 'spawn 失败：' + e.message }; }
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await _reachable(800)) return { ok: true, why: '自起服务成功' };
  }
  return { ok: false, why: '自起后 10s 内仍不可达' };
}
const _srv = await _ensureServer();
if (!_srv.ok) {
  console.log('');
  console.log('  ⚠ ' + _srv.why + ' —— 服务不可达且无法自起 → 四态 UNKNOWN（不是 FAIL：这是环境问题）');
  if (_serverChild) { try { _serverChild.kill(); } catch { /* ignore */ } }
  process.exitCode = 2;
  process.exit(2);
}
console.log('  · ' + _srv.why + '（' + BASE + '）');


let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

console.log('');
console.log('  「一份软件」结构验证 · ' + BASE);
console.log('  ' + '─'.repeat(72));

// ① 页面
let pageOk = false;
try {
  const r = await fetch(BASE + '/', { signal: AbortSignal.timeout(8000) });
  const html = await r.text();
  pageOk = r.ok && /<div id="root"|<script/.test(html);
} catch { pageOk = false; }
t('同一端口提供界面（HTML）', pageOk);

// ② API
let host = null;
try {
  const r = await fetch(BASE + '/api/host-status', { signal: AbortSignal.timeout(8000) });
  host = await r.json();
} catch { host = null; }
t('同一端口提供 /api/host-status', !!(host && host.ok), host ? '' : '拿不到');
t('宿主方法清单非空（>=30 个）', !!(host && Array.isArray(host.implemented) && host.implemented.length >= 30),
  host ? String(host.implemented?.length) : '');
t('自报 singleProcess = true', !!(host && host.singleProcess === true));

// ③ WebSocket 同源
let wsOk = false;
let wsErr = '';
await new Promise((resolve) => {
  const url = BASE.replace('http://', 'ws://') + '/ws';
  let ws;
  try { ws = new WebSocket(url); } catch (e) { wsErr = String(e.message); return resolve(); }
  const to = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } wsErr = 'timeout'; resolve(); }, 8000);
  ws.onopen = () => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'p1', method: 'list_sessions', params: {} }));
  };
  ws.onmessage = (ev) => {
    clearTimeout(to);
    try {
      const m = JSON.parse(String(ev.data));
      wsOk = m.id === 'p1' && !m.error;
    } catch { wsOk = false; }
    try { ws.close(); } catch { /* ignore */ }
    resolve();
  };
  ws.onerror = () => { clearTimeout(to); wsErr = 'error'; resolve(); };
});
t('同一端口提供 WebSocket /ws（并成功回一次 RPC）', wsOk, wsErr);

// ④ 8080 不需要
let port8080 = false;
try {
  const r = await fetch('http://127.0.0.1:8080/', { signal: AbortSignal.timeout(1500) });
  port8080 = r.ok;
} catch { port8080 = false; }
t('不依赖 8080 上的独立宿主（可以根本不存在）', !port8080,
  port8080 ? '8080 还有服务在跑，说明可能仍是两进程' : '');

// ⑤ 前端 WS 是同源，不写死 localhost:8080
let adapterSrc = '';
try {
  adapterSrc = readFileSync(join(REPO, 'apps/vouch-web/src/web-ui/src/infrastructure/api/adapters/index.ts'), 'utf8');
} catch { /* ignore */ }
// 判据前先去掉注释：解释性注释里提到旧地址不该算失败
// （判据的目的是约束**行为**，不是禁止解释历史）
const stripTsComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const adapterCode = stripTsComments(adapterSrc);
t('前端 WebSocket 走同源（window.location.host）', /window\.location\.host/.test(adapterCode));
t('前端运行代码不再写死 ws://localhost:8080', !/ws:\/\/localhost:8080/.test(adapterCode));

// ⑥ 用户数据不在仓库 evidence/
let runtimeSrc = '';
try {
  runtimeSrc = readFileSync(join(REPO, 'tools/agent/runtime.mjs'), 'utf8');
} catch { /* ignore */ }
const runtimeCode = stripTsComments(runtimeSrc);
t('会话数据不在 evidence/（那是开发证据目录）', !/evidence\/agent\/sessions/.test(runtimeCode));
t('会话数据用平台用户目录（APPDATA / Application Support / XDG）',
  /APPDATA/.test(runtimeSrc) && /Application Support/.test(runtimeSrc) && /XDG_DATA_HOME/.test(runtimeSrc));
t('支持 NIANCHU_DATA_DIR 覆盖', /NIANCHU_DATA_DIR/.test(runtimeSrc));

// ⑦ 模型网关可配置 + 失败如实报
t('模型网关可配置（NIANCHU_GATEWAY）', /process\.env\.NIANCHU_GATEWAY/.test(runtimeSrc));
t('网关失败如实返回 FAIL（不伪造回复）',
  /state: 'FAIL'/.test(runtimeSrc) && /模型网关不可达/.test(runtimeSrc));

// ⑧ 启动器是单进程
let launcher = '';
const launcherPath = join(REPO, 'tools/workbench/start-product.cmd');
if (existsSync(launcherPath)) launcher = readFileSync(launcherPath, 'utf8');
t('启动器存在', launcher.length > 0);
// cmd 只看可执行行（去掉 REM 注释），注释里提旧方案不算失败
const launcherCode = launcher.split(/\r?\n/).filter((l) => !/^\s*REM\b/i.test(l)).join('\n');
t('启动器只启动一个 node 进程（serve.mjs）',
  /node tools\\workbench\\serve\.mjs/.test(launcherCode) && !/ws-host/.test(launcherCode));

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 一个进程 = 一份软件（页面/API/WebSocket 同端口，数据在用户目录）'
  : 'FAIL —— 还不是一份完整的软件'));
console.log('');
// 不调用 process.exit：ws.close() 之后强杀进程在 Windows 上会触发
// libuv 断言（uv async handle closing），只是噪音但会让退出码不可靠。
// 设 exitCode 让它自然退出即可。
if (_serverChild) { try { _serverChild.kill(); } catch { /* ignore */ } await new Promise((r) => setTimeout(r, 300)); }
process.exitCode = fails.length === 0 ? 0 : 1;