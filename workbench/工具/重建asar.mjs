/**
 * 直接重建 app.asar —— 绕过 electron-builder 的网络依赖
 *
 * 为什么需要
 * ──────────────────────────────────────────────────────────────────
 * electron-builder 每次打包都要下载 electron 包（215MB），
 * 而这个环境的网络到 GitHub 极不稳定，反复超时：
 *   ⨯ connect ETIMEDOUT 20.205.243.166:443
 *   ⨯ read ECONNRESET
 *   ⨯ Timeout awaiting 'request' for 600000ms
 *
 * 但**不需要重新下载 electron** —— dist2/win-unpacked 里已有完整运行时，
 * 只有 app.asar（我们的代码）要更新。
 *
 * 用法：node 工具/重建asar.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('D:/file/AI Temp/DeepSeek/Agent自研/workbench/外壳/');
const asar = require('@electron/asar');

const SHELL = 'D:/file/AI Temp/DeepSeek/Agent自研/workbench/外壳';
const TARGET = 'D:/file/AI Temp/DeepSeek/Agent自研/dist2/win-unpacked/resources/app.asar';

console.log('='.repeat(76));
console.log('  直接重建 app.asar（零网络）');
console.log('='.repeat(76));
console.log();

if (!fs.existsSync(TARGET)) {
  console.log('  ✗ 目标不存在，先跑一次完整 electron-builder 生成骨架');
  process.exit(1);
}

const oldSize = fs.statSync(TARGET).size;
console.log('  旧 asar: ' + (oldSize / 1024 / 1024).toFixed(1) + ' MB');

// ── 收集文件 ──
const toPack = new Set();

// ① 顶层必需文件
for (const f of ['main.js', 'preload.js', 'fault-handlers.cjs', 'tui-bridge.cjs', 'crash.js', 'package.json']) {
  if (fs.existsSync(path.join(SHELL, f))) toPack.add(f);
}

// ② scripts/ 和 ui/ 全部
function collect(dir, out, depth) {
  if (depth > 6) return;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { collect(full, out, depth + 1); continue; }
    if (/\.(md|map|ts|tsx)$/i.test(e.name)) continue;
    if (e.name.startsWith('.')) continue;
    // ⚠ 原生模块不能进 asar（见 RUNTIME_DEPS 上方的说明）
    if (/\.node$/i.test(e.name)) continue;
    out.add(path.relative(SHELL, full).replace(/\\/g, '/'));
  }
}
collect(path.join(SHELL, 'scripts'), toPack, 0);
collect(path.join(SHELL, 'ui'), toPack, 0);

// ③ 运行时依赖
//
//  ⚠ 关键约束（踩过）：原生模块（node-pty 的 .node 文件）**不能放进 asar**，
//    必须放在 app.asar.unpacked 里由 Electron 自动映射。
//
//    实测：app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/*.node
//          已经由 electron-builder 放好了（上次打包留下的）。
//          所以这里**只打 node-pty 的 JS 部分**，不打包 .node，
//          避免 asar 里出现无法加载的原生模块。
const RUNTIME_DEPS = ['xterm', '@xterm/addon-fit', 'electron-updater', 'node-pty'];
let depCount = 0;
for (const dep of RUNTIME_DEPS) {
  const depDir = path.join(SHELL, 'node_modules', dep);
  if (!fs.existsSync(depDir)) { console.log('  ⚠ 缺依赖: ' + dep); continue; }
  const before = toPack.size;
  collect(depDir, toPack, 0);
  depCount += toPack.size - before;
}
console.log('  待打包: ' + toPack.size + ' 个文件（其中依赖 ' + depCount + ' 个）');

// ── 拷到临时目录 ──
const tmp = path.join(process.env.TEMP || '/tmp', 'asar-rebuild-' + Date.now());
fs.mkdirSync(tmp, { recursive: true });
let copied = 0;
for (const rel of toPack) {
  const src = path.join(SHELL, rel);
  const dst = path.join(tmp, rel);
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied++;
  } catch { /* 跳过无法复制的 */ }
}
console.log('  ✓ 已复制 ' + copied + ' 个文件到临时目录');

// ── 打包 ──
// 先备份
const bak = TARGET + '.bak';
try { fs.copyFileSync(TARGET, bak); } catch { /* ignore */ }

console.log('  正在打包 asar…');
try {
  await asar.createPackage(tmp, TARGET);
  const newSize = fs.statSync(TARGET).size;
  console.log('  ✓ 新 asar: ' + (newSize / 1024 / 1024).toFixed(1) + ' MB');
  if (newSize < oldSize * 0.7) {
    console.log('  ⚠ 比旧的小很多，可能漏了文件（旧 ' + (oldSize / 1024 / 1024).toFixed(1) + ' MB）');
  }
} catch (e) {
  console.log('  ✗ 打包失败: ' + e.message);
  if (fs.existsSync(bak)) { fs.copyFileSync(bak, TARGET); console.log('  ✓ 已恢复旧 asar'); }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
fs.rmSync(tmp, { recursive: true, force: true });

// ── 验证 ──
console.log();
console.log('  ── 关键文件 ──');
for (const f of ['main.js', 'preload.js', 'fault-handlers.cjs', 'tui-bridge.cjs', 'crash.js', 'scripts/sidebar.js']) {
  try {
    const b = asar.extractFile(TARGET, f);
    console.log('    ✓ ' + f.padEnd(24) + String(b.length).padStart(8) + ' 字节');
  } catch { console.log('    ✗ ' + f + ' 缺失'); }
}

const listed = asar.listPackage(TARGET).map((p) => p.replace(/^[\\/]/, '').replace(/\\/g, '/'));
console.log();
console.log('  asar 条目: ' + listed.length);
console.log('  ui/ 文件:  ' + listed.filter((p) => p.startsWith('ui/')).length);
console.log('  node_modules: ' + (listed.some((p) => p.startsWith('node_modules/')) ? '✓ 有' : '✗ 无'));

// ── 最新修复是否都在 ──
const m = asar.extractFile(TARGET, 'main.js').toString('utf8');
const marks = {
  'DSH-Workbench（中文路径）': m.includes('DSH-Workbench'),
  'ensureUserRootReady（建目录）': m.includes('ensureUserRootReady'),
  'LOG_FILE 打包适配': m.includes("path.join(USER_ROOT, 'server.log')"),
  'PROFILE_DIR 打包适配': m.includes("path.join(USER_ROOT, 'electron-profile')"),
  '锁失败降级': m.includes('降级为「允许多开」'),
  '前端按存在性': m.includes('forceV1 && fs.existsSync'),
};
console.log();
console.log('  ── 6 个关键修复 ──');
let allOk = true;
for (const [k, v] of Object.entries(marks)) {
  console.log('    ' + (v ? '✓' : '✗') + ' ' + k);
  if (!v) allOk = false;
}

try { fs.unlinkSync(bak); } catch { /* ignore */ }

console.log();
console.log('='.repeat(76));
console.log(allOk ? '  ✓ 重建完成，所有修复都在' : '  ⚠ 有修复未包含');
