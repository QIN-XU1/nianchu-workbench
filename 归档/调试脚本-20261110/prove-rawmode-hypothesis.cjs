/**
 * 决定性验证（唯一的假设检验）
 *
 * 假设：ELECTRON_RUN_AS_NODE 模式下 process.stdin 缺少 setRawMode
 *   → Ink 报 "Raw mode is not supported"
 *   → dsh-tui 无法启动
 *
 * 测法：在 PTY 里分别用 【真 node】 和 【Electron-as-node】跑同一段探测代码
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const SHELL = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳`;
const pty = require(path.join(SHELL, 'node_modules', 'node-pty'));

const EXE = String.raw`D:\file\software\DeepSeek Harness\DeepSeek Harness.exe`;
const NODE_CMD = String.raw`D:\file\software\DeepSeek Harness\resources\runtime\bin\node.cmd`;
const NODE_EXE = String.raw`D:\file\software\DeepSeek Harness\resources\runtime\bin\node.exe`;

const PROBE = `
console.log('--- stdin 能力探测 ---');
console.log('isTTY         :', process.stdin.isTTY);
console.log('setRawMode    :', typeof process.stdin.setRawMode);
console.log('stdin.fd      :', process.stdin.fd);
console.log('execPath      :', process.execPath.split(/[\\\\/]/).pop());
console.log('ELECTRON_RUN..:', process.env.ELECTRON_RUN_AS_NODE || '(unset)');
try {
  process.stdin.setRawMode(true);
  console.log('setRawMode(1) : OK');
  process.stdin.setRawMode(false);
  console.log('setRawMode(0) : OK');
} catch (e) {
  console.log('setRawMode    : ERROR', e.message);
}
process.exit(0);
`;

function run(label, file, args, env, useShell) {
  return new Promise((resolve) => {
    console.log('─── ' + label + ' ───');
    let p;
    try {
      p = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: 100, rows: 30,
        cwd: String.raw`D:\file\AI Temp\DeepSeek\Agent自研`,
        env: Object.assign({}, process.env, env || {}),
        useConpty: true,
      });
    } catch (e) {
      console.log('  ✗ spawn 异常: ' + e.message);
      return resolve();
    }

    let buf = '';
    p.onData(d => { buf += d; });
    p.onExit(() => {
      const clean = buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
      console.log(clean.split('\n').filter(l => l.trim()).map(l => '  ' + l.trim()).join('\n'));
      resolve();
    });
    setTimeout(() => {
      try { p.kill(); } catch (e) { /* ignore */ }
      resolve();
    }, 6000);
  });
}

(async () => {
  console.log('═══ stdin raw mode 能力对照 ═══');
  console.log();

  // ① 真 node.exe
  const hasNodeExe = fs.existsSync(NODE_EXE);
  const hasNodeCmd = fs.existsSync(NODE_CMD);
  console.log('runtime/bin/node.exe: ' + (hasNodeExe ? '存在' : '缺失'));
  console.log('runtime/bin/node.cmd: ' + (hasNodeCmd ? '存在' : '缺失'));
  console.log();

  if (hasNodeExe) {
    await run('真 node.exe + PTY', NODE_EXE, ['-e', PROBE], {});
  } else if (hasNodeCmd) {
    await run('node.cmd + PTY', 'cmd.exe', ['/c', NODE_CMD, '-e', PROBE], {});
  } else {
    await run('系统 node + PTY', process.execPath, ['-e', PROBE], {});
  }
  console.log();

  // ② Electron as node
  await run('Electron as node + PTY', EXE, ['-e', PROBE], { ELECTRON_RUN_AS_NODE: '1' });

  process.exit(0);
})();
