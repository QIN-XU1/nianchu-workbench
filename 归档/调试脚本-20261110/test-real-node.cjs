/**
 * 关键验证：真 Node 能否跑 DSH 引擎的 cli.js
 *
 * 已知：
 *   · Electron-as-Node 的 stdin 没有 setRawMode → Ink 崩
 *   · 系统 node 的 stdin 有 setRawMode → 可以
 *
 * 所以要试：用系统 node 跑 cli.js（而不是 Electron.exe）
 * 障碍：cli.js 在 app.asar 里，普通 node 读不了 asar
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ASAR = String.raw`D:\file\software\DeepSeek Harness\resources\app.asar`;
const CLI_IN_ASAR = 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js';
const DSH_DIR_UNPACKED = String.raw`D:\file\software\DeepSeek Harness\resources\app.asar.unpacked\dsh`;

console.log('═══ 检查 asar 解包情况 ═══');
console.log('  app.asar: ' + (fs.existsSync(ASAR) ? '存在' : '缺失'));
console.log('  app.asar.unpacked/dsh: ' + (fs.existsSync(DSH_DIR_UNPACKED) ? '存在' : '缺失'));
console.log();

// 查 unpacked 里有什么
if (fs.existsSync(DSH_DIR_UNPACKED)) {
  const items = fs.readdirSync(DSH_DIR_UNPACKED);
  console.log('  unpacked/dsh 内容: ' + items.join(', '));
}
console.log();

// ═══ 方案 A：用 asar 解包工具 ═══
console.log('═══ 方案 A：是否存在 asar 解包能力 ═══');
const asarPkg = path.join(String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳`, 'node_modules', '@electron', 'asar');
console.log('  @electron/asar 包: ' + (fs.existsSync(asarPkg) ? '存在' : '缺失'));

// ═══ 方案 B：DSH 的 node_modules 是否全局可用 ═══
console.log();
console.log('═══ 方案 B：系统 node 能否直接从 asar 路径 require ═══');
const r = spawnSync(process.execPath, ['-e', `
try {
  const p = ${JSON.stringify('D:/file/software/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')};
  console.log('尝试 require:', p);
  require(p);
  console.log('require OK');
} catch (e) {
  console.log('require FAILED:', e.code || e.message.slice(0, 80));
}
`], { encoding: 'utf8', timeout: 15000 });
console.log('  ' + (r.stdout || '').trim().split('\n').join('\n  '));
if (r.stderr) console.log('  stderr: ' + r.stderr.trim().slice(0, 200));

// ═══ 方案 C：换个思路 —— 用系统 node 跑 profile 里的 dsh-tui lib ═══
console.log();
console.log('═══ 方案 C：dsh-tui 的 lib 能不能用系统 node 直接跑 ═══');
const tuiLib = path.join(os.homedir(), '.dsh-tui-home', 'profiles', 'dsh-tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'lib');
if (fs.existsSync(tuiLib)) {
  const items = fs.readdirSync(tuiLib);
  console.log('  lib 内容: ' + items.join(', '));
  const entry = path.join(tuiLib, 'index.js');
  console.log('  index.js: ' + (fs.existsSync(entry) ? '存在' : '缺失'));
}
