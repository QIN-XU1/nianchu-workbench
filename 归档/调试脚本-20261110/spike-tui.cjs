/**
 * 决定性验证：在**纯 Node**（不是 Electron）里用 node-pty 启动 dsh-tui
 *
 * 目的：把变量隔离到最少
 *   · 如果这里能跑通 → 问题在 Electron 层
 *   · 如果这里跑不通 → dsh-tui 本身与当前 DSH 版本不兼容
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const SHELL = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳`;
const pty = require(path.join(SHELL, 'node_modules', 'node-pty'));

const EXE = String.raw`D:\file\software\DeepSeek Harness\DeepSeek Harness.exe`;
const CLI = String.raw`D:\file\software\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`;
const TUI_HOME = path.join(os.homedir(), '.dsh-tui-home');

console.log('═══ 纯 Node + node-pty 测试 dsh-tui ═══');
console.log('  EXE:', fs.existsSync(EXE) ? '存在' : '缺失');
console.log('  CLI:', fs.existsSync(CLI) ? '存在' : '缺失');
console.log('  HOME:', fs.existsSync(TUI_HOME) ? '存在' : '缺失');
console.log();

const env = Object.assign({}, process.env, {
  DSH_HOME: TUI_HOME,
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  FORCE_COLOR: '3',
  ELECTRON_RUN_AS_NODE: '1',
  // 我们的对话
  DSH_TUI_RESUME_SESSION: 'session-49fac9b6-9736-4212-82ff-ca53f8e4b75e',
});
delete env.DSH_PORT;
delete env.SEA_DEBUG_PORT;
delete env.DSH_ENGINE_TOKEN;

let proc;
try {
  proc = pty.spawn(EXE, ['--expose-internals', CLI, '--profile', 'dsh-tui'], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: String.raw`D:\file\AI Temp\DeepSeek\Agent自研`,
    env,
    useConpty: true,
  });
} catch (e) {
  console.log('✗ spawn 异常:', e.message);
  process.exit(1);
}

console.log('✓ PTY 已创建 pid=' + proc.pid);
console.log('  等待 12 秒，捕获全部输出…');
console.log();

let buf = '';
let exited = false;

proc.onData((d) => { buf += d; });

proc.onExit((e) => {
  exited = true;
  console.log('═══ 进程退出 code=' + e.exitCode + ' signal=' + (e.signal || 0) + ' ═══');
  console.log();
  console.log('═══ 完整输出（' + buf.length + ' 字符）═══');
  // 去掉 ANSI 转义，只留可读文本
  const clean = buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  console.log(clean.slice(-1500));
  process.exit(0);
});

setTimeout(() => {
  console.log('═══ 12 秒到了，进程还没退出 → 说明它活着（这是好事）═══');
  console.log();
  console.log('输出长度: ' + buf.length + ' 字符');
  console.log('清理后的最后 800 字:');
  const clean = buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  console.log(clean.slice(-800));
  console.log();
  console.log(exited ? '（已退出）' : '（仍存活 → 尝试发送 q 退出）');
  try { proc.write('q'); } catch (e) { /* ignore */ }
  setTimeout(() => {
    try { proc.kill(); } catch (e) { /* ignore */ }
    process.exit(0);
  }, 3000);
}, 12000);
