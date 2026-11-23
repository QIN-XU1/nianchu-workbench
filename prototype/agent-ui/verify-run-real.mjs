#!/usr/bin/env node
/**
 * 「直接拿源码直接用」—— 验收
 *
 * 用户的要求：不要仿照，直接拿源码用。
 * 所以这里验的不是"像不像"，而是**跑起来的是不是它自己的前端产物**：
 *
 *   1. 真前端产物在不在（D:\OpenBitFun\frontend\dist，89.1MB / 2740 文件）
 *      —— 这是安装包解出来的东西，不是我写的
 *   2. 起服务 + IPC shim 后，DOM 里有没有它自己的中文文案
 *      （搜索一切 / 首页 / 任务看板 / 会话 / 暂无项目或助理 / 这台 Windows / Hi）
 *   3. 是否真的执行了它的 IPC 调用（说明我们跑的是它的 React 代码，不是我的 HTML）
 *   4. 截图证据
 *
 * 四态：没装 app / 没浏览器 → UNKNOWN(退出 2)，不当成通过。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const RUNNER = path.join(REPO, 'prototype/agent-ui/run-real.mjs');
const DIST = 'D:/OpenBitFun/frontend/dist';

let pass = 0, fail = 0, unknown = 0;
const I = { ok: '✓', no: '✗', un: '❔' };
const ok = (c, m) => { if (c) { pass++; console.log('  ' + I.ok + ' ' + m); } else { fail++; console.log('  ' + I.no + ' ' + m); } return c; };
const un = (m) => { unknown++; console.log('  ' + I.un + ' ' + m); };

console.log('');
console.log('  「直接拿源码直接用」—— 运行真实 OpenBitFun 前端产物');
console.log('  ' + '─'.repeat(74));

// ── 1. 真产物在不在 ──
if (!fs.existsSync(DIST)) {
  un('本机没装 OpenBitFun（缺 ' + DIST + '）—— 判不了，不当成通过');
  console.log('\n  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown + '\n');
  process.exit(unknown ? 2 : 1);
}
const idx = path.join(DIST, 'index.html');
const cssDir = path.join(DIST, 'assets');
ok(fs.existsSync(idx), '真前端入口在位（' + DIST + '/index.html）');
const files = fs.readdirSync(cssDir).filter((f) => /\.(js|css)$/.test(f));
const bigCss = fs.readdirSync(cssDir).filter((f) => /^index-.*\.css$/.test(f));
const bigJs = fs.readdirSync(cssDir).filter((f) => /^index-.*\.js$/.test(f));
ok(files.length > 100, 'assets 里有 ' + files.length + ' 个 js/css（真实构建产物）');
ok(bigCss.length > 0 && bigJs.length > 0, '主包在位：' + bigCss.join(',') + ' / ' + bigJs.join(','));
const html = fs.readFileSync(idx, 'utf8');
ok(/data-openbitfun-design-system-root/.test(html), 'index.html 带 design-system-root（它自己的启动逻辑会设置）');
ok(/\/assets\/index-[A-Za-z0-9_-]+\.js/.test(html), 'index.html 引用的是它自己的主包，不是我们的脚本');
ok(/openbitfun-desktop|OpenBitFun/.test(html), 'index.html 是 OpenBitFun 的（标题/文案可辨）');

// ── 2. runner 与 shim ──
ok(fs.existsSync(RUNNER), '运行器 run-real.mjs 在位');
const run = fs.existsSync(RUNNER) ? fs.readFileSync(RUNNER, 'utf8') : '';
ok(/__TAURI_INTERNALS__/.test(run), 'shim 提供 __TAURI_INTERNALS__（让真前端以为在 Tauri 里）');
ok(/get_config/.test(run) && /openedWorkspaces/.test(run), 'shim 的返回值形状按真实消费方补过（get_config.state / openedWorkspaces）');
ok(/frontend\/dist/.test(run) || /OpenBitFun/.test(run), '运行器指向安装目录的真产物');

// ── 3. 真跑一遍 ──
function findBrowser() {
  return ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p)) || null;
}
const browser = findBrowser();
console.log('');
if (!browser) {
  un('没有 Edge/Chrome，跑不起来 —— 判不了');
} else {
  console.log('  ' + I.ok + ' 找到浏览器: ' + path.basename(browser));
  pass++;
  const PORT = 47813;
  const tmp = path.join(os.tmpdir(), 'rr-' + process.pid);
  fs.mkdirSync(tmp, { recursive: true });

  // 起服务
  const child = spawn(process.execPath, [RUNNER], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false;
  await new Promise((res) => {
    const t = setTimeout(res, 8000);
    child.stdout.on('data', (b) => { if (String(b).includes('READY')) { ready = true; clearTimeout(t); res(); } });
  });
  ok(ready, '服务已就绪 http://127.0.0.1:' + PORT + '/');

  let dom = '';
  try {
    dom = execFileSync(browser, ['--headless', '--disable-gpu', '--no-sandbox',
      '--user-data-dir=' + path.join(tmp, 'p'), '--virtual-time-budget=16000',
      '--dump-dom', 'http://127.0.0.1:' + PORT + '/'], { encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { dom = (e.stdout || '') + ''; }
  child.kill();

  // 它自己的中文文案 —— 这些字符串只存在于它的代码里
  const MARKS = ['搜索一切', '首页', '任务看板', '会话', '暂无项目或助理', '这台 Windows', 'OpenBitFun'];
  const missing = MARKS.filter((s) => !dom.includes(s));
  ok(missing.length === 0, '渲染出它自己的 ' + MARKS.length + ' 处文案' + (missing.length ? '  ← 缺 ' + missing.join(',') : ''));
  ok(/OpenBitFun，/.test(dom), '渲染出打字机欢迎语（真实组件，不是我的 HTML）');

  // 它真的执行了 IPC —— 证明跑的是它的 React 代码
  const ipc = (dom.match(/id="__ipc_dump"[^>]*>([\s\S]*?)<\/pre>/) || [])[1] || '';
  let calls = 0;
  try { calls = JSON.parse(ipc).length; } catch { calls = 0; }
  ok(calls >= 20, '真前端执行了 ' + calls + ' 条 IPC 调用（说明它的 React 代码真的在跑）');
  ok(/get_config/.test(ipc), 'IPC 里出现 get_config（启动链路真的走完了）');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

// ── 4. 截图 ──
const shot = path.join(REPO, 'research/screenshots/上游-真前端-直接运行.png');
ok(fs.existsSync(shot), '截图证据：上游-真前端-直接运行.png' + (fs.existsSync(shot) ? '  ' + Math.round(fs.statSync(shot).size / 1024) + 'KB' : ''));

console.log('');
console.log('  ' + '─'.repeat(74));
console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
console.log('');
process.exit(fail ? 1 : unknown ? 2 : 0);
