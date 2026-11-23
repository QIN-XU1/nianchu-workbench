#!/usr/bin/env node
/**
 * pnpm 转发器 —— 工作台期望的 pnpm 入口
 *
 * 背景（2026-11-11 实测）：
 *   装 dsh-tui profile 时，dsh CLI 报：
 *     Error: Cannot find module
 *     '...\workbench\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
 *
 *   说明 dsh-desktop-host 期望工作台自带一份 pnpm 运行时，
 *   但这个独立版项目里没有 runtime/ 目录。
 *
 * 本机已有全局 pnpm（corepack shim，版本 11.21.0），
 * 所以这里不装新 pnpm，只做一层转发。
 *
 * 为什么不用 shell 转发：
 *   实测 PowerShell 调 cmd 会剥引号、中文路径会乱码，
 *   所以在 Node 里直接 spawn，参数用数组传（不经过 shell）。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 找 corepack 的 pnpm.js
const CANDIDATES = [
  // 本机全局 node
  'D:/file/env/nodejs/node_modules/corepack/dist/pnpm.js',
  // PATH 里的 node 同目录
  path.join(path.dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'pnpm.js'),
  // 兜底：项目引擎
  path.join(HERE, '..', '..', '..', '..', '..', '引擎', 'node_modules', 'corepack', 'dist', 'pnpm.js'),
];

let target = null;
for (const c of CANDIDATES) {
  try {
    if (fs.existsSync(c)) { target = c; break; }
  } catch { /* ignore */ }
}

if (!target) {
  console.error('[pnpm-shim] 找不到 corepack pnpm，候选路径都试过了：');
  for (const c of CANDIDATES) console.error('  - ' + c);
  process.exit(2);
}

// 用当前 node 跑 corepack 的 pnpm.js，参数原样透传
const child = spawn(process.execPath, [target, ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: true,
});

child.on('exit', (code) => process.exit(code === null ? 1 : code));
child.on('error', (e) => {
  console.error('[pnpm-shim] 启动失败: ' + e.message);
  process.exit(1);
});
