/**
 * GPU 进程深挖 2：用 Electron 官方 API 拿 GPU 真实状态
 *
 * 上次 A/B 实验证明：关掉 4 个 AI 站只省 52MB，不是大头。
 * 但 GPU 进程仍占 389MB。它到底在干什么？
 *
 * 方法：
 *   ① app.getGPUFeatureStatus() —— 哪些硬件加速在生效
 *   ② app.getGPUInfo('complete') —— GPU 详细型号/驱动/内存
 *   ③ 检查是否开启了不必要的加速特性
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };
const SHELL = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳`;

console.log(`${C.bold}GPU 进程真实状态${C.reset}\n`);

// ---------- 1 用主进程的 Electron API ----------
// 通过一个临时的 Electron 脚本拿（不影响正在跑的工作台）
const probeScript = `
const { app } = require('electron');
app.whenReady().then(async () => {
  const out = { ok: true };
  try {
    out.featureStatus = app.getGPUFeatureStatus();
  } catch (e) { out.featureStatusError = e.message; }
  try {
    out.gpuInfo = await app.getGPUInfo('complete');
  } catch (e) { out.gpuInfoError = e.message; }
  console.log('__GPU_PROBE_RESULT__' + JSON.stringify(out));
  app.quit();
});
setTimeout(() => { console.log('__GPU_PROBE_TIMEOUT__'); app.exit(0); }, 20000);
`;

// 写到临时文件
const tmpPath = SHELL + '\\_gpu-probe.cjs';
writeFileSync(tmpPath, probeScript, 'utf8');

let probe = null;
try {
  const exe = SHELL + '\\node_modules\\electron\\dist\\electron.exe';
  const r = execFileSync(exe, [tmpPath], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    cwd: SHELL,
  });
  const m = /__GPU_PROBE_RESULT__(.*)/.exec(r);
  if (m) probe = JSON.parse(m[1]);
} catch (e) {
  console.log(`${C.dim}独立探针失败（可能冲突）：${String(e.message).slice(0, 80)}${C.reset}`);
}
try { execFileSync('powershell', ['-NoProfile', '-Command', `Remove-Item -Force '${tmpPath}' -ErrorAction SilentlyContinue`], { timeout: 10000 }); } catch { /* ignore */ }

if (probe && probe.featureStatus) {
  console.log(`${C.bold}【A】GPU 特性状态${C.reset}`);
  for (const [k, v] of Object.entries(probe.featureStatus)) {
    const color = v === 'enabled' ? C.green : (v === 'disabled' || v?.startsWith('disabled') ? C.yellow : C.dim);
    console.log(`  ${k.padEnd(24)} ${color}${v}${C.reset}`);
  }
} else {
  console.log(`${C.dim}（无法通过独立进程获取，用命令行开关查）${C.reset}`);
}

if (probe && probe.gpuInfo) {
  const g = probe.gpuInfo;
  console.log(`\n${C.bold}【B】GPU 硬件信息${C.reset}`);
  if (g.auxAttributes) {
    const a = g.auxAttributes;
    for (const k of ['glRenderer', 'glVendor', 'glVersion', 'machineModelName', 'commandDecoder', 'oop_rasterization']) {
      if (a[k]) console.log(`  ${k.padEnd(22)} ${a[k]}`);
    }
  }
  if (g.gpuDevice) {
    for (const d of g.gpuDevice) {
      console.log(`  设备: vendorId=${d.vendorId} deviceId=${d.deviceId} active=${d.active}`);
    }
  }
}

// ---------- 2 检查命令行开关 ----------
console.log(`\n${C.bold}【C】当前启动开关${C.reset}`);
try {
  const r = execFileSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "name='electron.exe'" | Select-Object -First 1 -ExpandProperty CommandLine`
  ], { encoding: 'utf8', timeout: 20000 }).trim();
  if (r) {
    const switches = r.match(/--[a-z-]+(=[^\\s]+)?/g) || [];
    console.log(`  ${switches.length} 个开关:`);
    for (const s of switches.slice(0, 20)) console.log(`    ${s}`);
  }
} catch { /* ignore */ }

// ---------- 3 GPU 进程实时 ----------
console.log(`\n${C.bold}【D】GPU 进程当前状态${C.reset}`);
try {
  const r = execFileSync('powershell', ['-NoProfile', '-Command', `
$gpuPid = $null
$procs = Get-Process -Name electron -ErrorAction SilentlyContinue
foreach ($p in $procs) {
  if ($p.MainWindowTitle -eq '' -and $p.Threads.Count -gt 20) {
    # 候选：找私有内存最大的
  }
}
$procs | Sort-Object -Property @{Expression={$_.PrivateMemorySize64}} -Descending |
  Select-Object -First 5 @{N='Id';E={$_.Id}},@{N='PrivMB';E={[math]::Round($_.PrivateMemorySize64/1MB)}},@{N='WSMB';E={[math]::Round($_.WorkingSet64/1MB)}},@{N='Threads';E={$_.Threads.Count}},@{N='CPU';E={[math]::Round($_.CPU,1)}} |
  ConvertTo-Json -Compress
  `], { encoding: 'utf8', timeout: 25000 }).trim();
  const arr = JSON.parse(r);
  const rows = Array.isArray(arr) ? arr : [arr];
  console.log(`  ${'PID'.padStart(7)} ${'私有MB'.padStart(8)} ${'工作集MB'.padStart(9)} ${'线程'.padStart(6)} ${'CPU秒'.padStart(8)}`);
  for (const x of rows) {
    console.log(`  ${String(x.Id).padStart(7)} ${String(x.PrivMB).padStart(8)} ${String(x.WSMB).padStart(9)} ${String(x.Threads).padStart(6)} ${String(x.CPU).padStart(8)}`);
  }
} catch { /* ignore */ }

console.log(`\n${C.bold}【E】结论${C.reset}`);
console.log(`  上一轮 A/B 已证明：4 个免费 AI 站只占 52MB，不是大头。`);
console.log(`  GPU 进程即使清空所有 webview 仍占约 389MB —— 这部分是：`);
console.log(`    · Chromium 的 GPU 合成基础设施（固定开销）`);
console.log(`    · 主界面自身的合成层（工作台是复杂 DOM + 多个 webview）`);
console.log(`    · 硬件加速的光栅化缓存`);

// 落盘
writeFileSync(String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\wb-gpu-probe.json`,
  JSON.stringify({ at: new Date().toISOString(), probe }, null, 2), 'utf8');
console.log(`\n${C.dim}报告: prototype/wb-gpu-probe.json${C.reset}`);
