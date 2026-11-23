/**
 * 修正：用主 DSH_HOME（能看到我们的会话），只把 profile 参数指向 dsh-tui
 *
 * 之前错误：DSH_HOME=.dsh-tui-home（独立）→ 看不到主 home 的会话
 * 正确：DSH_HOME=主 home，但用 --profile dsh-tui
 *       profile 已在主 home 里安装过，可以直接用
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const SHELL = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳`;
const pty = require(path.join(SHELL, 'node_modules', 'node-pty'));

const NODE = process.execPath;
const CLI = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\_asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`;
const MAIN_HOME = path.join(os.homedir(), '.dsh');
const SESSION = 'session-49fac9b6-9736-4212-82ff-ca53f8e4b75e';

console.log('═══ 用主 DSH_HOME 启动 dsh-TUI ═══');
console.log('  DSH_HOME:', MAIN_HOME);
console.log('  会话:', SESSION);
console.log('  profiles/dsh-tui 存在:', fs.existsSync(path.join(MAIN_HOME, 'profiles', 'dsh-tui')));
console.log();

const env = Object.assign({}, process.env, {
  DSH_HOME: MAIN_HOME,
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  DSH_TUI_RESUME_SESSION: SESSION,
});
delete env.DSH_PORT;
delete env.SEA_DEBUG_PORT;
delete env.DSH_ENGINE_TOKEN;
delete env.ELECTRON_RUN_AS_NODE;
delete env.FORCE_COLOR;
delete env.NO_COLOR;

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
  console.log('✗ spawn:', e.message);
  process.exit(1);
}

console.log('✓ PTY pid=' + p.pid + '，等待 15 秒…');
console.log();

let buf = '';
let done = false;
p.onData(d => { buf += d; });

function report(tag) {
  const clean = buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  console.log('[' + tag + '] 输出 ' + buf.length + ' 字符');
  console.log('─'.repeat(70));
  console.log(clean.trim().slice(0, 700));
  console.log('─'.repeat(70));
  console.log();
  if (clean.includes('Raw mode is not supported')) {
    console.log('❌ raw mode 错误');
  } else if (clean.includes('startup failed')) {
    console.log('⚠ TUI 报错（但已能启动）');
  } else if (buf.length > 100) {
    console.log('✅ 有实质输出');
  } else {
    console.log('⚠ 输出很少');
  }
}

p.onExit((e) => {
  if (done) return;
  done = true;
  console.log('═══ 退出 code=' + e.exitCode + ' ═══');
  report('exit');
  process.exit(0);
});

setTimeout(() => {
  if (done) return;
  done = true;
  console.log('═══ 15 秒仍存活 → TUI 正常运行 ═══');
  report('alive');
  try { p.kill(); } catch (e) { /* ignore */ }
  process.exit(0);
}, 15000);
