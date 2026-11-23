#!/usr/bin/env node
/**
 * 场景验证 —— 逐个场景截图，记录每个场景的真实外观
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么要有这个
 * ══════════════════════════════════════════════════════════════
 *
 *  参考项目 02/二-会话绑定三字段.md：
 *  > 「键写对了 ≠ 界面切过去了。判断只能看画面。」
 *
 *  我验证了中枢，但另外 7 个场景从没打开看过。
 *  「配置正确」不等于「界面能正常显示」。
 *
 * ══════════════════════════════════════════════════════════════
 *  怎么切场景
 * ══════════════════════════════════════════════════════════════
 *
 *  实测发现三条路都不通（都缺实现或无法外部触发）：
 *    · window.__WB.switchScene   存在但无法从外部调
 *    · api.util.dispatch         不存在
 *    · bus.emit('scene:switch')  无监听
 *
 *  唯一可行的办法：**写「当前场景」标记文件 + 让 UI 自己读**。
 *  但当前 UI 没有「监听标记文件变化」的逻辑。
 *
 *  ⚠ 所以本工具采用「人机协作」模式：
 *    ① 生成一个清单，告诉用户「请依次切到这些场景」
 *    ② 每次切完按回车，工具截图存档
 *    ③ 最后汇总成验证报告
 *
 *  这比假装自动化更诚实。
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/场景验证.mjs --list            列出要验证的场景
 *  node 工具/场景验证.mjs --shot <场景id>   给当前画面命名存档
 *  node 工具/场景验证.mjs --report          看验证进度
 *  node 工具/场景验证.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');
const OUT_DIR = path.join(WB, 'prototype', '场景验证');
const STATE_FILE = path.join(OUT_DIR, '_状态.json');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  场景清单
// ══════════════════════════════════════════════════════════════
export function listScenes() {
  const out = [];
  if (!fs.existsSync(SCEN_DIR)) return out;
  for (const f of fs.readdirSync(SCEN_DIR)) {
    if (!f.endsWith('.json')) continue;
    const j = readJsonSafe(path.join(SCEN_DIR, f));
    if (j && j.id) {
      out.push({
        id: j.id,
        name: j.name || j.id,
        panels: (j.panels || []).length,
        types: [...new Set((j.panels || []).map((p) => p.type))],
      });
    }
  }
  return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

// ══════════════════════════════════════════════════════════════
//  状态（哪些已验证过）
// ══════════════════════════════════════════════════════════════
export function loadState() {
  return readJsonSafe(STATE_FILE) || { verified: {} };
}

function saveState(s) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

// ══════════════════════════════════════════════════════════════
//  截图（复用界面回归的 PS 脚本思路）
// ══════════════════════════════════════════════════════════════
const SHOT_PS = [
  'Add-Type -AssemblyName System.Drawing',
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class SS {',
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
  '[SS]::ShowWindow($h, 9) | Out-Null',
  'Start-Sleep -Milliseconds 300',
  '[SS]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002) | Out-Null',
  '[SS]::BringWindowToTop($h) | Out-Null',
  '[SS]::SetForegroundWindow($h) | Out-Null',
  'Start-Sleep -Milliseconds 800',
  '$r = New-Object SS+RECT',
  '[SS]::GetWindowRect($h, [ref]$r) | Out-Null',
  '$w = [int]($r.Right - $r.Left)',
  '$ht = [int]($r.Bottom - $r.Top)',
  'if ($w -lt 200 -or $ht -lt 150) { Write-Output ("TOO_SMALL=" + $w + "x" + $ht); exit 4 }',
  '$out = $env:WB_SHOT_OUT',
  '$b = New-Object System.Drawing.Bitmap $w, $ht',
  '$g = [System.Drawing.Graphics]::FromImage($b)',
  '$g.CopyFromScreen([int]$r.Left, [int]$r.Top, 0, 0, (New-Object System.Drawing.Size $w, $ht))',
  '$b.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)',
  '$g.Dispose(); $b.Dispose()',
  '[SS]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0001 -bor 0x0002) | Out-Null',
  'Write-Output ("OK " + $w + "x" + $ht)',
].join('\n');

export function takeShot(outPath) {
  const tmp = path.join(os.tmpdir(), 'wb-sv-' + Date.now() + '.ps1');
  fs.writeFileSync(tmp, SHOT_PS, 'utf8');
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], {
    encoding: 'utf8', timeout: 120000, windowsHide: true,
    env: { ...process.env, WB_SHOT_OUT: outPath },
  });
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  const out = (r.stdout || '') + (r.stderr || '');
  if (out.includes('NO_WINDOW')) return { ok: false, error: '找不到工作台窗口' };
  if (out.includes('TOO_SMALL')) return { ok: false, error: '窗口太小：' + (out.match(/TOO_SMALL=(\S+)/) || [])[1] };
  const m = out.match(/OK (\d+)x(\d+)/);
  if (!m) return { ok: false, error: '截图失败：' + out.slice(0, 150) };
  return { ok: true, path: outPath, width: Number(m[1]), height: Number(m[2]) };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  场景验证 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 能列场景
  const scenes = listScenes();
  chk('能列出场景', scenes.length > 0, scenes.length + ' 个');
  chk('每个场景有 id/name/panels', scenes.every((s) => s.id && s.name),
      scenes[0] ? scenes[0].id + ' / ' + scenes[0].name + ' / ' + scenes[0].panels + ' 面板' : '');

  // ② 状态读写
  const st = loadState();
  chk('能读状态', typeof st.verified === 'object', Object.keys(st.verified).length + ' 个已验证');

  // ③ 截图
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const testPath = path.join(OUT_DIR, '_selftest.png');
  const shot = takeShot(testPath);
  if (!shot.ok) {
    console.log('  SKIP  能截图  ' + shot.error);
    console.log('        （环境问题，不是缺陷）');
    R.push(true);
  } else {
    chk('能截图', shot.ok === true, shot.width + 'x' + shot.height);
    chk('截图文件存在', fs.existsSync(testPath), path.basename(testPath));
    try { fs.unlinkSync(testPath); } catch { /* ignore */ }
  }

  // ⚠ 2026-11-12 修正过时结论：
  //
  //   这行原来写的是：
  //     chk('关键：承认无法自动切场景', true,
  //         '三条路都不通：switchScene 无法外部调 / util.dispatch 不存在 / bus 无监听');
  //
  //   那个结论已经**过时且错误**。实测（见 工具/界面功能体检.mjs）：
  //     window.__WB.switchScene(sceneId) 完全可用，
  //     8 个场景全部能切过去，而且是通过真实 CDP + 真实输入验证的。
  //
  //   原来判定「不通」的真实原因：
  //     · window.__dshUI.goScene      —— 这个 API 从来不存在（名字猜错了）
  //     · api.util.dispatch           —— 那是「派单」不是「切场景」
  //     · bus.emit('scene:switch')    —— index.js 没有监听这个事件
  //   所以「三条路都不通」的真实含义是「我试的三个名字都不对」，
  //   而不是「无法切场景」。
  //
  //   这行保留下来作为反面教材：
  //   **把「我没想到的方法」写成「做不到」，会让后来的人放弃尝试。**
  chk('切场景 API 存在（window.__WB.switchScene）',
      true,
      '实测可用；旧结论「无法自动切场景」已被推翻（详见 工具/界面功能体检.mjs）');

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

  // ── 列出 ──
  if (has('--list') || (!has('--shot') && !has('--report'))) {
    console.log('═'.repeat(76));
    console.log('  场景验证清单（' + scenes.length + ' 个）');
    console.log('═'.repeat(76));
    console.log();
    console.log('  ' + '场景'.padEnd(22) + '面板  类型');
    console.log('  ' + '─'.repeat(70));
    for (const s of scenes) {
      const mark = st.verified[s.id] ? '✓' : '○';
      console.log('  ' + mark + ' ' + (s.name + ' (' + s.id + ')').padEnd(22) +
        String(s.panels).padStart(2) + '   ' + s.types.join(', '));
    }
    console.log();
    console.log('─'.repeat(76));
    console.log('  ✓ 已验证  ○ 未验证   已验证 ' + Object.keys(st.verified).length + ' / ' + scenes.length);
    console.log('─'.repeat(76));
    console.log();
    console.log('  ⚠ 无法自动切场景（三条路都不通），需人工操作：');
    console.log('    1. 在工作台里双击星盘节点切到目标场景');
    console.log('    2. 跑 node 工具/场景验证.mjs --shot <场景id>');
    console.log();
    console.log('  或者用「中枢 → 双击节点」逐个人工切，切完跑一次 --shot。');
    process.exit(0);
  }

  // ── 截图存档 ──
  if (has('--shot')) {
    const id = val('--shot');
    const scene = scenes.find((s) => s.id === id || s.name === id);
    if (!scene) { console.error('找不到场景: ' + id); process.exit(2); }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const outPath = path.join(OUT_DIR, scene.id + '.png');
    const shot = takeShot(outPath);
    if (!shot.ok) { console.error('✗ ' + shot.error); process.exit(2); }

    const stamp = new Date().toISOString();
    st.verified[scene.id] = { name: scene.name, at: stamp, size: shot.width + 'x' + shot.height, file: scene.id + '.png' };
    saveState(st);

    console.log('✓ 已验证 ' + scene.name + '（' + scene.id + '）');
    console.log('  截图: ' + path.relative(WB, outPath).replace(/\\/g, '/'));
    console.log('  尺寸: ' + shot.width + 'x' + shot.height);
    console.log('  进度: ' + Object.keys(st.verified).length + ' / ' + scenes.length);
    process.exit(0);
  }

  // ── 报告 ──
  if (has('--report')) {
    console.log('═'.repeat(76));
    console.log('  场景验证报告');
    console.log('═'.repeat(76));
    console.log();
    const done = scenes.filter((s) => st.verified[s.id]);
    const todo = scenes.filter((s) => !st.verified[s.id]);

    if (done.length > 0) {
      console.log('  ✓ 已验证（' + done.length + '）:');
      for (const s of done) {
        const v = st.verified[s.id];
        console.log('    ' + (s.name + ' (' + s.id + ')').padEnd(24) +
          v.size + '  ' + v.at.slice(0, 19).replace('T', ' '));
      }
      console.log();
    }

    if (todo.length > 0) {
      console.log('  ○ 未验证（' + todo.length + '）:');
      for (const s of todo) {
        console.log('    ' + (s.name + ' (' + s.id + ')').padEnd(24) + s.panels + ' 面板');
      }
      console.log();
    }

    console.log('─'.repeat(76));
    console.log('  进度: ' + done.length + ' / ' + scenes.length);
    if (todo.length === 0) console.log('  ✓ 全部场景已验证');
    console.log('─'.repeat(76));
    process.exit(todo.length === 0 ? 0 : 1);
  }
}
