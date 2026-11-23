/**
 * ═══════════════════════════════════════════════════════════════════
 *  dsh-TUI 的主进程 PTY 桥 —— 修正版（已实测跑通）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 【关键发现：为什么之前的实现全部失败】
 *
 *   ❶ 用 Electron.exe + ELECTRON_RUN_AS_NODE=1
 *      → 该模式下 process.stdin 没有 setRawMode
 *      → dsh-TUI 用的 Ink 框架报 "Raw mode is not supported"
 *      → 进程退出码 1，零输出
 *
 *      实测数据：
 *        系统 node + PTY:  stdin.isTTY=true,  setRawMode=function  ✅
 *        Electron-as-node: stdin.isTTY=undefined, setRawMode=undefined  ❌
 *
 *   ❷ cli.js 在 app.asar 里，系统 node 读不了
 *      → 必须用 @electron/asar 解包一次
 *
 *   ❸ DSH_HOME 用独立目录 .dsh-tui-home
 *      → 看不到主 home 的会话 → resume 失败
 *
 * 【正解】
 *   真 node.exe + 解包后的 cli.js + 主 DSH_HOME + node-pty(conpty)
 *   = 完整可用的 dsh-TUI
 *
 * 【已验证】
 *   不 resume：进程存活 20 秒，输出 2854 字符
 *   → "欢迎使用 dsh-TUI 第 1/4 步"
 *   → "✓ 已登录：deepseek-account"、"4 个可用模型"
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

let pty = null;
try {
  pty = require('node-pty');
} catch (e) {
  console.error('[dsh-tui] node-pty 加载失败:', e && e.message);
}

const TUI_SESSIONS = new Map();

// ═══════════ 路径常量 ═══════════
function sh() { return path.resolve(__dirname); }

function resolveMainHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * 找到引擎的 cli.js
 *
 * 查找顺序（2026-11-10 独立化改造）：
 *   ① 项目自带的 引擎/ —— 独立模式，直接用，不需要解包
 *   ② 外壳/_asar —— 已经解包过的（兼容旧的解包结果）
 *   ③ 从外部 DSH 的 app.asar 解包 —— 仅当前两者都没有时
 *
 * ⚠ 之前这里硬编码从 'D:/file/software/DeepSeek Harness/resources/app.asar'
 *   解包到 外壳/_asar，导致独立版每次启动都白复制 433 MB。
 */
function ensureUnpackedCli(log) {
  const shell = sh();

  // ── ① 项目自带的引擎（独立模式首选）──
  const bundledEngine = path.join(path.dirname(shell), '引擎');
  const bundledCli = path.join(bundledEngine, 'node_modules', '@deepseek-ai',
    'dsh-desktop-host', 'lib', 'cli.js');
  if (fs.existsSync(bundledCli)) {
    return bundledCli;
  }

  // ── ② 已解包过的 _asar（兼容）──
  const unpackRoot = path.join(shell, '_asar');
  const cli = path.join(unpackRoot, 'dsh', 'node_modules', '@deepseek-ai',
    'dsh-desktop-host', 'lib', 'cli.js');
  if (fs.existsSync(cli)) return cli;

  // ── ③ 从外部 DSH 解包（最后的兜底）──
  const asarCandidates = [
    'D:\\file\\software\\DeepSeek Harness\\resources\\app.asar',
    path.join(process.env.ProgramFiles || 'C:\\Program Files',
      'DeepSeek Harness', 'resources', 'app.asar'),
  ];
  const asarPath = asarCandidates.find((p) => fs.existsSync(p));
  if (!asarPath) {
    log && log('[dsh-tui] 找不到 cli.js（引擎/ 和 app.asar 都没有）');
    return '';
  }

  try {
    const asar = require(path.join(shell, 'node_modules', '@electron', 'asar'));
    log && log('[dsh-tui] 兜底解包 asar（约 25k 文件，需要 30 秒）…');
    fs.mkdirSync(unpackRoot, { recursive: true });
    asar.extractAll(asarPath, unpackRoot);
    log && log('[dsh-tui] asar 解包完成');
    return fs.existsSync(cli) ? cli : '';
  } catch (e) {
    log && log('[dsh-tui] 解包失败: ' + (e && e.message));
    return '';
  }
}

