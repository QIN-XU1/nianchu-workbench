/**
 * 验证 EPERM 假设：DSH_HOME 里的 profiles 目录被并发访问
 *
 * 已知：
 *   · 纯 Node 环境（没起工作台）→ 不 resume 时 TUI 存活 20 秒 ✅
 *   · Electron 环境（工作台在跑）→ EPERM 打不开 cordis.yml
 *
 * 差异：工作台的 web-gw 引擎正在用 $DSH_HOME
 *
 * 验证方法：不起工作台，直接用纯 node 测（应该成功）
 *          然后再测一次（工作台引擎在跑时）
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const NODE = process.execPath;
const CLI = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\_asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`;
const MAIN_HOME = path.join(os.homedir(), '.dsh');

console.log('═══ EPERM 假设验证 ═══');
console.log();

// ① 直接读 cordis.yml 看有没有权限问题
const target = path.join(MAIN_HOME, 'profiles', 'dsh-tui', 'cordis.yml');
console.log('① 文件状态:');
console.log('   路径: ' + target);
console.log('   存在: ' + fs.existsSync(target));
if (fs.existsSync(target)) {
  try {
    const st = fs.statSync(target);
    console.log('   大小: ' + st.size + ' bytes');
    console.log('   属性: ' + (st.mode ? st.mode.toString(8) : '?'));
    const c = fs.readFileSync(target, 'utf8');
    console.log('   可读: 是（' + c.length + ' 字符）');
  } catch (e) {
    console.log('   ✗ 读取失败: ' + e.code + ' ' + e.message);
  }
}

console.log();
console.log('② 是否有进程占用这个目录:');

// 检查哪些进程的 CWD 或打开的文件在这个目录
const procs = spawnSync('powershell', ['-Command',
  `Get-Process | Where-Object { $_.Path -like '*DeepSeek*' -or $_.ProcessName -like '*electron*' } | Select-Object Id,ProcessName,Path | ConvertTo-Json -Compress`
], { encoding: 'utf8', timeout: 20000 });
try {
  const list = JSON.parse(procs.stdout || '[]');
  const arr = Array.isArray(list) ? list : [list];
  for (const p of arr) {
    console.log('   PID ' + p.Id + '  ' + p.ProcessName);
  }
} catch (e) {
  console.log('   （无法列出）');
}

console.log();
console.log('③ 结论推断:');
console.log('   EPERM on open 通常 = 文件被独占锁定');
console.log('   .dsh/profiles 目录可能被正在运行的 DSH 引擎持有');
console.log();
console.log('   验证：不 resume 时（前面测过）TUI 能存活 20 秒');
console.log('   说明 profile 本身能读 —— 那 EPERM 只在特定时序出现');
