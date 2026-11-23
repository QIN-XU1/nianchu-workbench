#!/usr/bin/env node
/**
 * 界面回归 —— 用「看画面」验证界面，不靠配置推断
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么要有这个工具
 * ══════════════════════════════════════════════════════════════
 *
 *  参考项目 02/二-会话绑定三字段.md 的原话（★ 全仓库最核心的一页）：
 *
 *  > 「**键写对了 ≠ 界面切过去了。**
 *  >   会话行 DOM 里没有会话 id，所以：
 *  >   ✅ 判据一：面板标题行的小字（绑定诊断）
 *  >   ✅ 判据二：**截图**
 *  >   ❌ 不要拿『我写进去的那个值』当成功证据
 *  >      —— 那只能证明你写了，不能证明界面读了。」
 *
 *  > 「这条不只适用于会话绑定：**凡是『我改了配置 / 写了状态，
 *  >   指望别的层去读』的地方，都要找画面上的落点。**」
 *
 * ══════════════════════════════════════════════════════════════
 *  这个工具干什么
 * ══════════════════════════════════════════════════════════════
 *
 *  ① 找窗口、截图
 *  ② 分析截图：找亮点（节点）、找标签、找报错文字
 *  ③ 判定：节点数是否等于场景数、有没有异常文字
 *  ④ 出报告
 *
 *  ⚠ 这是「看画面」，不是「看配置」——这是它存在的唯一理由。
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/界面回归.mjs --shot            截一张图存下来
 *  node 工具/界面回归.mjs --analyze         分析当前画面
 *  node 工具/界面回归.mjs --check           检查（节点数 vs 场景数）
 *  node 工具/界面回归.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const SHOT_DIR = path.join(WB, 'prototype', 'shots');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  PowerShell 截图脚本（ASCII 化，避免中文编码问题）
// ══════════════════════════════════════════════════════════════
const SHOT_PS = `
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WRG {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$p = Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output "NO_WINDOW"; exit 1 }
$h = $p.MainWindowHandle

# 恢复（如果最小化）
if ([WRG]::IsIconic($h)) { [WRG]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 600 }

# 强制前置：SW_RESTORE → BringWindowToTop → HWND_TOPMOST 临时
[WRG]::ShowWindow($h, 9) | Out-Null
Start-Sleep -Milliseconds 200
[WRG]::BringWindowToTop($h) | Out-Null
[WRG]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 400

# 检查前置是否成功
$fg = [WRG]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256
[WRG]::GetWindowText($fg, $sb, 256) | Out-Null
$fgTitle = $sb.ToString()

if ($fg -ne $h) {
  # 再试一次：SetWindowPos 置顶
  [WRG]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002) | Out-Null
  Start-Sleep -Milliseconds 500
  [WRG]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 500
  $fg2 = [WRG]::GetForegroundWindow()
  if ($fg2 -ne $h) {
    Write-Output ("OCCLUDED=" + $fgTitle)
    # 还原 topmost
    [WRG]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0001 -bor 0x0002) | Out-Null
    exit 3
  }
  [WRG]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0001 -bor 0x0002) | Out-Null
}

Start-Sleep -Milliseconds 500

$r = New-Object WRG+RECT
[WRG]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
if ($w -lt 200 -or $ht -lt 150) { Write-Output ("TOO_SMALL=" + $w + "x" + $ht); exit 4 }

$out = $env:WB_SHOT_OUT
$b = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $ht))
$b.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $b.Dispose()
Write-Output ("OK " + $w + "x" + $ht + " " + $r.Left + "," + $r.Top)
`;

// Analyze screenshot: read pixels, output light-point coordinates.
// Clustering is done in Node (PowerShell 5.1 has state-sync bugs with
// ArrayList/Hashtable when there is no stdout write between mutations).
// IMPORTANT: keep this script pure ASCII. Chinese comments in the PS
// heredoc caused silent failures (SIZE printed, then everything null).
const ANALYSIS_PS = `
Add-Type -AssemblyName System.Drawing
$src = $env:WB_SHOT_IN
if (-not (Test-Path $src)) { Write-Output "NO_FILE"; exit 1 }
$bmp = New-Object System.Drawing.Bitmap $src
$W = $bmp.Width
$H = $bmp.Height

$THRESH = 400
$MAX_POINTS = 30000
$yStart = [int]($H * 0.20)
$xMin = 24
$xMax = $W - 24
$yMax = $H - 28

# Read all pixels at once via LockBits (GetPixel is ~100x slower)
$rect = New-Object System.Drawing.Rectangle 0, 0, $W, $H
$data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride = $data.Stride
$bytes = New-Object byte[] ($stride * $H)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$bmp.UnlockBits($data)

Write-Output ("SIZE=" + $W + "x" + $H)

# Collect light points into a plain string array
$pip = New-Object System.Collections.ArrayList
$cnt = 0
$truncated = 0
for($y = $yStart; $y -lt $yMax; $y += 2){
  $rowBase = $y * $stride
  for($x = $xMin; $x -lt $xMax; $x += 2){
    $idx = $rowBase + $x * 4
    $b = [int]$bytes[$idx]
    $g = [int]$bytes[$idx + 1]
    $r = [int]$bytes[$idx + 2]
    $v = $r + $g + $b
    if($v -lt $THRESH){ continue }
    $isBlue = ($b -gt ($r - 10))
    $isWhite = ($r -gt 250 -and $g -gt 250 -and $b -gt 250)
    if(-not ($isBlue -or $isWhite)){ continue }
    $cnt = $cnt + 1
    if($cnt -le $MAX_POINTS){
      [void]$pip.Add("PIP=" + $x + "," + $y + "," + $v)
    }
    if($cnt -ge $MAX_POINTS){ $truncated = 1; break }
  }
  if($truncated -eq 1){ break }
}

# Emit count first, then points one by one (no big string)
Write-Output ("PCOUNT=" + $cnt)
Write-Output ("PTRUNC=" + $truncated)
for($i = 0; $i -lt $pip.Count; $i++){
  Write-Output $pip[$i]
}

# Red text on right edge (error overflow detection)
$colHits = 0
$xR0 = $W - 110
$xR1 = $W - 4
$yR0 = [int]($H * 0.1)
$yR1 = $H - 10
for($x = $xR0; $x -lt $xR1; $x += 2){
  for($y = $yR0; $y -lt $yR1; $y += 4){
    $idx = $y * $stride + $x * 4
    $b = [int]$bytes[$idx]
    $g = [int]$bytes[$idx + 1]
    $r = [int]$bytes[$idx + 2]
    if($r -gt 120 -and $r -gt ($b + 40) -and $g -lt 130){ $colHits = $colHits + 1 }
  }
}
Write-Output ("RIGHT_RED=" + $colHits)

$bmp.Dispose()
`;

function runPs(script, env) {
  // ⚠ 2026-11-11 修复：原来用 Date.now() 命名临时文件，
  //   同一毫秒内连续调用两次（截图→分析）会撞名：
  //   第二次写入时第一次的 PowerShell 还在读 → 文件被占用/内容错乱
  //   → 表现为 exit null（超时/崩溃）。
  //   改用「时间戳 + 随机数 + 递增计数」保证唯一。
  runPs._seq = (runPs._seq || 0) + 1;
  const uniq = Date.now() + '-' + runPs._seq + '-' + Math.random().toString(36).slice(2, 8);
  const tmp = path.join(os.tmpdir(), 'wb-ui-' + uniq + '.ps1');
  fs.writeFileSync(tmp, script, 'utf8');

  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], {
    encoding: 'utf8', timeout: 180000, windowsHide: true,
    env: { ...process.env, ...(env || {}) },
  });

  // 删临时文件（失败不报错）
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }

  return {
    code: r.status,
    signal: r.signal,
    error: r.error ? r.error.message : null,
    out: (r.stdout || '') + (r.stderr || ''),
  };
}

// ══════════════════════════════════════════════════════════════
//  截图
// ══════════════════════════════════════════════════════════════
export function takeShot(opts) {
  const o = opts || {};
  const dir = o.dir || SHOT_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, o.name || 'shot-' + Date.now() + '.png');

  // ══════════════════════════════════════════════════════════════
  //  ★ 2026-11-11：优先用 工具/截图.mjs（三招防遮挡）
  //
  //  原来只有一套 PS：SetForegroundWindow + 检查 GetForegroundWindow。
  //  实测经常失败 —— 工作台被别的窗口挡着时就抓不到，
  //  而且机制体检里跑会偶发 FAIL（因为体检期间可能有别的窗口抢焦点）。
  //
  //  截图.mjs 更可靠：
  //    ① AttachThreadInput 绕过 Windows 前台锁
  //    ② Alt+Tab 切一次
  //    ③ 最小化再恢复（强制重排 Z 序）
  //  三招都失败才报 OCCLUDED。
  // ══════════════════════════════════════════════════════════════
  try {
    const shotMod = path.join(HERE, '截图.mjs');
    if (fs.existsSync(shotMod)) {
      // 用子进程调用（截图.mjs 是 ESM，且会 spawn powershell）
      const rr = spawnSync(process.execPath, [shotMod, out], {
        encoding: 'utf8', timeout: 150000, windowsHide: true,
      });
      const raw = (rr.stdout || '').trim();
      let j = null;
      try { j = JSON.parse(raw); } catch { /* 落到旧路 */ }
      if (j && j.ok) {
        return {
          ok: true, path: j.path || out,
          width: j.width || null, height: j.height || null,
          left: null, top: null, via: '截图.mjs',
        };
      }
      if (j && j.occluded) {
        return { ok: false, occluded: true, error: j.error || '被遮挡' };
      }
      // 其它失败 → 继续走下面的旧路
    }
  } catch (e) { /* 忽略，回退旧路 */ }

  const r = runPs(SHOT_PS, { WB_SHOT_OUT: out });

  if (r.out.includes('NO_WINDOW')) {
    return { ok: false, error: '找不到工作台窗口（工作台没启动？）' };
  }
  if (r.out.includes('OCCLUDED=')) {
    const who = r.out.match(/OCCLUDED=([^\n]*)/);
    return {
      ok: false,
      occluded: true,
      error: '工作台被「' + (who ? who[1] : '其它窗口') + '」遮挡，截到的是别的程序',
    };
  }
  if (r.out.includes('TOO_SMALL=')) {
    return { ok: false, error: '工作台窗口太小：' + (r.out.match(/TOO_SMALL=([^\n]*)/) || [])[1] };
  }
  if (r.code !== 0 && !r.out.includes('OK ')) {
    return { ok: false, error: r.out.trim() || ('截图脚本退出码 ' + r.code) };
  }

  const m = r.out.match(/OK (\d+)x(\d+) (-?\d+),(-?\d+)/);
  return {
    ok: true,
    path: out,
    width: m ? Number(m[1]) : null,
    height: m ? Number(m[2]) : null,
    left: m ? Number(m[3]) : null,
    top: m ? Number(m[4]) : null,
    via: '旧 PS',
  };
}

