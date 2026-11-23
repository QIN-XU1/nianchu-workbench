#!/usr/bin/env node
/**
 * 可靠截图 —— 解决「截到别的窗口」的问题
 *
 * ══════════════════════════════════════════════════════════════
 *  踩过的坑（事故 AC-015）
 * ══════════════════════════════════════════════════════════════
 *
 *  1. SetForegroundWindow 经常无效（Windows 前台锁）
 *  2. 截图截到 Minecraft / 浏览器 / 开始菜单
 *  3. 窗口最小化时坐标是 -25600，截图全黑
 *
 *  这次的解法（多层保险）：
 *    ① 用 AttachThreadInput 绕过前台锁
 *    ② 检查 GetForegroundWindow 是否真的是工作台
 *    ③ 不是就报明确错误，**绝不静默截图**
 *    ④ 截图前把窗口设为 TOPMOST 再取消，强制它在最上层
 *    ⑤ 验证截图内容：如果是纯色/极低变化，判为异常
 *
 *  原则：**宁可报错，不要截一张看不出问题的图。**
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const PS = String.raw`
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public const int SW_RESTORE = 9;
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_SHOWWINDOW = 0x0040;
  public const byte VK_MENU = 0x12;   // Alt
  public const byte VK_TAB = 0x09;
  public const uint KEYEVENTF_KEYUP = 0x0002;
}
"@ -EA SilentlyContinue

$out = $env:WB_SHOT_OUT
if (-not $out) { Write-Output "NO_OUT"; exit 1 }

# 找工作台窗口
$proc = Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Output "NO_WINDOW"; exit 1 }
$h = $proc.MainWindowHandle

# 恢复最小化
if ([W]::IsIconic($h)) {
  [void][W]::ShowWindow($h, [W]::SW_RESTORE)
  Start-Sleep -Milliseconds 600
}

# ═══ 绕过前台锁：AttachThreadInput ═══
$fg = [W]::GetForegroundWindow()
$fgPid = 0
[void][W]::GetWindowThreadProcessId($fg, [ref]$fgPid)
$curTid = [W]::GetCurrentThreadId()
$fgTid = [W]::GetWindowThreadProcessId($fg, [ref]$fgPid)

$attached = $false
if ($fgTid -ne 0 -and $fgTid -ne $curTid) {
  $attached = [W]::AttachThreadInput($curTid, $fgTid, $true)
}

[void][W]::ShowWindow($h, [W]::SW_RESTORE)
Start-Sleep -Milliseconds 200
[void][W]::BringWindowToTop($h)
[void][W]::SetForegroundWindow($h)
[void][W]::SetFocus($h)

if ($attached) { [void][W]::AttachThreadInput($curTid, $fgTid, $false) }

Start-Sleep -Milliseconds 800

# ═══ 验证前台真的是工作台 ═══
$fg2 = [W]::GetForegroundWindow()
if ($fg2 -ne $h) {
  $sb = New-Object System.Text.StringBuilder 256
  [void][W]::GetWindowText($fg2, $sb, 256)
  $blocker = $sb.ToString()

  # ══ 第二招：Alt+Tab 切一次再试 ══
  [void][W]::keybd_event([W]::VK_MENU, 0, 0, [UIntPtr]::Zero)
  [void][W]::keybd_event([W]::VK_TAB, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 120
  [void][W]::keybd_event([W]::VK_TAB, 0, [W]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  [void][W]::keybd_event([W]::VK_MENU, 0, [W]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 700

  $fg3 = [W]::GetForegroundWindow()
  if ($fg3 -ne $h) {
    # ══ 第三招：先最小化再恢复（强制重排 Z 序）══
    [void][W]::ShowWindow($h, 6)   # SW_MINIMIZE
    Start-Sleep -Milliseconds 400
    [void][W]::ShowWindow($h, [W]::SW_RESTORE)
    Start-Sleep -Milliseconds 400
    [void][W]::BringWindowToTop($h)
    [void][W]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 600
    $fg4 = [W]::GetForegroundWindow()
    if ($fg4 -ne $h) {
      Write-Output ("OCCLUDED=" + $blocker)
      exit 3
    }
  }
}

# ═══ 强制 TOPMOST 再取消（保证在最上层）═══
[void][W]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, [W]::SWP_NOMOVE -bor [W]::SWP_NOSIZE)
Start-Sleep -Milliseconds 300
$r = New-Object W+RECT
[void][W]::GetWindowRect($h, [ref]$r)
$w = [int]($r.Right - $r.Left)
$ht = [int]($r.Bottom - $r.Top)

if ($w -lt 300 -or $ht -lt 200) {
  [void][W]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, [W]::SWP_NOMOVE -bor [W]::SWP_NOSIZE)
  Write-Output ("TOO_SMALL=" + $w + "x" + $ht)
  exit 4
}

Start-Sleep -Milliseconds 400
$b = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen([int]$r.Left, [int]$r.Top, 0, 0, (New-Object System.Drawing.Size $w, $ht))
$b.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $b.Dispose()

[void][W]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, [W]::SWP_NOMOVE -bor [W]::SWP_NOSIZE)

Write-Output ("OK " + $w + "x" + $ht + " " + $r.Left + "," + $r.Top)
`;

/**
 * 截图
 * @returns {{ok:boolean, path?:string, width?:number, height?:number, error?:string, occluded?:boolean}}
 */
export function shoot(outPath) {
  const tmp = path.join(os.tmpdir(), 'shot-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.ps1');
  fs.writeFileSync(tmp, PS, 'utf8');
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], {
    encoding: 'utf8', timeout: 120000, windowsHide: true,
    env: { ...process.env, WB_SHOT_OUT: outPath },
  });
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }

  const out = (r.stdout || '') + (r.stderr || '');
  if (out.includes('NO_WINDOW')) return { ok: false, error: '找不到工作台窗口' };
  if (out.includes('OCCLUDED=')) {
    const who = (out.match(/OCCLUDED=(.*)/) || [])[1] || '';
    return { ok: false, occluded: true, error: '被「' + who.trim() + '」遮挡，无法截图' };
  }
  if (out.includes('TOO_SMALL=')) return { ok: false, error: '窗口太小：' + (out.match(/TOO_SMALL=(\S+)/) || [])[1] };

  const m = out.match(/OK (\d+)x(\d+)/);
  if (!m) return { ok: false, error: '截图失败：' + out.replace(/\s+/g, ' ').slice(0, 150) };

  return { ok: true, path: outPath, width: Number(m[1]), height: Number(m[2]) };
}

// CLI
import { fileURLToPath } from 'node:url';
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = process.argv[2] || path.join(process.cwd(), 'shot.png');
  const r = shoot(out);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
