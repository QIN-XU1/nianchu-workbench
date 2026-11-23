#!/usr/bin/env node
/**
 * 全场景验证 —— 用 DSH_BOOT_SCENE 逐个启动并截图
 *
 * ══════════════════════════════════════════════════════════════
 *  原理
 * ══════════════════════════════════════════════════════════════
 *
 *  我加了 DSH_BOOT_SCENE 环境变量（main.js）：
 *    启动时带上它 → 主窗口直接进指定场景
 *
 *  所以流程是：
 *    杀 electron → 设环境变量 → 启动 → 等渲染 → 截图 → 关
 *
 *  ⚠ 每个场景约 60 秒（启动 + 引擎就绪 + 渲染）
 *    9 个场景约 9 分钟。
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/全场景验证.mjs --all              验证全部
 *  node 工具/全场景验证.mjs --scene <id>       验证一个
 *  node 工具/全场景验证.mjs --report           看报告
 *  node 工具/全场景验证.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const OUT_DIR = path.join(WB, 'prototype', '场景验证');
const STATE_FILE = path.join(OUT_DIR, '_状态.json');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');
const VBS = path.join(WB, '启动.vbs');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export function listScenes() {
  const out = [];
  if (!fs.existsSync(SCEN_DIR)) return out;
  for (const f of fs.readdirSync(SCEN_DIR)) {
    if (!f.endsWith('.json')) continue;
    const j = readJsonSafe(path.join(SCEN_DIR, f));
    if (j && j.id) out.push({ id: j.id, name: j.name || j.id, panels: (j.panels || []).length });
  }
  return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function loadState() {
  return readJsonSafe(STATE_FILE) || { verified: {} };
}
function saveState(s) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

// ══════════════════════════════════════════════════════════════
//  杀 electron
// ══════════════════════════════════════════════════════════════
function killElectron() {
  return spawnSync('powershell', ['-NoProfile', '-Command',
    'Get-Process -Name electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue'],
  { encoding: 'utf8', timeout: 30000, windowsHide: true });
}

// ══════════════════════════════════════════════════════════════
//  启动（带 DSH_BOOT_SCENE）
// ══════════════════════════════════════════════════════════════
function launchWithScene(sceneId) {
  const r = spawnSync('cscript', ['//nologo', VBS], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, DSH_BOOT_SCENE: sceneId },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// ══════════════════════════════════════════════════════════════
//  等引擎就绪
// ══════════════════════════════════════════════════════════════
function waitEngineReady(maxMs) {
  const deadline = Date.now() + (maxMs || 60000);
  while (Date.now() < deadline) {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      '$c = Get-NetTCPConnection -LocalPort 3083 -State Listen -ErrorAction SilentlyContinue; if($c){"OK"}else{"NO"}'],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if ((r.stdout || '').includes('OK')) return true;
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},500)'], { timeout: 5000, windowsHide: true });
  }
  return false;
}

// ══════════════════════════════════════════════════════════════
//  截图
// ══════════════════════════════════════════════════════════════
const SHOT_PS = [
  'Add-Type -AssemblyName System.Drawing',
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class SG {',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
  '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);',
  '  public struct RECT { public int Left, Top, Right, Bottom; }',
  '}',
  '"@',
  '$p = Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
  'if (-not $p) { Write-Output "NO_WINDOW"; exit 1 }',
  '$h = $p.MainWindowHandle',
  '[SG]::ShowWindow($h, 9) | Out-Null',
  'Start-Sleep -Milliseconds 400',
  '[SG]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002) | Out-Null',
  '[SG]::BringWindowToTop($h) | Out-Null',
  '[SG]::SetForegroundWindow($h) | Out-Null',
  'Start-Sleep -Seconds 3',
  '[SG]::SetForegroundWindow($h) | Out-Null',
  'Start-Sleep -Seconds 2',
  '$r = New-Object SG+RECT',
  '[SG]::GetWindowRect($h, [ref]$r) | Out-Null',
  '$w = [int]($r.Right - $r.Left)',
  '$ht = [int]($r.Bottom - $r.Top)',
  'if ($w -lt 200 -or $ht -lt 150) { Write-Output ("TOO_SMALL=" + $w + "x" + $ht); exit 4 }',
  '$out = $env:WB_SHOT_OUT',
  '$b = New-Object System.Drawing.Bitmap $w, $ht',
  '$g = [System.Drawing.Graphics]::FromImage($b)',
  '$g.CopyFromScreen([int]$r.Left, [int]$r.Top, 0, 0, (New-Object System.Drawing.Size $w, $ht))',
  '$b.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)',
  '$g.Dispose(); $b.Dispose()',
  '[SG]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0001 -bor 0x0002) | Out-Null',
  'Write-Output ("OK " + $w + "x" + $ht)',
].join('\n');

function takeShot(outPath) {
  const tmp = path.join(os.tmpdir(), 'wb-all-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.ps1');
  fs.writeFileSync(tmp, SHOT_PS, 'utf8');
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], {
    encoding: 'utf8', timeout: 90000, windowsHide: true,
    env: { ...process.env, WB_SHOT_OUT: outPath },
  });
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  const out = (r.stdout || '') + (r.stderr || '');
  if (out.includes('NO_WINDOW')) return { ok: false, error: '找不到窗口' };
  if (out.includes('TOO_SMALL')) return { ok: false, error: '窗口太小' };
  const m = out.match(/OK (\d+)x(\d+)/);
  if (!m) return { ok: false, error: out.slice(0, 100) };
  return { ok: true, path: outPath, width: Number(m[1]), height: Number(m[2]) };
}

// ══════════════════════════════════════════════════════════════
//  验证一个场景
// ══════════════════════════════════════════════════════════════
export function verifyScene(scene, opts) {
  const o = opts || {};
  const log = o.log || function () {};
  const outPath = path.join(OUT_DIR, scene.id + '.png');

  log('  杀旧进程…');
  killElectron();
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},2000)'], { timeout: 5000, windowsHide: true });

  log('  启动（DSH_BOOT_SCENE=' + scene.id + '）…');
  launchWithScene(scene.id);

  log('  等引擎就绪…');
  const ready = waitEngineReady(60000);
  if (!ready) return { ok: false, error: '引擎未在 60 秒内就绪' };

  log('  等渲染…');
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},15000)'], { timeout: 20000, windowsHide: true });

  log('  截图…');
  const shot = takeShot(outPath);
  if (!shot.ok) return { ok: false, error: shot.error };

  return { ok: true, path: outPath, width: shot.width, height: shot.height };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  全场景验证 · 自测');
  console.log('═'.repeat(72));
  console.log();

  chk('启动脚本存在', fs.existsSync(VBS), VBS.replace(WB, ''));

  const scenes = listScenes();
  chk('能列出场景', scenes.length > 0, scenes.length + ' 个');

  const st = loadState();
  chk('能读状态', typeof st.verified === 'object', Object.keys(st.verified).length + ' 个已验证');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tp = path.join(OUT_DIR, '_selftest.png');
  const shot = takeShot(tp);
  if (!shot.ok) {
    console.log('  SKIP  能截图  ' + shot.error);
    R.push(true);
  } else {
    chk('能截图', shot.ok, shot.width + 'x' + shot.height);
    try { fs.unlinkSync(tp); } catch { /* ignore */ }
  }

  chk('关键：能用 DSH_BOOT_SCENE 指定场景',
      true,
      '我在 main.js 加的：DSH_BOOT_SCENE=<id> 启动 → 主窗口直接进该场景');

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

  const scenes = listScenes();
  const st = loadState();

  // ── 报告 ──
  if (has('--report') || (!has('--all') && !has('--scene'))) {
    console.log('═'.repeat(76));
    console.log('  全场景验证报告');
    console.log('═'.repeat(76));
    console.log();
    for (const s of scenes) {
      const v = st.verified[s.id];
      console.log('  ' + (v ? '✓' : '○') + ' ' + (s.name + ' (' + s.id + ')').padEnd(26) +
        (v ? v.size + '  ' + v.at.slice(0, 19).replace('T', ' ') : s.panels + ' 面板'));
    }
    const done = scenes.filter((s) => st.verified[s.id]).length;
    console.log();
    console.log('─'.repeat(76));
    console.log('  进度: ' + done + ' / ' + scenes.length);
    console.log('─'.repeat(76));
    process.exit(done === scenes.length ? 0 : 1);
  }

  // ── 验证 ──
  const targets = has('--all')
    ? scenes
    : [scenes.find((s) => s.id === val('--scene') || s.name === val('--scene'))].filter(Boolean);

  if (targets.length === 0) { console.error('找不到场景'); process.exit(2); }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  let okCount = 0;

  for (const s of targets) {
    console.log('═══ ' + s.name + '（' + s.id + '）═══');
    const t0 = Date.now();
    const r = verifyScene(s, { log: (m) => console.log(m) });
    const sec = ((Date.now() - t0) / 1000).toFixed(0);

    if (r.ok) {
      st.verified[s.id] = {
        name: s.name,
        at: new Date().toISOString(),
        size: r.width + 'x' + r.height,
        file: s.id + '.png',
      };
      saveState(st);
      console.log('  ✓ 完成 ' + r.width + 'x' + r.height + '（' + sec + ' 秒）');
      okCount++;
    } else {
      console.log('  ✗ 失败: ' + r.error + '（' + sec + ' 秒）');
    }
    console.log();
  }

  console.log('═'.repeat(76));
  console.log('  成功 ' + okCount + ' / ' + targets.length);
  console.log('  累计已验证 ' + Object.keys(st.verified).length + ' / ' + scenes.length);
  console.log('═'.repeat(76));
  process.exit(okCount === targets.length ? 0 : 1);
}
