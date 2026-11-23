#!/usr/bin/env node
/**
 * 点击面板里的元素并截图
 *
 * 用途：验证「点击文件 → 右侧显示 Markdown」这类交互。
 * 屏幕截图看不出交互，必须真的点。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { shoot } from './截图.mjs';

const CLICK_PS = String.raw`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class C {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
}
"@ -EA SilentlyContinue

$proc = Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Output "NO_WINDOW"; exit 1 }
$h = $proc.MainWindowHandle

[void][C]::ShowWindow($h, 9)
Start-Sleep -Milliseconds 300
[void][C]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 500

$r = New-Object C+RECT
[void][C]::GetWindowRect($h, [ref]$r)

# 相对窗口的百分比坐标
$px = [int]$env:CLICK_PCT_X
$py = [int]$env:CLICK_PCT_Y
$w = [int]($r.Right - $r.Left)
$ht = [int]($r.Bottom - $r.Top)
$x = [int]$r.Left + [int]($w * $px / 100)
$y = [int]$r.Top + [int]($ht * $py / 100)

[void][C]::SetCursorPos($x, $y)
Start-Sleep -Milliseconds 200
[void][C]::mouse_event([C]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 60
[void][C]::mouse_event([C]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 300

Write-Output ("CLICKED " + $x + "," + $y + " (" + $px + "%," + $py + "%)")
`;

function clickPct(pctX, pctY) {
  const tmp = path.join(os.tmpdir(), 'click-' + Date.now() + '.ps1');
  fs.writeFileSync(tmp, CLICK_PS, 'utf8');
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, CLICK_PCT_X: String(pctX), CLICK_PCT_Y: String(pctY) },
  });
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  return { ok: (r.stdout || '').includes('CLICKED'), out: (r.stdout || '') + (r.stderr || '') };
}

// ── CLI ──
const argv = process.argv.slice(2);
if (argv[0] === '--click') {
  const x = Number(argv[1]);
  const y = Number(argv[2]);
  const outPng = argv[3];
  console.log('点击 ' + x + '%, ' + y + '%');
  const c = clickPct(x, y);
  console.log(c.out.trim());
  if (outPng) {
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1200)'], { timeout: 5000 });
    const s = shoot(outPng);
    console.log(JSON.stringify(s));
    process.exit(s.ok ? 0 : 1);
  }
  process.exit(c.ok ? 0 : 1);
}

// 导出给别的脚本用
export { clickPct };
