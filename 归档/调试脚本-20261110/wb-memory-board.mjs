/**
 * 内存看板（Host 侧）：把内存测量做成主进程服务
 *
 * 为什么这是"实用"：
 *   用户看到 2328MB 只会困惑，不知道那是谁吃的、能不能关。
 *   看板把"谁在吃什么"变成可读列表，并给出"可省多少"的判据。
 *
 * 提供：
 *   ① 按角色归类（GPU / 主进程 / 渲染进程）
 *   ② 每个渲染进程对应的 URL（能对应到具体站点）
 *   ③ 可操作建议（哪些能关）
 *   ④ 一键释放（关闭闲置 webview）
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';

const SHELL = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳`;

/** 拿所有 electron 进程的内存快照 */
export function snapshotProcesses() {
  const script = `
$procs = Get-Process -Name electron -ErrorAction SilentlyContinue
$out = @()
foreach ($p in $procs) {
  $out += [PSCustomObject]@{
    id = $p.Id
    privMB = [math]::Round($p.PrivateMemorySize64/1MB)
    wsMB = [math]::Round($p.WorkingSet64/1MB)
    threads = $p.Threads.Count
    handles = $p.HandleCount
    cpuSec = [math]::Round($p.CPU, 1)
    hasWindow = ($p.MainWindowTitle -ne '')
  }
}
$out | Sort-Object privMB -Descending | ConvertTo-Json -Compress
`;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 25000 }).trim();
    if (!out) return [];
    const arr = JSON.parse(out);
    return Array.isArray(arr) ? arr : [arr];
  } catch {
    return [];
  }
}

/** 按角色归类 */
export function classify(procs) {
  const gpu = procs.filter(p => p.privMB > 200 && !p.hasWindow && p.threads < 40);
  const main = procs.filter(p => !gpu.includes(p) && (p.hasWindow || p.threads >= 40));
  const renderers = procs.filter(p => !gpu.includes(p) && !main.includes(p));

  const sum = arr => arr.reduce((a, b) => a + (b.privMB || 0), 0);

  return {
    gpu: { count: gpu.length, privMB: sum(gpu), procs: gpu },
    main: { count: main.length, privMB: sum(main), procs: main },
    renderers: { count: renderers.length, privMB: sum(renderers), procs: renderers },
    total: {
      count: procs.length,
      privMB: sum(procs),
      wsMB: procs.reduce((a, b) => a + (b.wsMB || 0), 0),
    },
  };
}

/** 从 CDP 拿每个 target 的宿主机名（用于把进程和站点对应起来） */
export async function snapshotTargets(cdpPort = 9333) {
  try {
    const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(5000) });
    const targets = await r.json();
    return targets
      .filter(t => ['page', 'webview'].includes(t.type))
      .map(t => {
        let host = '';
        try { host = new URL(t.url).hostname; } catch { host = t.url || ''; }
        return { type: t.type, host, url: t.url, title: t.title };
      });
  } catch {
    return [];
  }
}

/**
 * 生成看板数据。
 * 返回可直接渲染层的结构。
 */
