/**
 * 最后验证：确认 dsh-TUI 的 TUI 界面真的渲染出来了（不 resume）
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const SHELL = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳`;
const pty = require(path.join(SHELL, 'node_modules', 'node-pty'));

const NODE = process.execPath;
const CLI = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\_asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`;
const MAIN_HOME = path.join(os.homedir(), '.dsh');

const env = Object.assign({}, process.env, {
  DSH_HOME: MAIN_HOME,
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
});
delete env.DSH_PORT;
delete env.SEA_DEBUG_PORT;
delete env.DSH_ENGINE_TOKEN;
delete env.ELECTRON_RUN_AS_NODE;
delete env.FORCE_COLOR;
delete env.NO_COLOR;
delete env.DSH_TUI_RESUME_SESSION;

console.log('═══ 验证 dsh-TUI 界面渲染 ═══');
console.log();

const p = pty.spawn(NODE, ['--expose-internals', CLI, '--profile', 'dsh-tui'], {
  name: 'xterm-256color',
  cols: 100, rows: 30,
  cwd: String.raw`D:\file\AI Temp\DeepSeek\Agent自研`,
  env,
  useConpty: true,
});

let buf = '';
p.onData(d => { buf += d; });

setTimeout(() => {
  console.log('── 20 秒后的完整输出 ──');
  // 保留 ANSI 结构，只把光标控制序列换成 ␛ 便于看
  const visible = buf
    .replace(/\x1b\[2J/g, '\n[清屏]\n')
    .replace(/\x1b\[H/g, '\n[归位]\n')
    .replace(/\x1b\[[0-9;]*[Hf]/g, '')
    .replace(/\x1b\[[0-9;?]*[hlm]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][AB0]/g, '');

  console.log(visible.slice(-2000));
  console.log();
  console.log('── 关键特征检测 ──');
  const checks = [
    ['dsh-TUI', /dsh-TUI/i],
    ['像素鲸鱼', /█|▀|▄/],
    ['命令面板', /命令|command/i],
    ['输入框提示', /❯|>\s*$/m],
    ['模型名', /deepseek|flash|pro/i],
  ];
  for (const [name, re] of checks) {
    console.log('  ' + (re.test(visible) ? '✓' : '✗') + ' ' + name);
  }

  console.log();
  console.log('总输出: ' + buf.length + ' 字符');

  try { p.kill(); } catch (e) { /* ignore */ }
  process.exit(0);
}, 20000);
