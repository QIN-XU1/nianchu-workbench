/**
 * 给打包产物补 VBS 启动器
 *
 * 为什么需要（2026-11-13）
 * ──────────────────────────────────────────────────────────────────
 * 实测：打包出的 exe 从 cmd 的 `start` / PowerShell 子进程启动**必然失败**：
 *   · 只剩 1 个僵尸进程
 *   · 零日志输出（连 main.js 第一行都没执行）
 *   · exit code -2147483645 = STATUS_DLL_INIT_FAILED
 *
 * 但**同一台机器上源码版能正常跑**，它是这样启动的：
 *   VBScript → WScript.Shell.Run → electron.exe
 *
 * WScript.Shell 会脱离调用者的控制台/进程树，
 * 这是 Electron 在这台机器上 DLL 初始化成功的前提。
 *
 * 所以给打包产物补一个 VBS 启动器，双击即用。
 *
 * 用法：node 工具/补VBS启动器.mjs [产物目录]
 */

import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] || 'D:/file/AI Temp/DeepSeek/Agent自研/dist2/win-unpacked';
const TEMPLATE = 'D:/file/AI Temp/DeepSeek/Agent自研/workbench/外壳/build/启动 DSH 工作台.vbs';

console.log('  产物目录: ' + OUT);
console.log('  模板:     ' + TEMPLATE);
console.log();

if (!fs.existsSync(OUT)) { console.log('  ✗ 产物目录不存在'); process.exit(1); }
if (!fs.existsSync(TEMPLATE)) { console.log('  ✗ 模板不存在'); process.exit(1); }

const dst = path.join(OUT, '启动 DSH 工作台.vbs');
try {
  fs.copyFileSync(TEMPLATE, dst);
  console.log('  ✓ 已生成: 启动 DSH 工作台.vbs  (' + fs.statSync(dst).size + ' 字节)');
} catch (e) {
  console.log('  ✗ 复制失败: ' + e.message);
  process.exit(1);
}

// 顺便生成一个 ASCII 的 .cmd（命令行用户）
const cmd = [
  '@echo off',
  'rem DSH Workbench - CLI launcher (ASCII safe)',
  'rem For normal use, double-click the .vbs instead.',
  'setlocal',
  'set ELECTRON_RUN_AS_NODE=',
  'set DSH_SKIP_SINGLE_LOCK=1',
  'cd /d "%~dp0"',
  'for %%F in ("DSH*.exe") do (',
  '  start "" "%%~fF" --no-sandbox --disable-gpu --disable-gpu-compositing --disable-software-rasterizer',
  ')',
  'endlocal',
].join('\r\n');
try {
  fs.writeFileSync(path.join(OUT, 'START-DSH.cmd'), cmd, 'ascii');
  console.log('  ✓ 已生成: START-DSH.cmd');
} catch { /* ignore */ }

// 启动说明
const readme = [
  'DSH 工作台 —— 启动说明',
  '='.repeat(42),
  '',
  '★ 怎么启动：双击「启动 DSH 工作台.vbs」',
  '',
  '为什么不直接双击 exe：',
  '',
  '  实测这台机器上，exe 从命令行 / 脚本的直接调用启动会失败',
  '  （只剩一个僵尸进程、零日志、exit code -2147483645）。',
  '  但源码版能跑，它用的是 VBScript → WScript.Shell 启动。',
  '  WScript.Shell 会脱离调用者的进程树 —— 这是 Electron',
  '  在这台机器上 DLL 初始化成功的前提。',
  '',
  '  所以启动器也用 VBS，和源码版一模一样。',
  '',
  'VBS 启动器做得三件事：',
  '  1) 清掉 ELECTRON_RUN_AS_NODE（否则 Electron 退化成纯 Node，不加载界面）',
  '  2) 设 DSH_SKIP_SINGLE_LOCK=1（这台机器建不了 SingletonLock 符号链接）',
  '  3) 带 --no-sandbox --disable-gpu 等开关（规避沙箱/GPU 初始化崩溃）',
  '',
  '数据位置：%APPDATA%\\DSH-Workbench\\',
  '  server.log   引擎日志（出问题先看这个）',
  '  data\\        你的场景记忆（升级不覆盖）',
  '',
  '卸载：删掉本目录即可。数据保留在 %APPDATA%\\DSH-Workbench\\。',
].join('\r\n');
fs.writeFileSync(path.join(OUT, 'README-START.txt'), readme, 'utf8');
console.log('  ✓ 已生成: README-START.txt');

console.log();
console.log('  产物文件:');
for (const f of fs.readdirSync(OUT)) {
  if (/\.(vbs|cmd|txt)$/i.test(f)) console.log('    ' + f);
}