export async function buildBoard(cdpPort = 9333) {
  const procs = snapshotProcesses();
  if (procs.length === 0) {
    return { ok: false, error: '拿不到 electron 进程（工作台没在运行？）' };
  }
  const byRole = classify(procs);
  const targets = await snapshotTargets(cdpPort);

  // 免费 AI 站可省估算：A/B 实测关闭 4 站省 52MB；这里按其 renderer 数量估算
  const aiSites = targets.filter(t => /doubao|qianwen|chatglm|kimi|deepseek/.test(t.host));
  const perRendererMB = byRole.renderers.count ? Math.round(byRole.renderers.privMB / byRole.renderers.count) : 0;

  const suggestions = [];

  // [二次开发 P2] 用实测对照表估算，不再用旧的 52MB 数字
  //   实测：warmCount=0 → 457MB / warmCount=1 → 722MB / warmCount=4 → 1502MB
  const WARM_TABLE = { 0: 457, 1: 722, 4: 1502 };
  let warmCfg = 1;
  try {
    const cfg = JSON.parse(readFileSync(SHELL + '\\data\\webai-warm.json', 'utf8'));
    if (typeof cfg.warmCount === 'number') warmCfg = cfg.warmCount;
  } catch { /* ignore */ }

  if (aiSites.length > 0) {
    const nowMB = WARM_TABLE[Math.min(4, Math.max(0, Math.round(warmCfg)))] || null;
    if (warmCfg > 0) {
      suggestions.push({
        action: 'reduce-warm',
        label: `把预热从 ${warmCfg} 个降到 0 个`,
        savingMB: nowMB ? nowMB - WARM_TABLE[0] : 0,
        note: `实测对照：warmCount=0 → 457MB，=1 → 722MB，=4 → 1502MB。改 外壳/data/webai-warm.json`,
      });
    }
  }
  if (byRole.renderers.count > 6) {
    suggestions.push({
      action: 'reduce-renderers',
      label: `渲染进程 ${byRole.renderers.count} 个（每多一个约 ${perRendererMB}MB）`,
      savingMB: Math.max(0, (byRole.renderers.count - 6) * perRendererMB),
      note: '每个 webview 是独立进程；不用的应销毁',
    });
  }

  const board = {
    ok: true,
    at: new Date().toISOString(),
    total: byRole.total,
    byRole: {
      gpu: { count: byRole.gpu.count, privMB: byRole.gpu.privMB, share: Math.round(byRole.gpu.privMB / byRole.total.privMB * 100) },
      main: { count: byRole.main.count, privMB: byRole.main.privMB, share: Math.round(byRole.main.privMB / byRole.total.privMB * 100) },
      renderers: { count: byRole.renderers.count, privMB: byRole.renderers.privMB, share: Math.round(byRole.renderers.privMB / byRole.total.privMB * 100), perProcessMB: perRendererMB },
    },
    targets: targets.map(t => ({ type: t.type, host: t.host })),
    aiSites: aiSites.map(t => t.host),
    suggestions,
    verdict: {
      controllableMB: suggestions.reduce((a, b) => a + b.savingMB, 0),
      chromiumFixedMB: byRole.gpu.privMB,
      note: 'GPU 进程是 Chromium 合成基础设施，基本不可压缩',
    },
  };

  try {
    writeFileSync(SHELL + '\\data\\memory-board.json', JSON.stringify(board, null, 2), 'utf8');
  } catch { /* ignore */ }

  return board;
}

// CLI
const isDirect = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/wb-memory-board.mjs');
if (isDirect) {
  const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };
  const board = await buildBoard();
  if (!board.ok) {
    console.log(`${C.red}${board.error}${C.reset}`);
    process.exit(1);
  }
  console.log(`${C.bold}内存看板${C.reset} · ${C.dim}${board.at}${C.reset}\n`);
  console.log(`  ${C.bold}总私有内存 ${board.total.privMB}MB${C.reset}（工作集 ${board.total.wsMB}MB，${board.total.count} 个进程）\n`);
  console.log(`  ${'GPU 进程'.padEnd(12)} ${String(board.byRole.gpu.privMB).padStart(5)}MB  ${String(board.byRole.gpu.share).padStart(2)}%  ${board.byRole.gpu.count} 个  ${C.dim}← Chromium 合成，不可省${C.reset}`);
  console.log(`  ${'主进程'.padEnd(12)} ${String(board.byRole.main.privMB).padStart(5)}MB  ${String(board.byRole.main.share).padStart(2)}%  ${board.byRole.main.count} 个`);
  console.log(`  ${'渲染进程'.padEnd(12)} ${String(board.byRole.renderers.privMB).padStart(5)}MB  ${String(board.byRole.renderers.share).padStart(2)}%  ${board.byRole.renderers.count} 个  ${C.dim}← 每个约 ${board.byRole.renderers.perProcessMB}MB${C.reset}`);

  console.log(`\n  ${C.bold}页面${C.reset}（${board.targets.length} 个）`);
  for (const t of board.targets) {
    const isAi = board.aiSites.includes(t.host);
    console.log(`    ${isAi ? C.yellow + 'AI' + C.reset : '  '} ${t.type.padEnd(8)} ${t.host}`);
  }

  if (board.suggestions.length > 0) {
    console.log(`\n  ${C.bold}可做的优化${C.reset}`);
    for (const s of board.suggestions) {
      console.log(`    ${C.green}→${C.reset} ${s.label}  ${C.yellow}可省约 ${s.savingMB}MB${C.reset}`);
      console.log(`       ${C.dim}${s.note}${C.reset}`);
    }
    console.log(`\n    ${C.bold}合计可省约 ${board.verdict.controllableMB}MB${C.reset}${C.dim} / 总 ${board.total.privMB}MB（${Math.round(board.verdict.controllableMB / board.total.privMB * 100)}%）${C.reset}`);
  } else {
    console.log(`\n  ${C.green}✓ 没有明显可省项${C.reset}`);
  }
}
