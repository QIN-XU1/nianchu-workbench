/**
 * 测：dsh-tui 在「非 TTY」和「真 TTY」下的行为差异
 *
 * 关键假设：dsh-tui 检测到没有 TTY 会拒绝启动（前面读 bin 代码时见过
 * "此处没有终端，未启动任何会话" 这类文案）
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXE = String.raw`D:\file\software\DeepSeek Harness\DeepSeek Harness.exe`;
const CLI = String.raw`D:\file\software\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`;
const TUI_HOME = path.join(os.homedir(), '.dsh-tui-home');

function baseEnv() {
  const env = Object.assign({}, process.env, {
    DSH_HOME: TUI_HOME,
    ELECTRON_RUN_AS_NODE: '1',
  });
  delete env.DSH_PORT;
  delete env.SEA_DEBUG_PORT;
  delete env.DSH_ENGINE_TOKEN;
  delete env.TERM;          // 故意不设 TERM
  return env;
}

console.log('═══ 测试 A：非 TTY（pipe）直接跑 dsh-tui ═══');
console.log();

const r = spawnSync(EXE, ['--expose-internals', CLI, '--profile', 'dsh-tui', '--version'], {
  encoding: 'utf8',
  env: baseEnv(),
  timeout: 20000,
});
console.log('  --version 退出码:', r.status, ' 输出:', (r.stdout || '').trim().slice(0, 60));

console.log();
console.log('═══ 测试 B：非 TTY 真启动（5 秒后杀）═══');
console.log();

const child = spawn(EXE, ['--expose-internals', CLI, '--profile', 'dsh-tui'], {
  env: baseEnv(),
  stdio: ['pipe', 'pipe', 'pipe'],
});

let out = '', err = '';
child.stdout.on('data', d => { out += d; });
child.stderr.on('data', d => { err += d; });

child.on('exit', (code, sig) => {
  console.log('  退出码:', code, 'signal:', sig);
  console.log('  stdout (' + out.length + ' 字):', JSON.stringify(out.slice(0, 300)));
  console.log('  stderr (' + err.length + ' 字):', JSON.stringify(err.slice(0, 300)));
  testC();
});

child.on('error', (e) => {
  console.log('  spawn error:', e.message);
  testC();
});

setTimeout(() => {
  try { child.kill(); } catch (e) { /* ignore */ }
}, 6000);

function testC() {
  console.log();
  console.log('═══ 测试 C：用 node-pty（真 TTY），但先看 conpty 是否可用 ═══');
  console.log();

  const pty = require(path.join(String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳`, 'node_modules', 'node-pty'));

  let p;
  try {
    p = pty.spawn(EXE, ['--expose-internals', CLI, '--profile', 'dsh-tui'], {
      name: 'xterm-256color',
      cols: 100, rows: 30,
      cwd: String.raw`D:\file\AI Temp\DeepSeek\Agent自研`,
      env: Object.assign({}, baseEnv(), { TERM: 'xterm-256color' }),
      useConpty: true,
    });
    console.log('  ✓ PTY 创建成功 pid=' + p.pid);
  } catch (e) {
    console.log('  ✗ PTY 创建失败:', e.message);
    process.exit(0);
  }

  let pbuf = '';
  p.onData(d => { pbuf += d; });
  p.onExit(e => {
    console.log('  退出码:', e.exitCode);
    const clean = pbuf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    console.log('  输出 (' + pbuf.length + ' 字):');
    console.log(clean.slice(0, 400));
    process.exit(0);
  });

  setTimeout(() => {
    const clean = pbuf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    console.log('  6 秒后仍存活 → 输出 ' + pbuf.length + ' 字');
    console.log('  内容:');
    console.log(clean.slice(0, 600));
    try { p.kill(); } catch (e) { /* ignore */ }
    process.exit(0);
  }, 6000);
}