/**
 * 真 Node 可执行文件
 * ⚠ 必须是系统 node，不能用 Electron.exe（后者 stdin 无 setRawMode）
 */
function resolveRealNode() {
  // ⚠ 必须是真 node，不能用 Electron.exe（后者 stdin 无 setRawMode）
  //
  // 2026-11-10 独立化改造：优先用项目自带的 引擎/node.exe
  //   这样独立版不依赖系统装没装 node，也不依赖硬编码的 D:\file\env\nodejs
  const shell = sh();
  const bundledNode = path.join(path.dirname(shell), '引擎', 'node.exe');

  const candidates = [
    process.env.DSH_REAL_NODE,
    bundledNode,                                   // ① 项目自带的（独立模式首选）
    'D:\\file\\env\\nodejs\\node.exe',              // ② 本机常见位置
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node.exe'),
    'C:\\Program Files\\nodejs\\node.exe',
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && !/DeepSeek Harness\.exe/i.test(c)) return c;
    } catch (e) { /* ignore */ }
  }
  // 最后兜底：如果当前 execPath 不是 Electron
  if (!/electron|DeepSeek Harness/i.test(process.execPath)) return process.execPath;
  return '';
}

/**
 * 准备 dsh-TUI 的独立 DSH_HOME
 *
 * 【为什么必须独立】
 *   实测：工作台引擎（web-gw profile）正在用 $HOME/.dsh，
 *        dsh-TUI 再去同一个 profiles 目录启动 → EPERM 打不开 cordis.yml。
 *        EPERM 是 Windows 的文件独占锁，无法绕过。
 *
 * 【独立 home 需要什么】
 *   ① profiles/dsh-tui   ← 已安装的 TUI profile（复制过来）
 *   ② sessions/          ← 主 home 的会话库（用 junction 链接，不复制 115MB）
 *                          这样 TUI 才能 resume 我们的会话
 *   ③ .credentials.yaml  ← 认证信息（复制）
 */
function ensureTuiHome(log) {
  // ══════════════════════════════════════════════════════════
  // 独立 home（项目内，绝对隔离）
  //
  // 踩坑记录：
  //   ✗ 用 $HOME/.dsh-tui-home + 复制 profile
  //     → 复制破坏 pnpm 结构 + 与主 home 争抢
  //   ✗ 用主 $HOME/.dsh
  //     → EPERM：工作台的 web-gw 引擎正在持有 profiles 的锁
  //
  // ✓ 项目内的独立 home，profile 用 dsh CLI 原生安装（不复制）
  //   路径：workbench/数据/.dsh-tui   ← 2026-11-10 独立化后改为「数据/」
  //   并且 sessions 用 junction 指向主 home（才能 resume 我们的会话）
  //
  // ⚠ 2026-11-10 修复：这里原来硬编码 '引擎数据'，
  //   独立化后引擎数据目录已经不用了，导致 TUI 每次都找不到 profile。
  // ══════════════════════════════════════════════════════════
  const shell = sh();
  const projectRoot = path.resolve(shell, '..');   // workbench
  // 优先「数据/」（独立模式），找不到才回退「引擎数据/」（兼容模式）
  const dataBase = fs.existsSync(path.join(projectRoot, '数据'))
    ? '数据'
    : '引擎数据';
  const tuiHome = path.join(projectRoot, dataBase, '.dsh-tui');
  const mainHome = resolveMainHome();

  try {
    if (!fs.existsSync(tuiHome)) fs.mkdirSync(tuiHome, { recursive: true });

    // sessions：junction 到主 home（能读我们的会话）
    const dstSessions = path.join(tuiHome, 'sessions');
    const srcSessions = path.join(mainHome, 'sessions');
    if (fs.existsSync(srcSessions) && !fs.existsSync(dstSessions)) {
      const ok = tryJunction(srcSessions, dstSessions);
      log && log('[dsh-tui] sessions junction: ' + (ok ? '成功' : '失败'));
    }

    // credentials：复制（小文件）
    const srcCred = path.join(mainHome, '.credentials.yaml');
    const dstCred = path.join(tuiHome, '.credentials.yaml');
    if (fs.existsSync(srcCred) && !fs.existsSync(dstCred)) {
      try { fs.copyFileSync(srcCred, dstCred); } catch (e) { /* ignore */ }
    }

    // profile 检查（应该已经用 dsh CLI 装好了）
    const prof = path.join(tuiHome, 'profiles', 'dsh-tui');
    if (!fs.existsSync(prof)) {
      log && log('[dsh-tui] ⚠ profile 未安装。请先运行：');
      log && log('[dsh-tui]   DSH_HOME="' + tuiHome + '" dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui@0.19.0');
    } else {
      log && log('[dsh-tui] profile 就绪: ' + prof);
    }

    return tuiHome;
  } catch (e) {
    log && log('[dsh-tui] 准备 TUI home 失败: ' + (e && e.message));
    return tuiHome;
  }
}