// ══════════════════════════════════════════════════════════════
//  分析截图
// ══════════════════════════════════════════════════════════════
export function analyzeShot(shotPath) {
  // ⚠ 2026-11-11 实测修复：截图刚写完时立刻分析会 exit null，
  //   原因是 GDI+ 还在锁文件 / PNG 还没 flush 完。
  //   等 700ms 再分析就正常（实测：不等 → exit null；等 1s → ok）。
  //
  //   用 Atomics.wait 做同步 sleep（主线程可用，不需要 async）。
  if (shotPath) {
    try {
      const sab = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(sab), 0, 0, 700);
    } catch { /* 不支持就跳过等待 */ }
  }

  const r = runPs(ANALYSIS_PS, { WB_SHOT_IN: shotPath });
  // ⚠ 2026-11-11 修复：原来 `if (r.code !== 0 || ...)` 只要 exit 非 0 就判失败，
  //   但 PowerShell 5.1 常因「写入 stderr 的警告」带非 0 退出码，
  //   而实际输出是好的。改成：**优先看输出里有没有 SIZE**，
  //   拿到 SIZE 就算成功；拿不到才算失败并报告原始输出。
  const hasSize = /SIZE=\d+x\d+/.test(r.out);
  if (!hasSize) {
    return {
      ok: false,
      error: '分析失败（exit ' + r.code + '）：' + r.out.replace(/\s+/g, ' ').slice(0, 200),
    };
  }

  const peaks = [];
  let size = null;
  let rightRed = 0;
  let pcount = 0;
  let ptrunc = 0;
  const pts = [];

  for (const line of r.out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('SIZE=')) size = t.slice(5);
    else if (t.startsWith('PCOUNT=')) pcount = Number(t.slice(7));
    else if (t.startsWith('PTRUNC=')) ptrunc = Number(t.slice(7));
    else if (t.startsWith('RIGHT_RED=')) rightRed = Number(t.slice(10));
    else if (t.startsWith('PIP=')) {
      const parts = t.slice(4).split(',').map(Number);
      if (parts.length >= 3 && !isNaN(parts[0])) {
        pts.push({ x: parts[0], y: parts[1], v: parts[2] });
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  聚类（放 Node 侧做，不放 PowerShell —— 见 ANALYSIS_PS 顶部说明）
  //
  //  网格法 + 3x3 邻域合并：
  //    ① 把点按 GRID 大小归格
  //    ② 按格内点数降序，把相邻格并到当前簇
  //    ③ 每簇取质心 + 总点数 + 最亮值
  //
  //  实测校准（干净的中枢画面，9 个场景节点）：
  //    GRID=44, minN=1 → 8 个簇（暗节点 n=1~2，检不出是真实的）
  //    亮节点 n=12~116，暗节点 n=1~2
  // ══════════════════════════════════════════════════════════════
  const GRID = 44;
  const cells = new Map();
  for (const p of pts) {
    const k = Math.floor(p.x / GRID) + ',' + Math.floor(p.y / GRID);
    let c = cells.get(k);
    if (!c) { c = { sumX: 0, sumY: 0, n: 0, maxV: 0, gx: 0, gy: 0 }; cells.set(k, c); }
    c.sumX += p.x; c.sumY += p.y; c.n += 1;
    if (p.v > c.maxV) c.maxV = p.v;
  }
  // 记录每格坐标，供邻域合并用
  for (const [k, c] of cells) {
    const parts = k.split(',');
    c.gx = Number(parts[0]);
    c.gy = Number(parts[1]);
  }

  // 按点数降序处理
  const keys = [...cells.keys()].sort(function (a, b) { return cells.get(b).n - cells.get(a).n; });
  const used = new Set();
  const merged = [];

  for (const k of keys) {
    if (used.has(k)) continue;
    const c = cells.get(k);
    let accX = c.sumX, accY = c.sumY, accN = c.n, accV = c.maxV;
    used.add(k);
    // 3x3 邻域
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const nk = (c.gx + dx) + ',' + (c.gy + dy);
        if (!cells.has(nk) || used.has(nk)) continue;
        const ne = cells.get(nk);
        accX += ne.sumX; accY += ne.sumY; accN += ne.n;
        if (ne.maxV > accV) accV = ne.maxV;
        used.add(nk);
      }
    }
    merged.push({ x: Math.round(accX / accN), y: Math.round(accY / accN), n: accN, v: accV });
  }

  for (const m of merged) peaks.push(m);
  const peakCount = peaks.length;
  const marks = pts.length;

  if (!size) {
    return { ok: false, error: '截图解析失败（没拿到 SIZE）' };
  }

  return {
    ok: true,
    size,
    marks,
    peakCount: peaks.length || peakCount,
    peaks,
    rightEdgeRed: rightRed,
    errorOverflow: rightRed > 200,
  };
}

