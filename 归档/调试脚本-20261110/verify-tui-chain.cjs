/**
 * 验证完整链路：用一个空闲会话测 dsh-TUI
 *
 * 已知：
 *   · 真 node + cli.js(解包) + PTY → TUI 能启动 ✅
 *   · 我们当前对话的会话被占用 → 不能 resume
 *
 * 所以要测：① 新会话（不 resume）② 一个空闲的老会话
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const SHELL = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳`;
const pty = require(path.join(SHELL, 'node_modules', 'node-pty'));

const NODE = process.execPath;
const CLI = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\_asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`;
const MAIN_HOME = path.join(os.homedir(), '.dsh');

function run(label, withSession, timeoutMs) {
  return new Promise((resolve) => {
    console.log('─── ' + label + ' ───');

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
    if (withSession) env.DSH_TUI_RESUME_SESSION = withSession;

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
      console.log('  ✗ spawn: ' + e.message);
      return resolve();
    }

    let buf = '';
    let done = false;
    p.onData(d => { buf += d; });

    const finish = (tag, code) => {
      if (done) return;
      done = true;
      const clean = buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b[>4m\x1b[<u/g, '').replace(/\x1b[][()#;?]*[a-zA-Z0-9]/g, '');
      console.log('  [' + tag + '] code=' + code + '  输出 ' + buf.length + ' 字符');
      if (clean.trim()) {
        console.log('  内容:');
        console.log(clean.trim().split('\n').slice(0, 8).map(l => '    ' + l.slice(0, 100)).join('\n'));
      }
      resolve();
    };

    p.onExit(e => finish('exit', e.exitCode));
    setTimeout(() => {
      if (!done) {
        finish('alive', '(存活)');
        try { p.kill(); } catch (e) { /* ignore */ }
      }
    }, timeoutMs);
  });
}

(async () => {
  console.log('═══ dsh-TUI 启动链路验证 ═══');
  console.log();

  // ① 不 resume（全新会话，最干净的测试）
  await run('不 resume（全新会话）', '', 12000);
  console.log();

  // ② resume 一个空闲会话（用别的场景的会话，避开当前对话）
  const idleSession = 'session-6b9e702a-f8ac-47b9-b3bf-39c600f6160d';  // command 场景
  await run('resume 空闲会话（命令场景）', idleSession, 12000);

  process.exit(0);
})();