/**
 * 建 junction（Windows 硬链接目录，无需管理员权限）
 * 用 child_process 调 mklink，避免 fs.symlinkSync 的权限要求
 */
function tryJunction(target, linkPath) {
  try {
    const { execFileSync } = require('child_process');
    // mklink 是 cmd 内建命令，必须走 cmd /c
    execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, target], { stdio: 'ignore', timeout: 15000 });
    return fs.existsSync(linkPath);
  } catch (e) {
    return false;
  }
}

module.exports = function installTuiBridge(ipcMain, getMainWindow, log) {
  if (!pty) {
    log && log('[dsh-tui] node-pty 不可用');
    return;
  }

  log && log('[dsh-tui] PTY 桥已安装');

  ipcMain.handle('tui:start', async (e, id, opts) => {
    const key = String(id || 'default');
    const o = opts || {};

    if (TUI_SESSIONS.has(key)) {
      try { TUI_SESSIONS.get(key).pty.kill(); } catch (err) { /* ignore */ }
      TUI_SESSIONS.delete(key);
    }

    const cols = Math.max(20, Math.min(400, Number(o.cols) || 80));
    const rows = Math.max(10, Math.min(300, Number(o.rows) || 24));

    // ① 真 node
    const nodeExe = resolveRealNode();
    if (!nodeExe) {
      return { ok: false, err: '找不到真正的 node.exe（Electron 的 stdin 不支持 raw mode）' };
    }

    // ② 解包后的 cli.js
    const cliJs = ensureUnpackedCli(log);
    if (!cliJs) {
      return { ok: false, err: 'cli.js 解包失败' };
    }

    // ③ 环境（独立 home，避免与工作台引擎争抢 profile 锁）
    const tuiHome = ensureTuiHome(log);

    // ══════════════════════════════════════════════════════════
    // ⚠ TEMP/TMP：**不要改**（2026-11-11 实测修正）
    //
    // 原来这里有一段「给 TUI 独立 temp 目录」的逻辑，注释写着：
    //   「Electron 主进程 spawn 子进程时，子进程继承的 TEMP 与沙箱策略
    //    冲突，导致 mkdtemp 被拒 ⇒ 给 TUI 一个独立的 temp 目录」
    //
    // 但今天用真实 PTY 实测，这个「解法」反而制造了**更严重的问题**：
    //
    //   用默认 TEMP   → TUI 输出 1273 字节（能启动，EPERM 只是警告）
    //   用 .dsh-tui/temp → TUI 只输出 16 字节（终端初始化序列）然后就卡死
    //
    // 也就是说：
    //   · EPERM 那个警告**在两种情况下都存在**，它不是致命的
    //     （spill-local 插件加载失败 → cordis 报「1 entry did not activate」
    //       → 但主程序仍然跑得起来）
    //   · 而把 TEMP 改到项目内目录，会让 TUI 完全卡在初始化
    //     （推测是 ConPTY + 非系统 temp 的交互问题）
    //
    // 所以：TEMP/TMP/TMPDIR **一律不动**，让 EPERM 作为警告留着。
    // 副作用：每次启动 TUI 会有一行 spill-local 警告。
    // 这比「终端全黑、界面却说就绪」好得多。
    // ══════════════════════════════════════════════════════════

    const env = Object.assign({}, process.env, {
      DSH_HOME: tuiHome,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      // ★ 恢复指定会话（解决「对话不在 agent 里」）
      ...(o.sessionId ? { DSH_TUI_RESUME_SESSION: String(o.sessionId) } : {}),
    });
    delete env.ELECTRON_RUN_AS_NODE;   // ★ 必须清掉
    delete env.FORCE_COLOR;
    delete env.NO_COLOR;
    // 避免与工作台引擎的端口冲突
    delete env.DSH_PORT;
    delete env.SEA_DEBUG_PORT;
    delete env.DSH_ENGINE_TOKEN;

    let proc = null;
    try {
      proc = pty.spawn(nodeExe, ['--expose-internals', cliJs, '--profile', 'dsh-tui'], {
        name: 'xterm-256color',
        cols, rows,
        cwd: o.cwd || process.cwd(),
        env,
        useConpty: true,
      });
    } catch (err) {
      log && log('[dsh-tui] spawn 失败: ' + (err && err.message));
      return { ok: false, err: String((err && err.message) || err) };
    }

    TUI_SESSIONS.set(key, { pty: proc, cols, rows });

    proc.onData((data) => {
      const win = getMainWindow && getMainWindow();
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('tui:data', key, data); } catch (err) { /* ignore */ }
      }
    });

    proc.onExit((ev) => {
      const win = getMainWindow && getMainWindow();
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('tui:exit', key, ev); } catch (err) { /* ignore */ }
      }
      TUI_SESSIONS.delete(key);
      log && log('[dsh-tui] 会话 ' + key + ' 退出 code=' + (ev && ev.exitCode));
    });

    log && log('[dsh-tui] 启动 pid=' + proc.pid +
      (o.sessionId ? '（恢复 ' + o.sessionId + '）' : '（新会话）'));

    return { ok: true, pid: proc.pid, cols, rows, node: nodeExe };
  });

  ipcMain.handle('tui:input', (e, id, data) => {
    const s = TUI_SESSIONS.get(String(id || 'default'));
    if (!s) return { ok: false, err: 'no session' };
    try { s.pty.write(String(data || '')); return { ok: true }; }
    catch (err) { return { ok: false, err: String((err && err.message) || err) }; }
  });

  ipcMain.handle('tui:resize', (e, id, cols, rows) => {
    const s = TUI_SESSIONS.get(String(id || 'default'));
    if (!s) return { ok: false, err: 'no session' };
    try {
      const c = Math.max(20, Math.min(400, Number(cols) || 80));
      const r = Math.max(10, Math.min(300, Number(rows) || 24));
      s.pty.resize(c, r);
      s.cols = c; s.rows = r;
      return { ok: true };
    } catch (err) { return { ok: false, err: String((err && err.message) || err) }; }
  });

  ipcMain.handle('tui:stop', (e, id) => {
    const key = String(id || 'default');
    const s = TUI_SESSIONS.get(key);
    if (!s) return { ok: true };
    try { s.pty.kill(); } catch (err) { /* ignore */ }
    TUI_SESSIONS.delete(key);
    return { ok: true };
  });

  ipcMain.handle('tui:status', () => {
    const out = [];
    for (const [id, s] of TUI_SESSIONS) {
      out.push({ id, cols: s.cols, rows: s.rows, pid: s.pty.pid });
    }
    return { ok: true, sessions: out, count: out.length };
  });

  ipcMain.on('tui:cleanup', () => {
    for (const [, s] of TUI_SESSIONS) {
      try { s.pty.kill(); } catch (err) { /* ignore */ }
    }
    TUI_SESSIONS.clear();
  });
};