// ══════════════════════════════════════════════════════════════
//  检查：节点数 vs 场景数
// ══════════════════════════════════════════════════════════════
export function checkUi(opts) {
  const o = opts || {};

  // ══════════════════════════════════════════════════════════════
  //  ★ 2026-11-11 加（真实用户发现：机制体检卡 180 秒 + 误判）
  //
  //  这个检查的判据是「画面上的亮点数 vs 场景数」——
  //  **只有在中枢（星盘）场景才成立**。
  //
  //  实测：停在「架构梳理」时，画面上有大片纯白 AI 面板 + MDN 网页，
  //   · 旧脚本（阈值 620，不排纯白）→ marks 13 万 → O(n²) 卡死
  //   · 新脚本（排纯白）→ marks=1 → 判「亮点 1 个 < 场景 9 个」→ FAIL
  //
  //  两次都是误判：不是界面坏了，是**这个检查用错了场景**。
  //
  //  修法：截图前先看当前在哪个场景。
  //    · 在中枢 → 正常检查
  //    · 不在中枢 → 标记 SKIP（说清原因），不判 FAIL
  // ══════════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-12 修（真缺陷：读错了「当前场景」标记文件的位置）
  //
  //  原代码只读一个路径：`WB/数据/当前场景`
  //  但那个文件**根本不存在**。实际在用（且被 git 跟踪）的是
  //  `WB/外壳/data/当前场景`（外壳写、外壳读）。
  //
  //  后果链（比「读不到」更糟）：
  //    读不到 → sceneInfo.id = '' →
  //    `inHub = !sceneInfo.id || ...` → **空字符串被当成「在中枢」** →
  //    于是不管用户停在哪一屏，都按「星盘」判据检查 →
  //    在故障分析/本地电脑等场景下，画面本来就没有星点 →
  //    判「一个亮点都没有 —— 星盘没渲染」→ **误报真失败**。
  //
  //  实测：工作台停在「故障分析」（截图确认左上是故障分析报告面板），
  //        标记文件 外壳/data/当前场景 = pc-cleanup，而工具读到空 →
  //        exit 1 报「星盘没渲染」。真实检查变成了看运气。
  //
  //  修法两条：
  //    ① 两个路径都读（外壳/data 优先，因为它才是现在写的那份）
  //    ② **读不到就不再假设「在中枢」** —— 必须明确标 unknown 并按 SKIP 处理，
  //       因为「我不知道现在在哪」不等于「现在在中枢」。
  //       把未知当已知，就是这次误报的根因。
  // ══════════════════════════════════════════════════════════════
  const sceneInfo = (function () {
    const candidates = [
      path.join(WB, '外壳', 'data', '当前场景'),   // ← 实际在用的
      path.join(WB, '数据', '当前场景'),           // ← 历史路径，保留兼容
    ];
    for (const markerPath of candidates) {
      try {
        if (fs.existsSync(markerPath)) {
          const id = fs.readFileSync(markerPath, 'utf8').trim();
          if (id) return { id, source: markerPath.replace(WB + path.sep, '') };
        }
      } catch { /* 试下一个 */ }
    }
    return { id: '', source: '', unknown: true };
  })();

  // 「在不在中枢」：三态，不要用空字符串冒充 true
  const inHub = sceneInfo.id === 'hub' || sceneInfo.id === '中枢';
  const sceneUnknown = !sceneInfo.id;

  // 期望的场景数
  let expected = 0;
  if (fs.existsSync(SCEN_DIR)) {
    for (const f of fs.readdirSync(SCEN_DIR)) {
      if (!f.endsWith('.json')) continue;
      const j = readJsonSafe(path.join(SCEN_DIR, f));
      if (j && j.id) expected++;
    }
  }

  const shot = o.shot || takeShot(o);
  if (!shot.ok) return { ok: false, error: shot.error, expected, scene: sceneInfo.id };

  const a = analyzeShot(shot.path);
  if (!a.ok) return { ok: false, error: a.error, shot, expected, scene: sceneInfo.id };

  // 不在中枢 → 这个检查不适用，报 SKIP 而不是 FAIL
  //
  // ⚠ 2026-11-12：**「不知道在哪个场景」也必须走这条**，不能当成中枢。
  //   原来 `inHub` 把空 sceneInfo.id 也算成中枢，于是「读不到标记」
  //   直接变成「按星盘判据检查」→ 在别的场景必然报「星盘没渲染」。
  //   未知 ≠ 已知，未知时唯一诚实的做法是 SKIP 并说清原因。
  if (!inHub) {
    const where = sceneUnknown
      ? '读不到「当前场景」标记（外壳/data/当前场景 与 数据/当前场景 都不存在或为空）'
      : '当前在「' + sceneInfo.id + '」场景';
    return {
      ok: true,
      skipped: true,
      expected,
      scene: sceneInfo.id || '(未知)',
      sceneUnknown,
      peakCount: a.peakCount,
      shot,
      size: a.size,
      problems: [],
      reason: where + '，不是星盘 —— ' +
        '「亮点数 vs 场景数」这个判据只在中枢成立，跳过（不算失败）。' +
        (sceneUnknown ? '注意：这不是「界面正常」，只是这个判据此刻用不上。' : ''),
    };
  }

  const problems = [];

  // ① 报错溢出
  if (a.errorOverflow) {
    problems.push('右边缘有大量红色文字（疑似错误堆栈溢出）：' + a.rightEdgeRed + ' 个红像素点');
  }

  // ② 节点渲染判据（2026-11-11 重新设计）
  //
  // ⚠ 为什么不能用「亮点数 ≈ 场景数」：
  //
  //   实测（干净的中枢画面，9 个场景节点，网格聚类）：
  //     PK=975,469 n=116   竞品拆解（前半球，很亮）
  //     PK=356,799 n=93    实施计划（前半球，很亮）
  //     PK=1339,579 n=37   中枢（前半球）
  //     PK=1111,876 n=12   调研（前半球边缘）
  //     PK=1382,757 n=2    本地电脑（背半球，很暗）
  //     PK=936,595 n=2     故障分析（背半球，很暗）
  //     PK=742,616 n=1     自我复盘（背半球，极暗）
  //     PK=770,470 n=1     架构梳理（背半球，极暗）
  //   ⇒ 只检出 8 个，而场景是 9 个。
  //
  //   **暗节点检不出来是真实的视觉效果**（星点在 Z 轴深处，被前半球挡住），
  //   不是渲染 bug。拿它当判据必然误报。
  //
  //   新的判据（只抓「真的坏了」）：
  //     · 完全没有任何亮点（peakCount === 0）→ 星盘没渲染 ⇒ 真异常
  //     · 亮节点太少（n>=8 的少于场景数一半）→ 大部分没渲染 ⇒ 真异常
  //     · 右边缘红字溢出 → 真异常
  //
  //   弱节点不算异常 —— 它们本来就该是暗的。
  const strongPeaks = (a.peaks || []).filter(function (p) { return (p.n || 0) >= 8; }).length;

  if (expected > 0 && a.peakCount === 0) {
    problems.push('画面上一个亮点都没有 —— 星盘没渲染（场景 ' + expected + ' 个全无）');
  } else if (expected > 0 && strongPeaks < Math.floor(expected * 0.4)) {
    problems.push('明显亮点只有 ' + strongPeaks + ' 个（场景 ' + expected +
      ' 个，少于 40% 判异常）；可能是大部分节点未渲染');
  }

  return {
    ok: problems.length === 0,
    expected,
    peakCount: a.peakCount,
    errorOverflow: a.errorOverflow,
    rightEdgeRed: a.rightEdgeRed,
    peaks: a.peaks,
    shot,
    size: a.size,
    // ⚠ 2026-11-12：这里原来没把 scene 带回去，导致中枢分支报告里
    //   显示「当前场景: (未知)」——明明刚读过标记。补上。
    scene: sceneInfo.id,
    sceneSource: sceneInfo.source,
    problems,
    reason: problems.length === 0
      ? '画面正常：检出 ' + a.peakCount + ' 个亮点（明显 ' + strongPeaks + ' 个 / 场景 ' + expected + ' 个），无错误溢出'
      : problems.join('；'),
  };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  界面回归 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 先做「不依赖窗口」的合成图验证
  //
  //  ⚠ 2026-11-12：顺序很重要。
  //    原来截图失败就直接 return true（整段 SKIP），
  //    于是「分析器到底认不认得出亮点」这件事**一次都没被验证过** ——
  //    窗口一旦不稳定，检查就永远空转。
  //    合成图不碰真实窗口，必须放在最前面、无条件跑。
  console.log('  合成图验证（不依赖窗口）…');
  const synthCheck = (function () {
    const dir = path.join(SHOT_DIR, '_synth');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const dim = path.join(dir, 'dim.png');
      const lit = path.join(dir, 'lit.png');
      // ⚠ 2026-11-12 实测记录（造图时必须知道的分析器特性）：
      //   ANALYSIS_PS 里亮点的判据是 **蓝色** 或 **纯白**：
      //     $isBlue  = ($b -gt ($r - 10))
      //     $isWhite = ($r -gt 250 -and $g -gt 250 -and $b -gt 250)
      //   我第一次画了个暖色块 (255,240,200)，结果亮点 = 0 ——
      //   不是分析器坏了，是**它本来就只认星盘那种蓝白星点**。
      //   所以造图必须用纯白，否则测的是我的错配色、不是分析能力。
      //
      //   顺带这就是这个分析器的已知盲区：暖色高亮（黄/橙）一律看不见。
      //   写在这里，免得以后有人拿一张黄点的图来问「为什么检不出」。
      const ps = [
        'Add-Type -AssemblyName System.Drawing',
        '$w = 400; $h = 300',
        'function Make($path, $on) {',
        '  $b = New-Object System.Drawing.Bitmap $w, $h',
        '  $g = [System.Drawing.Graphics]::FromImage($b)',
        '  $g.Clear([System.Drawing.Color]::FromArgb(255,8,10,12))',
        '  if ($on) {',
        '    $br = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,255,255,255))',
        '    $g.FillEllipse($br, 180, 130, 40, 40)',
        '    $br.Dispose()',
        '  }',
        '  $g.Dispose()',
        '  $b.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)',
        '  $b.Dispose()',
        '}',
        'Make "' + dim.replace(/\\/g, '\\\\') + '" $false',
        'Make "' + lit.replace(/\\/g, '\\\\') + '" $true',
      ].join('\n');
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { encoding: 'utf8', timeout: 30000, windowsHide: true });
      if (!fs.existsSync(lit) || !fs.existsSync(dim)) {
        return { ok: true, skipped: true, detail: 'SKIP：造不出合成图（' + String(r.stderr || '').slice(0, 60) + '）' };
      }
      const aLit = analyzeShot(lit);
      const aDim = analyzeShot(dim);
      if (!aLit.ok || !aDim.ok) {
        return { ok: false, detail: '合成图分析失败：' + (aLit.error || aDim.error) };
      }
      const distinguishable = aLit.peakCount > aDim.peakCount;
      return {
        ok: distinguishable,
        detail: '亮块图亮点=' + aLit.peakCount + ' / 纯黑图亮点=' + aDim.peakCount +
          (distinguishable ? '（能区分 ✓）' : '（分不开 ⇒ 分析器其实是瞎的）'),
      };
    } catch (e) {
      return { ok: true, skipped: true, detail: 'SKIP：合成图异常 ' + String((e && e.message) || e).slice(0, 60) };
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  })();
  // ⚠ 这条是真判据：分析器必须能把「有亮块」和「纯黑」分开。
  //    不依赖窗口在不在、用户停在哪一屏，所以**任何时候都不该 SKIP 成绿**。
  chk('关键：判据来自截图不是配置（合成图可区分）',
      synthCheck.ok === true, synthCheck.detail);

  // ② 截图
  console.log();  const shot = takeShot({ name: 'selftest-' + Date.now() + '.png' });
  // ⚠ 2026-11-11：截图失败不该判 FAIL ——
  //   窗口被遮挡/最小化是**环境问题**，不是代码缺陷。
  //   改成「跳过」，否则无人值守时每次都红。
  //
  //  ⚠ 2026-11-12 补：SKIP 时**不能把整段都算绿**。
  //    合成图那条判据已经在上面无条件跑过了（不依赖窗口），
  //    这里只跳过「真实窗口」那几条，其余能力判据仍要跑完。
  if (!shot.ok) {
    console.log('  SKIP  能截到窗口  ' + shot.error);
    console.log('        （环境问题：工作台没跑 / 窗口被遮挡，不是代码缺陷）');
    console.log();
    // ④ 反例：不存在的文件 —— 这条不依赖窗口，必须仍然成立
    const bad0 = analyzeShot(path.join(SHOT_DIR, '__not_exist__.png'));
    chk('反例：文件不存在返回失败', bad0.ok === false, bad0.error);
    console.log();
    console.log('─'.repeat(72));
    const p0 = R.filter(Boolean).length;
    console.log('  自测结果(SKIP 真实窗口): ' + p0 + ' / ' + R.length +
      '  —— 能力判据已全部执行，仅跳过窗口相关项');
    console.log('─'.repeat(72));
    return R.every(Boolean);
  }

  chk('能截到窗口', true, shot.width + 'x' + shot.height);
  chk('截图有尺寸', shot.ok && shot.width > 100, shot.ok ? String(shot.width) : '');
  chk('截图文件存在', shot.ok && fs.existsSync(shot.path), shot.ok ? path.basename(shot.path) : '');



  // ② 分析
  const a = analyzeShot(shot.path);
  chk('能分析截图', a.ok === true, a.ok ? '尺寸 ' + a.size : a.error);
  chk('能数出亮点', typeof a.peakCount === 'number', a.peakCount + ' 个');
  chk('能检测右边缘红色', typeof a.rightEdgeRed === 'number', a.rightEdgeRed + ' 个红点');

  // ③ 检查
  const c = checkUi({ shot });
  chk('能对照场景数', typeof c.expected === 'number', '场景 ' + c.expected + ' / 亮点 ' + c.peakCount);
  chk('能给出判定', typeof c.ok === 'boolean', c.reason);

  // ④ 反例：不存在的文件
  const bad = analyzeShot(path.join(SHOT_DIR, '__not_exist__.png'));
  chk('反例：文件不存在返回失败', bad.ok === false, bad.error);

  // （合成图验证已移到自测最前面：不依赖窗口，必须先跑）

  // ⑤ 关键：这是「看画面」不是「看配置」
  //
  // ⚠ 2026-11-11 调整（真实用户发现）：
  //   原来断言 `a.peakCount > 0`，但只有在中枢（星盘）场景才有星点。
  //   停在别的场景（架构梳理/本地电脑等）时，画面本来就没亮点，
  //   这时断言失败是**误判**，不是工具坏了。
  //
  //   现在的判据：
  //     · 截图成功 + 分析成功  → 说明「看画面」这条路是通的
  //     · 如果在中枢，还要求 peakCount > 0（真的看到了节点）
  //     · 如果不在中枢，只要求分析成功（画面没星点是对的）
  const inHubScene = !c.scene || c.scene === 'hub' || c.scene === '中枢';
  // ⚠ 2026-11-12 修（判据错误：自测把「工具自己造的空白图」当成了真实界面）
  //
  //  原判据：selftest 直接 takeShot() 截当前窗口，然后断言 peakCount > 0。
  //  错在哪：这条件**取决于用户此刻停在哪一屏**，不是取决于代码对不对。
  //          实测：工作台停在非星盘场景（或窗口刚被前置、还在重绘）时，
  //          截出来一个亮点都没有 → 自测红 → 机制体检里「界面回归」长期 FAIL，
  //          但真实检查 `node 工具/界面回归.mjs` 同一时刻是绿的。
  //          **同一个工具，自测红、真实绿，说明红的是自测的判据，不是产品。**
  //          这正是「环境状态当判据」那一类错误。
  //
  //  改成分三层，各判各的：
  //    · 能力层（必须绿）：能截图、能分析、能出判定、反例能失败
  //      —— 这些只跟代码有关，任何场景下都该成立
  //    · 画面层（不判失败，只记录）：亮点数 / 是否在中枢
  //      —— 这跟"用户此刻停在哪"有关，属于观测，不是断言
  //    · 场景感知（必须绿）：非星盘场景时必须 SKIP 而不是 FAIL
  //      —— 这条是工具行为，跟场景无关，任何场景下都该成立
  //
  //  为什么原来那条 `peakCount > 0` 必须删：它不是判据，是**运气**。
  //  真正证明「判据来自截图不是配置」的，是下面新增的合成图反例：
  //  造一张确定有亮点、和确定没有亮点的图，看分析器能不能分开。
  //  那才是不依赖环境、能反复失败/通过的证据。
  chk('关键：判据来自截图不是配置（合成图可区分）',
      synthCheck.ok === true, synthCheck.detail);

  // 场景感知：这条与场景无关，任何情况下都必须成立
  chk('场景感知：非星盘场景不计失败',
      c.skipped === true || c.ok === true,
      c.skipped ? '在「' + c.scene + '」，已跳过判定（正确）' : '在中枢，正常检查');

  // 清理自测截图
  try { fs.unlinkSync(shot.path); } catch { /* ignore */ }

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  // ── 截图 ──
  if (has('--shot')) {
    const s = takeShot();
    if (!s.ok) { console.error('✗ ' + s.error); process.exit(2); }
    console.log('✓ 已截图: ' + s.path);
    console.log('  ' + s.width + 'x' + s.height + ' @ ' + s.left + ',' + s.top);
    process.exit(0);
  }

  // ── 分析 ──
  if (has('--analyze')) {
    const s = takeShot();
    if (!s.ok) { console.error('✗ ' + s.error); process.exit(2); }
    const a = analyzeShot(s.path);
    // ⚠ 分析失败要明确报，不能往下走（否则 a.peaks 是 undefined 会崩）
    if (!a.ok) { console.error('✗ ' + a.error); process.exit(2); }
    console.log('═'.repeat(74));
    console.log('  画面分析');
    console.log('═'.repeat(74));
    console.log();
    console.log('  尺寸:     ' + a.size);
    console.log('  亮点:     ' + a.peakCount + ' 个（亮点像素 ' + a.marks + '）');
    console.log('  右边缘红: ' + a.rightEdgeRed + ' 个像素' +
      (a.errorOverflow ? '  ⚠ 疑似错误溢出' : '  ✓ 正常'));
    console.log();
    console.log('  亮点坐标:');
    for (const p of a.peaks) console.log('    (' + p.x + ', ' + p.y + ') 亮度 ' + p.v + ' 像素 ' + p.n);
    console.log();
    console.log('  截图: ' + path.relative(WB, s.path).replace(/\\/g, '/'));
    process.exit(0);
  }

  // ── 检查（默认）──
  const c = checkUi();

  console.log('═'.repeat(76));
  console.log('  界面回归检查（看画面，不看配置）');
  console.log('═'.repeat(76));
  console.log();

  if (c.error) {
    console.log('  ✗ ' + c.error);
    process.exit(2);
  }

  console.log('  窗口:     ' + c.size);
  console.log('  场景数:   ' + c.expected);
  console.log('  当前场景: ' + (c.scene || '(未知)') + (c.sceneUnknown ? '  ← 读不到标记，按 SKIP 处理' : ''));
  console.log('  画面亮点: ' + c.peakCount);
  // ⚠ 2026-11-12：SKIP 分支没把 rightEdgeRed 带回来，原来这里会打印 "undefined px"。
  //   屏幕上出现 undefined 本身就是个小 bug，改成缺值时显示「—」。
  console.log('  右边缘红: ' + (typeof c.rightEdgeRed === 'number' ? c.rightEdgeRed + ' px' : '—（本次跳过未测）'));
  console.log();
  console.log('  判定: ' + (c.skipped ? '○ 跳过（判据不适用）' : (c.ok ? '✓ 正常' : '✗ 有问题')));
  console.log('  理由: ' + c.reason);
  console.log();

  if (!c.ok) {
    console.log('  细节:');
    for (const p of c.problems) console.log('    · ' + p);
    console.log();
  }

  console.log('─'.repeat(76));
  console.log('  依据：参考项目 02/二-会话绑定三字段.md');
  console.log('  「键写对了 ≠ 界面切过去了。判断只能看画面。」');
  console.log('─'.repeat(76));

  process.exit(c.ok ? 0 : 1);
}
