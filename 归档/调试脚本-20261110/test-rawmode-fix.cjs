/**
 * 破局测试：让 Ink 拿到 raw mode stdin
 *
 * 已知：
 *   ① exe 直连 + conpty → 退出码 0，零输出（静默）
 *   ② cmd.exe /c dsh.cmd + conpty → "Raw mode is not supported"
 *
 * 分析：
 *   ① 的零输出说明进程启动了但立即退出 —— 可能是 dsh-tui 检测到非 TTY
 *   ② 有输出说明 TUI 真的起来了，但 Ink 的 raw mode 失败
 *
 * 关键洞察：dsh.cmd 内部设了 ELECTRON_RUN_AS_NODE=1，然后跑 exe。
 *          而我在 ① 里也设了 ELECTRON_RUN_AS_NODE —— 但 dsh.cmd 的 setlocal
 *          会把 stdin 的句柄继承方式改变。
 *
 * 所以正解可能是：
 *   · 不经过 cmd.exe，但要用 dsh.cmd 完全一样的环境和参数
 *   · 并且确保 stdin 是 PTY 的 raw 模式
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const SHELL = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳`;
const pty = require(path.join(SHELL, 'node_modules', 'node-pty'));

const EXE = String.raw`D:\file\software\DeepSeek Harness\DeepSeek Harness.exe`;
const CLI_ASAR = String.raw`D:\file\software\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`;
const DSHCMD = String.raw`D:\file\software\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`;
const TUI_HOME = path.join(os.homedir(), '.dsh-tui-home');

function makeEnv(extra) {
  const env = Object.assign({}, process.env, {
    DSH_HOME: TUI_HOME,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
  });
  delete env.DSH_PORT;
  delete env.SEA_DEBUG_PORT;
  delete env.DSH_ENGINE_TOKEN;
  delete env.ELECTRON_RUN_AS_NODE;
  return Object.assign(env, extra || {});
}

function trial(label, file, args, env) {
  return new Promise((resolve) => {
    console.log('─── ' + label + ' ───');
    let p;
    try {
      p = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: 100, rows: 30,
        cwd: String.raw`D:\file\AI Temp\DeepSeek\Agent自研`,
        env,
        useConpty: true,
      });
    } catch (e) {
      console.log('  ✗ spawn 异常: ' + e.message);
      return resolve();
    }

    let buf = '';
    let done = false;
    p.onData(d => { buf += d; });

    const finish = (tag, code) => {
      if (done) return;
      done = true;
      const clean = buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
      console.log('  [' + tag + '] 退出码 ' + code + '  输出 ' + buf.length + ' 字符');
      if (clean.trim()) {
        console.log('  内容: ' + clean.trim().replace(/\s+/g, ' ').slice(0, 220));
      }
      resolve();
    };

    p.onExit(e => finish('exit', e.exitCode));
    setTimeout(() => {
      if (!done) {
        finish('alive', '(仍存活)');
        try { p.kill(); } catch (e) { /* ignore */ }
      }
    }, 8000);
  });
}

(async () => {
  console.log('═══ 环境变量对照 ═══');
  console.log();

  // ① exe 直连 + ELECTRON_RUN_AS_NODE（这是 dsh.cmd 的等效做法）
  await trial('exe + RUN_AS_NODE=1（模拟 dsh.cmd）',
    EXE,
    ['--expose-internals', CLI_ASAR, '--profile', 'dsh-tui'],
    makeEnv({ ELECTRON_RUN_AS_NODE: '1' })
  );
  console.log();

  // ② 用 dsh.cmd 但通过 sh -c 或直接调（cmd 会破坏 raw mode，试试 /d /s /c）
  await trial('cmd.exe /d /s /c dsh.cmd',
    'cmd.exe',
    ['/d', '/s', '/c', '"' + DSHCMD + '" --profile dsh-tui'],
    makeEnv()
  );
  console.log();

  // ③ 关键：Ink 的 raw mode 问题可以用 CI=1 或 FORCE_TTY 绕过？
  await trial('exe + CI=1',
    EXE,
    ['--expose-internals', CLI_ASAR, '--profile', 'dsh-tui'],
    makeEnv({ ELECTRON_RUN_AS_NODE: '1', CI: '1' })
  );

  process.exit(0);
})();
