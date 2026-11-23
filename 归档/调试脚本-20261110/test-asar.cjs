/**
 * 方案验证：用 asar 解包 + 真 node 跑 dsh CLI
 *
 * 逻辑链：
 *   Electron-as-Node 的 stdin 没有 setRawMode  →  Ink 崩
 *   系统 node 的 stdin 有 setRawMode            →  可以
 *   但 cli.js 在 app.asar 里，系统 node 读不了
 *   → 用 @electron/asar 解包，再用系统 node 跑
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const ASAR_PATH = String.raw`D:\file\software\DeepSeek Harness\resources\app.asar`;
const OUT_DIR = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\_asar_unpacked`;
const SHELL = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳`;

console.log('═══ 验证 @electron/asar 解包能力 ═══');
console.log();

let asar;
try {
  asar = require(path.join(SHELL, 'node_modules', '@electron', 'asar'));
  console.log('✓ @electron/asar 加载成功');
  console.log('  可用方法: ' + Object.keys(asar).filter(k => typeof asar[k] === 'function').join(', '));
} catch (e) {
  console.log('✗ 加载失败: ' + e.message);
  process.exit(1);
}

console.log();

// 只解包需要的目录：dsh/node_modules/@deepseek-ai/dsh-desktop-host 和 dsh/lib
// 先看 asar 里有什么
console.log('═══ asar 顶层结构 ═══');
try {
  const files = asar.listPackage(ASAR_PATH);
  console.log('  总文件数: ' + files.length);
  const topDirs = new Set();
  for (const f of files) {
    const parts = f.replace(/^[\\/]/, '').split(/[\\/]/);
    if (parts[0]) topDirs.add(parts[0]);
  }
  console.log('  顶层: ' + [...topDirs].slice(0, 20).join(', '));

  // 找 cli.js
  const cliFiles = files.filter(f => f.includes('dsh-desktop-host') && f.endsWith('cli.js'));
  console.log();
  console.log('  dsh-desktop-host 的 cli.js:');
  for (const c of cliFiles.slice(0, 5)) console.log('    ' + c);
} catch (e) {
  console.log('  ✗ listPackage 失败: ' + e.message);
}

console.log();
console.log('═══ 判断 ═══');
const unpackedDsh = String.raw`D:\file\software\DeepSeek Harness\resources\app.asar.unpacked\dsh`;
console.log('  app.asar.unpacked/dsh 已存在（Electron 自动解包的 native 模块）');
console.log('  但 cli.js 是 JS，仍在 asar 内');

// 检查解包后 dsh 的 node_modules 是否完整
if (fs.existsSync(unpackedDsh)) {
  const nm = path.join(unpackedDsh, 'node_modules');
  if (fs.existsSync(nm)) {
    const items = fs.readdirSync(nm);
    console.log('  unpacked node_modules: ' + items.slice(0, 10).join(', '));
  }
}
