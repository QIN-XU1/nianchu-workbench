/**
 * 关键变量测试：conpty vs winpty
 *
 * 已知：
 *   · 非 TTY 启动 → 进程存活（无输出，正常，TUI 等 TTY）
 *   · conpty（useConpty: true）→ 退出码 1，零输出
 *   · --dump-config 在 pipe 下退出码 0（配置没问题）
 *
 * 假设：conpty 与 ELECTRON_RUN_AS_NODE 组合有问题
 * 变量：① useConpty: false（winpty 后端）② 不用 exe，用 cmd.exe
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const SHELL = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳`;
const pty = require(path.join(SHELL, 'node_modules', 'node-pty'));

const EXE = String.raw`D:\file\software\DeepSeek Harness\DeepSeek Harness.exe`;
const CLI = String.raw`D:\file\software\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`;
const DSHCMD = String.raw`D:\file\software\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`;
const TUI_HOME = path.join(os.homedir(), '.dsh-tui-home');

function makeEnv() {
  const env = Object.assign({}, process.env, {
    DSH_HOME: TUI_HOME,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  });
  delete env.DSH_PORT;
  delete env.SEA_DEBUG_PORT;
  delete env.DSH_ENGINE_TOKEN;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

async function trial(label, file, args, useConpty) {
  return new Promise((resolve) => {
    console.log('─── ' + label + ' (useConpty=' + useConpty + ') ───');

    let p;
    try {
      p = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: 100, rows: 30,
        cwd: String.raw`D:\file\AI Temp\DeepSeek\Agent自研`,
        env: makeEnv(),
        useConpty: useConpty,
      });
    } catch (e) {
      console.log('  ✗ spawn 异常: ' + e.message);
      return resolve();
    }

    let buf = '';
    let done = false;
    p.onData(d => { buf += d; });

    p.onExit((e) => {
      if (done) return;
      done = true;
      const clean = buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
      console.log('  退出码: ' + e.exitCode + '  输出 ' + buf.length + ' 字符');
      if (clean.trim()) {
        console.log('  内容: ' + clean.trim().replace(/\n/g, ' | ').slice(0, 250));
      }
      resolve();
    });

    setTimeout(() => {
      if (done) return;
      done = true;
      const clean = buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
      console.log('  5 秒仍存活（好事）输出 ' + buf.length + ' 字符');
      if (clean.trim()) console.log('  内容: ' + clean.trim().replace(/\n/g, ' | ').slice(0, 250));
      try { p.kill(); } catch (e) { /* ignore */ }
      resolve();
    }, 5000);
  });
}

(async () => {
  console.log('═══ conpty / winpty 对照测试 ═══');
  console.log();

  await trial('exe + conpty', EXE, ['--expose-internals', CLI, '--profile', 'dsh-tui'], true);
  console.log();
  await trial('exe + winpty', EXE, ['--expose-internals', CLI, '--profile', 'dsh-tui'], false);
  console.log();
  await trial('cmd.exe /c dsh.cmd + winpty', 'cmd.exe', ['/c', DSHCMD, '--profile', 'dsh-tui'], false);
  console.log();
  await trial('cmd.exe /c dsh.cmd + conpty', 'cmd.exe', ['/c', DSHCMD, '--profile', 'dsh-tui'], true);

  process.exit(0);
})();
