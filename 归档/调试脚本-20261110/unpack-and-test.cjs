/**
 * 决定性验证：解包 asar → 真 node 跑 dsh-tui → 看 Ink 是否正常
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SHELL = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳`;
const ASAR_PATH = String.raw`D:\file\software\DeepSeek Harness\resources\app.asar`;
const OUT = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\_asar\dsh`;

const asar = require(path.join(SHELL, 'node_modules', '@electron', 'asar'));

console.log('═══ 解包 asar 的 dsh 目录 ═══');
console.log('  源: ' + ASAR_PATH);
console.log('  目标: ' + path.dirname(OUT));
console.log();

// 只解包 dsh 子目录
const target = path.dirname(OUT);
if (fs.existsSync(target)) {
  console.log('  目标已存在，跳过解包');
} else {
  try {
    fs.mkdirSync(target, { recursive: true });
    console.log('  开始解包（25418 文件，可能需要 30 秒）…');
    asar.extractAll(ASAR_PATH, target);
    console.log('  ✓ 解包完成');
  } catch (e) {
    console.log('  ✗ 失败: ' + e.message);
    process.exit(1);
  }
}

const CLI = path.join(target, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
console.log();
console.log('  cli.js 路径: ' + CLI);
console.log('  存在: ' + fs.existsSync(CLI));

if (!fs.existsSync(CLI)) {
  console.log('✗ cli.js 不存在，解包不完整');
  process.exit(1);
}

// 先用真 node 测 --version
console.log();
console.log('═══ 用真 node 跑 cli.js --version ═══');
const TUI_HOME = path.join(os.homedir(), '.dsh-tui-home');
const r = spawnSync(process.execPath, [CLI, '--version'], {
  encoding: 'utf8',
  timeout: 30000,
  env: Object.assign({}, process.env, { DSH_HOME: TUI_HOME }),
});
console.log('  退出码: ' + r.status);
console.log('  stdout: ' + (r.stdout || '').trim().slice(0, 100));
if (r.stderr) console.log('  stderr: ' + (r.stderr || '').trim().slice(0, 300));
