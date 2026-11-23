/**
 * 最终决定性验证：
 *   真 node.exe + cli.js（解包版）+ PTY → dsh-TUI 能否正常启动
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const SHELL = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳`;
const pty = require(path.join(SHELL, 'node_modules', 'node-pty'));

const NODE = process.execPath;   // 系统 node（有 setRawMode）
const CLI = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\_asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`;
const TUI_HOME = path.join(os.homedir(), '.dsh-tui-home');
const SESSION = 'session-49fac9b6-9736-4212-82ff-ca53f8e4b75e';

console.log('═══ 最终验证：真 node + PTY 启动 dsh-TUI ═══');
console.log('  node:', NODE);
console.log('  cli :', fs.existsSync(CLI) ? '存在' : '缺失');
console.log('  home:', TUI_HOME);
console.log('  会话:', SESSION);
console.log();

const env = Object.assign({}, process.env, {
  DSH_HOME: TUI_HOME,
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  FORCE_COLOR: '3',
  DSH_TUI_RESUME_SESSION: SESSION,
});
delete env.DSH_PORT;
delete env.SEA_DEBUG_PORT;
delete env.DSH_ENGINE_TOKEN;
delete env.ELECTRON_RUN_AS_NODE;

let p;
try {
  p = pty.spawn(NODE, ['--expose-internals', CLI, '--profile', 'dsh-tui'], {
    name: 'xterm-256color',
    cols: 100, rows: 30,
    cwd: String.raw`D:\file\AI Temp\DeepSeek\Agent自研`,
    env,
    useConpty: true,
  });
} catch (e) {
  console.log('✗ spawn 异常:', e.message);
  process.exit(1);
}

console.log('✓ PTY 已创建 pid=' + p.pid);
console.log('  等待 15 秒…');
console.log();

let buf = '';
let done = false;

p.onData(d => { buf += d; });

p.onExit((e) => {
  if (done) return;
  done = true;
  console.log('═══ 进程退出 code=' + e.exitCode + ' ═══');
  report();
  process.exit(0);
});

function report() {
  const clean = buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  console.log('输出 ' + buf.length + ' 字符，可读内容（前 600 字）:');
  console.log('─'.repeat(70));
  console.log(clean.trim().slice(0, 600));
  console.log('─'.repeat(70));
  console.log();
  console.log('═══ 判断 ═══');
  if (clean.includes('Raw mode is not supported')) {
    console.log('❌ 仍有 raw mode 错误');
  } else if (buf.length === 0) {
    console.log('⚠ 零输出（进程静默退出）');
  } else if (/dsh-TUI|DeepSeek|欢迎|❯|命令/.test(clean)) {
    console.log('✅ dsh-TUI 界面已渲染！');
  } else {
    console.log('⚠ 有输出但不像 TUI 界面');
  }
}

setTimeout(() => {
  if (done) return;
  done = true;
  console.log('═══ 15 秒后仍存活 → dsh-TUI 正常运行 ═══');
  console.log();
  report();
  try { p.write('\x03'); } catch (e) { /* ignore */ }
  setTimeout(() => {
    try { p.kill(); } catch (e) { /* ignore */ }
    process.exit(0);
  }, 1000);
}, 15000);
