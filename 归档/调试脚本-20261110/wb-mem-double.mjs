/**
 * 诊断：为什么重启后内存翻倍
 *
 * 现象：
 *   重启前：GPU 387MB(1个) + 渲染 500MB(11个) = 990MB 私有
 *   重启后：GPU 675MB(2个) + 渲染 901MB(10个) = 1676MB 私有
 *
 * 差 686MB。可能原因：
 *   ① 刚启动，缓存还没稳定
 *   ② 两个 GPU 进程（旧的没退干净？）
 *   ③ 免费 AI 站正在初次加载（页面在跑 JS）
 *
 * 验证：等 30 秒再量，看是否回落。
 */

import { execFileSync } from 'node:child_process';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

function measure() {
  const script = `
$procs = Get-Process -Name electron -ErrorAction SilentlyContinue
$out = @()
foreach ($p in $procs) {
  $out += [PSCustomObject]@{
    id = $p.Id
    privMB = [math]::Round($p.PrivateMemorySize64/1MB)
    wsMB = [math]::Round($p.WorkingSet64/1MB)
    threads = $p.Threads.Count
    cpuSec = [math]::Round($p.CPU, 1)
    hasWindow = ($p.MainWindowTitle -ne '')
    startTicks = $p.StartTime.Ticks
  }
}
$out | Sort-Object privMB -Descending | ConvertTo-Json -Compress
`;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 25000 }).trim();
    const arr = JSON.parse(out || '[]');
    return Array.isArray(arr) ? arr : [arr];
  } catch { return []; }
}

function summarize(procs, label) {
  const total = procs.reduce((a, b) => a + b.privMB, 0);
  const gpu = procs.filter(p => p.privMB > 250 && !p.hasWindow);
  const main = procs.filter(p => p.hasWindow || (p.threads >= 40 && !gpu.includes(p)));
  const render = procs.filter(p => !gpu.includes(p) && !main.includes(p));
  const sum = a => a.reduce((x, y) => x + y.privMB, 0);
  console.log(`\n${C.bold}${label}${C.reset}`);
  console.log(`  进程 ${procs.length} 个 · 私有 ${total}MB`);
  console.log(`  GPU ${gpu.length}个/${sum(gpu)}MB · 主 ${main.length}个/${sum(main)}MB · 渲染 ${render.length}个/${sum(render)}MB`);
  console.log(`  TOP5:`);
  for (const p of procs.slice(0, 5)) {
    console.log(`    PID ${String(p.id).padStart(6)} ${String(p.privMB).padStart(4)}MB ${String(p.threads).padStart(3)}线程 ${String(p.cpuSec).padStart(7)}s ${p.hasWindow ? '窗口' : ''}`);
  }
  return { total, gpu: gpu.length, gpuMB: sum(gpu), render: render.length, renderMB: sum(render) };
}

console.log(`${C.bold}内存翻倍诊断${C.reset}`);

const t0 = summarize(measure(), '【T+0】刚重启后');

for (const wait of [15, 30, 45]) {
  console.log(`\n${C.dim}等待 ${wait} 秒…${C.reset}`);
  await new Promise(r => setTimeout(r, wait * 1000));
  const t = summarize(measure(), `【T+${wait}】`);
  console.log(`  ${C.dim}vs T+0: 私有 ${t.total - t0.total >= 0 ? '+' : ''}${t.total - t0.total}MB · GPU ${t.gpu}个 · 渲染 ${t.render}个${C.reset}`);
}

console.log(`\n${C.bold}结论${C.reset}`);
const final = measure();
const fin = summarize(final, '【最终】');
if (fin.total < 1200) {
  console.log(`  ${C.green}✓ 内存已回落（启动期加载的临时占用）${C.reset}`);
} else if (fin.gpu > 1) {
  console.log(`  ${C.yellow}! 仍有 ${fin.gpu} 个 GPU 进程 —— 可能是上次实例没退干净${C.reset}`);
  console.log(`     ${C.dim}检查：是否有残留的 electron 进程${C.reset}`);
  const old = final.filter(p => (Date.now() / 1000 - p.startTicks / 1e7) > 1200);
  if (old.length > 0) {
    console.log(`     ${C.red}发现 ${old.length} 个启动超过 20 分钟的进程（可能是残留）：${old.map(p => p.id).join(', ')}${C.reset}`);
  }
} else {
  console.log(`  ${C.yellow}~ 内存仍高（${fin.total}MB），需进一步分析${C.reset}`);
}

const { writeFileSync } = await import('node:fs');
writeFileSync(String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\wb-mem-double.json`,
  JSON.stringify({ at: new Date().toISOString(), t0, final: fin, processes: final }, null, 2), 'utf8');
