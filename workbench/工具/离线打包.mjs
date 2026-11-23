/**
 * 完全离线的打包脚本
 *
 * 为什么不用 electron-builder
 * ──────────────────────────────────────────────────────────────────
 * electron-builder 每次打包都要向 GitHub 请求 electron 包（215MB），
 * 这个环境网络极不稳定，实测反复失败：
 *   ⨯ connect ETIMEDOUT 20.205.243.166:443
 *   ⨯ read ECONNRESET
 *   ⨯ Timeout awaiting 'request' for 600000ms
 *   ⨯ downloaded label=electron progress=100%  ← 卡在这一步
 *
 * 而**本地已经有全套东西**：
 *   · node_modules/electron/dist/  347 MB 完整 Electron 运行时（含 electron.exe）
 *   · 引擎/node_modules/           428 MB
 *   · 数据模板、工具、外壳代码
 *
 * 所以：手工组装产物目录，不依赖 electron-builder，零网络。
 *
 * 做法
 * ──────────────────────────────────────────────────────────────────
 * 1. 复制 electron/dist 全部内容到 dist3/win-unpacked/
 * 2. 把 electron.exe 改名为「DSH 工作台.exe」
 * 3. 用 @electron/asar 打 app.asar（外壳代码 + 运行时依赖）
 * 4. 复制 引擎/ 工具/ 数据模板/
 * 5. 生成启动器
 *
 * 用法：node 工具/离线打包.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('D:/file/AI Temp/DeepSeek/Agent自研/workbench/外壳/');
const asar = require('@electron/asar');

const WB = 'D:/file/AI Temp/DeepSeek/Agent自研/workbench';
const SHELL = path.join(WB, '外壳');
const OUT = 'D:/file/AI Temp/DeepSeek/Agent自研/dist3';
const APP = path.join(OUT, 'win-unpacked');
const RES = path.join(APP, 'resources');

const log = (s) => console.log('  ' + s);
const step = (n, s) => { console.log(); console.log('  【' + n + '】' + s); };

console.log('='.repeat(76));
console.log('  完全离线打包（零网络）');
console.log('='.repeat(76));

// ══ 0. 前置检查 ══
step(0, '前置检查');
const ELECTRON_DIST = path.join(SHELL, 'node_modules', 'electron', 'dist');
const checks = [
  ['electron/dist', ELECTRON_DIST],
  ['electron.exe', path.join(ELECTRON_DIST, 'electron.exe')],
  ['引擎/node_modules', path.join(WB, '引擎', 'node_modules')],
  ['引擎 CLI', path.join(WB, '引擎', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')],
  ['外壳 main.js', path.join(SHELL, 'main.js')],
];
let ok = true;
for (const [name, p] of checks) {
  const exists = fs.existsSync(p);
  log((exists ? '✓' : '✗') + ' ' + name);
  if (!exists) ok = false;
}
if (!ok) { console.log('\n  ⛔ 前置条件不满足，中止'); process.exit(1); }

// ══ 1. 清空输出 ══
step(1, '准备输出目录');
if (fs.existsSync(APP)) {
  try { fs.rmSync(APP, { recursive: true, force: true }); } catch (e) {
    console.log('  ⛔ 无法清空旧产物（可能被占用）: ' + e.message);
    console.log('     请先关掉正在运行的 DSH 工作台');
    process.exit(1);
  }
}
fs.mkdirSync(APP, { recursive: true });
log('✓ ' + APP);

// ══ 2. 复制 Electron 运行时 ══
step(2, '复制 Electron 运行时（347 MB）');
const t0 = Date.now();
fs.cpSync(ELECTRON_DIST, APP, { recursive: true, force: true });
log('✓ 完成，耗时 ' + Math.round((Date.now() - t0) / 1000) + ' 秒');

// ══ 3. 改名 exe ══
step(3, '生成应用入口 exe');
const srcExe = path.join(APP, 'electron.exe');
const dstExe = path.join(APP, 'DSH 工作台.exe');
if (!fs.existsSync(srcExe)) { console.log('  ⛔ 找不到 electron.exe'); process.exit(1); }
fs.renameSync(srcExe, dstExe);
log('✓ DSH 工作台.exe');

// ══ 4. 打包 app.asar ══
step(4, '打包 app.asar');
const toPack = new Set();
for (const f of ['main.js', 'preload.js', 'fault-handlers.cjs', 'tui-bridge.cjs', 'crash.js', 'package.json']) {
  if (fs.existsSync(path.join(SHELL, f))) toPack.add(f);
}
function collect(dir, out, depth) {
  if (depth > 6) return;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { collect(full, out, depth + 1); continue; }
    if (/\.(md|map|ts|tsx)$/i.test(e.name)) continue;
    if (e.name.startsWith('.')) continue;
    if (/\.node$/i.test(e.name)) continue;   // 原生模块不进 asar
    out.add(path.relative(SHELL, full).replace(/\\/g, '/'));
  }
}
collect(path.join(SHELL, 'scripts'), toPack, 0);
collect(path.join(SHELL, 'ui'), toPack, 0);
// ⚠ 2026-11-14 修：**scenarios/ 之前完全没被收集**
//
//   实测后果（打包版截图）：左侧一片空白，场景标签 0 个，控制台报
//     [ui] 场景标签：取场景列表失败 null
//   原因是 main.js 里 `SCENARIOS_DIR = path.join(__dirname, 'scenarios')`，
//   打包后 __dirname 在 app.asar 内，而 asar 里根本没有 scenarios 目录。
//
//   asar 顶层当时只有 9 个条目：
//     crash.js, fault-handlers.cjs, main.js, node_modules, package.json,
//     preload.js, scripts, tui-bridge.cjs, ui
//   ⇒ 漏了 scenarios（12 个场景 json）
//
//   这是「清单式打包」的典型坑：每加一个资源目录都必须同步加到这里。
//   所以下面顺手加了一个自检：main.js 里出现的 __dirname 相对路径，
//   如果在 SHELL 下存在但没进 toPack，就打警告。
collect(path.join(SHELL, 'scenarios'), toPack, 0);
// 只带 JS 依赖，原生模块走 unpacked
for (const dep of ['xterm', '@xterm/addon-fit', 'electron-updater']) {
  const d = path.join(SHELL, 'node_modules', dep);
  if (fs.existsSync(d)) collect(d, toPack, 0);
}
log('待打包 ' + toPack.size + ' 个文件');

// ⚠ 2026-11-14 加自检：**扫 main.js 里所有 __dirname 相对路径，确认都被收进来了**
//
//   这次踩的坑：scenarios/ 有 12 个 json，但清单里漏了，
//   结果打包版左侧一片空白，控制台只报「取场景列表失败 null」——
//   从错误信息完全看不出是「目录没打进 asar」。
//
//   所以这里做一次静态扫描：main.js 里出现 path.join(__dirname, 'xxx') 的 xxx，
//   如果 SHELL/xxx 存在但没有任何一个文件进 toPack，就报警。
//   这是「清单式打包」必须有的自检。
try {
  const mainSrc = fs.readFileSync(path.join(SHELL, 'main.js'), 'utf8');
  const dirRefs = new Set();
  for (const m of mainSrc.matchAll(/path\.join\(__dirname,\s*'([^']+)'/g)) {
    const p = m[1];
    if (p === '..') continue;
    dirRefs.add(p.split(/[\\/]/)[0]);
  }
  const missing = [];
  for (const d of dirRefs) {
    const full = path.join(SHELL, d);
    if (!fs.existsSync(full)) continue;                    // main.js 引用了不存在的目录，不是打包问题
    if (!fs.statSync(full).isDirectory()) continue;
    // 有没有任何文件已收进 toPack？
    const any = [...toPack].some((rel) => rel === d || rel.startsWith(d + '/'));
    if (!any) missing.push(d);
  }
  if (missing.length) {
    log('⚠ 警告：main.js 引用了这些目录，但它们**没有任何文件进 asar**：');
    for (const d of missing) log('    - ' + d + '/');
    log('  （打包版会在运行时报「取不到」—— 但错误信息不会告诉你原因）');
  } else {
    log('✓ 资源目录自检通过（main.js 引用的 ' + dirRefs.size + ' 个目录都在包里）');
  }
} catch (e) {
  log('⚠ 资源目录自检跳过: ' + (e && e.message));
}

// ⚠ 2026-11-14 修：不能用 %TEMP%（这台机器上 mkdir 会 EPERM）
//
//   实测：fs.mkdirSync('C:\Users\15282\AppData\Local\Temp\offline-asar-...')
//         → EPERM: operation not permitted
//   原因：TEMP 目录的 ACL 不允许当前进程创建子目录（受管环境限制）。
//
//   改用项目内的临时目录：build/.tmp-asar-<ts>
//   项目目录明确可写（整个打包流程都在这里跑）。
const TMP_ROOT = path.join(SHELL, 'build');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const tmp = path.join(TMP_ROOT, '.tmp-asar-' + Date.now());
fs.mkdirSync(tmp, { recursive: true });
for (const rel of toPack) {
  const dst = path.join(tmp, rel);
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(SHELL, rel), dst);
  } catch { /* skip */ }
}
fs.mkdirSync(RES, { recursive: true });
await asar.createPackage(tmp, path.join(RES, 'app.asar'));
fs.rmSync(tmp, { recursive: true, force: true });
log('✓ app.asar  ' + (fs.statSync(path.join(RES, 'app.asar')).size / 1024 / 1024).toFixed(1) + ' MB');

// ══ 5. 原生模块 unpacked（node-pty）══
step(5, '复制原生模块到 unpacked');
const unpacked = path.join(RES, 'app.asar.unpacked', 'node_modules');
const ptySrc = path.join(SHELL, 'node_modules', 'node-pty');
const ptyDst = path.join(unpacked, 'node-pty');
if (fs.existsSync(ptySrc)) {
  fs.mkdirSync(path.dirname(ptyDst), { recursive: true });
  fs.cpSync(ptySrc, ptyDst, { recursive: true, force: true });
  const hasNode = fs.existsSync(path.join(ptyDst, 'prebuilds', 'win32-x64', 'pty.node'));
  log((hasNode ? '✓' : '⚠') + ' node-pty → app.asar.unpacked  (pty.node: ' + (hasNode ? '有' : '缺') + ')');
} else {
  log('⚠ 没有 node-pty（终端面板会不可用，但主界面正常）');
}

// ══ 6. 复制引擎 ══
step(6, '复制引擎（521 MB）');
const t1 = Date.now();
fs.cpSync(path.join(WB, '引擎'), path.join(RES, '引擎'), { recursive: true, force: true });
log('✓ 完成，耗时 ' + Math.round((Date.now() - t1) / 1000) + ' 秒');
log('  CLI: ' + (fs.existsSync(path.join(RES, '引擎', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')) ? '✓' : '✗'));

// ══ 7. 复制工具 ══
step(7, '复制工具');
const toolsDst = path.join(RES, '工具');
fs.mkdirSync(toolsDst, { recursive: true });
let toolCount = 0;
for (const f of fs.readdirSync(path.join(WB, '工具'))) {
  if (!f.endsWith('.mjs')) continue;
  try { fs.copyFileSync(path.join(WB, '工具', f), path.join(toolsDst, f)); toolCount++; } catch { /* ignore */ }
}
log('✓ ' + toolCount + ' 个 .mjs');

// ══ 7.5 复制 sceneboard（管线 / 场景看板定义）══
//
// ⚠ 2026-11-14 加：之前**完全没带**，导致打包版左侧「管线位置」面板空白：
//   「没有读到任何管线 / 预期位置: workbench/sceneboard/pipelines/*.json」
//
//   main.js 里 sf:pipelines / sf:scenes 等 handler 用
//   path.resolve(__dirname, '..') 找 sceneboard，
//   打包后 __dirname 在 app.asar 内 → '..' = resources/ → 读不到。
//   现在统一走 _WB_ROOT（= APP_RES when packaged），
//   所以 sceneboard 必须放在 resources/sceneboard。
step('7.5', '复制 sceneboard（管线/看板定义）');
{
  const srcBoard = path.join(WB, 'sceneboard');
  const dstBoard = path.join(RES, 'sceneboard');
  if (fs.existsSync(srcBoard)) {
    fs.cpSync(srcBoard, dstBoard, { recursive: true, force: true });
    const nPipe = fs.existsSync(path.join(dstBoard, 'pipelines'))
      ? fs.readdirSync(path.join(dstBoard, 'pipelines')).filter((f) => f.endsWith('.json')).length : 0;
    const nScene = fs.existsSync(path.join(dstBoard, 'scenes'))
      ? fs.readdirSync(path.join(dstBoard, 'scenes')).filter((f) => f.endsWith('.json')).length : 0;
    log('✓ sceneboard: ' + nPipe + ' 条管线 / ' + nScene + ' 个看板定义');
  } else {
    log('⚠ sceneboard 不存在，跳过');
  }
}

// ══ 8. 数据模板 ══
step(8, '复制数据模板（排除运行时数据）');
const DATA_SRC = path.join(WB, '数据');
const DATA_DST = path.join(RES, '数据模板');
function copyData(src, dst) {
  let ents = [];
  try { ents = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    const rel = path.relative(DATA_SRC, s).replace(/\\/g, '/');
    // 排除运行时数据
    if (/(^|\/)(sessions|storages|缓存|\.dsh-temp)(\/|$)/.test(rel)) continue;
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyData(s, d); }
    else { try { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d); } catch { /* ignore */ } }
  }
}
fs.mkdirSync(DATA_DST, { recursive: true });
copyData(DATA_SRC, DATA_DST);
log('✓ 场景记忆: ' + (fs.existsSync(path.join(DATA_DST, '.dsh', '场景记忆')) ? '有' : '缺'));
log('✓ 技能:     ' + (fs.existsSync(path.join(DATA_DST, '.dsh', 'skills')) ? '有' : '缺'));

// ══ 9. 启动器 ══
step(9, '生成启动器');
const cmd = [
  '@echo off',
  'rem DSH Workbench launcher (offline build)',
  'setlocal',
  'set ELECTRON_RUN_AS_NODE=',
  'set DSH_SKIP_SINGLE_LOCK=1',
  'cd /d "%~dp0"',
  'for %%F in ("DSH*.exe") do (',
  '  start "" "%%~fF" --no-sandbox --disable-gpu --disable-gpu-compositing --disable-software-rasterizer',
  ')',
  'endlocal',
].join('\r\n');
fs.writeFileSync(path.join(APP, 'START-DSH.cmd'), cmd, 'ascii');
log('✓ START-DSH.cmd');

const readme = [
  'DSH 工作台 —— 启动说明',
  '='.repeat(40),
  '',
  '启动：双击 START-DSH.cmd',
  '',
  '为什么不直接双击 exe：',
  '  1) 系统若残留 ELECTRON_RUN_AS_NODE=1，Electron 会退化成纯 Node（不加载界面）',
  '  2) 这台机器的 Electron 沙箱初始化会崩（STATUS_ACCESS_VIOLATION）',
  '  启动器会清掉前者、加上 --no-sandbox 规避后者。',
  '',
  '数据位置：%APPDATA%\\DSH-Workbench\\',
  '  server.log   引擎日志（出问题先看这个）',
  '  data\\        你的场景记忆（升级不覆盖）',
  '',
  '卸载：删掉本目录即可。数据保留在 %APPDATA%\\DSH-Workbench\\。',
].join('\r\n');
fs.writeFileSync(path.join(APP, 'README-START.txt'), readme, 'utf8');
log('✓ README-START.txt');

// ══ 10. 汇总 ══
step(10, '汇总');
const totalMB = Math.round(
  (function sizeOf(d) {
    let s = 0;
    const walk = (dir) => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else { try { s += fs.statSync(f).size; } catch { /* ignore */ } }
      }
    };
    walk(d);
    return s;
  })(APP) / 1024 / 1024
);
console.log();
console.log('  产物: ' + APP);
console.log('  大小: ' + totalMB + ' MB');
console.log();
console.log('  关键检查:');
for (const [name, p] of [
  ['exe', path.join(APP, 'DSH 工作台.exe')],
  ['app.asar', path.join(RES, 'app.asar')],
  ['引擎 CLI', path.join(RES, '引擎', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')],
  ['启动器', path.join(APP, 'START-DSH.cmd')],
]) {
  console.log('    ' + (fs.existsSync(p) ? '✓' : '✗') + ' ' + name);
}
console.log();
console.log('='.repeat(76));
console.log('  ✓ 离线打包完成');
