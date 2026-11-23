#!/usr/bin/env node
/**
 * 全场景面板状态检查（CDP 版）
 *
 * 比截图快得多、也准得多：
 *   - 直接读 DOM，看每个面板有没有渲染出内容
 *   - 能抓到「未知面板类型」「读取失败」这类文字
 *   - 不需要人工看截图
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BASE = 'D:/file/AI Temp/DeepSeek/Agent自研';
const WB = BASE + '/workbench';
const VBS = WB + '/启动.vbs';
const OUT = WB + '/prototype/场景验证';

const SCENES = [
  { id: 'hub', name: '中枢' },
  { id: 'arch-review', name: '架构梳理' },
  { id: 'build-plan', name: '实施计划' },
  { id: 'competitor-analyze', name: '竞品拆解' },
  { id: 'incident-analysis', name: '故障分析' },
  { id: 'pc-cleanup', name: '本地电脑' },
  { id: 'research', name: '调研' },
  { id: 'reverse-eng', name: '逆向分析' },
  { id: 'self-review', name: '自我复盘' },
];

function sleepMs(ms) {
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},' + ms + ')'], { timeout: ms + 5000 });
}

function killElectron() {
  spawnSync('powershell', ['-NoProfile', '-Command',
    'Get-Process -Name electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue'],
  { timeout: 30000, windowsHide: true });
}

function launch(sceneId) {
  spawnSync('cscript', ['//nologo', VBS], {
    timeout: 60000, windowsHide: true,
    env: { ...process.env, DSH_BOOT_SCENE: sceneId, SEA_DEBUG_PORT: '9333' },
  });
}

function cdp(expr) {
  const r = spawnSync(process.execPath, [WB + '/工具/Cdp.mjs', '--eval', expr], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  const out = (r.stdout || '').trim();
  try { return JSON.parse(out); } catch { return { __raw: out, __err: (r.stderr || '').slice(0, 200) }; }
}

const INSPECT = `(function(){
  const out = { panels: [], errors: [], raw: [] };
  // 所有面板
  document.querySelectorAll('.wb-panel').forEach(function(p){
    const num = p.querySelector('.wb-panel-num');
    const title = p.querySelector('.wb-panel-title');
    const sub = p.querySelector('.wb-panel-sub');
    const body = p.querySelector('.wb-panel-body');
    let txt = '';
    try { txt = (body ? body.innerText : '').trim(); } catch(e) {}
    out.panels.push({
      num: num ? num.textContent.trim() : '',
      title: title ? title.textContent.trim() : '',
      sub: sub ? sub.textContent.trim() : '',
      bodyLen: txt.length,
      bodyHead: txt.slice(0, 100).replace(/\\s+/g, ' '),
    });
    // 抓错误特征
    const bad = ['未知面板类型', '未注册', '读取失败', '列目录失败', 'token 缺失', '待接入', '加载失败'];
    for (const b of bad) {
      if (txt.indexOf(b) >= 0) out.errors.push(title ? title.textContent.trim() : '?' + ' → ' + b);
    }
  });
  // 神经元节点（中枢场景）
  out.raw.push('标题=' + document.title);
  return out;
})()`;

// ══════════════════════════════════════════════════════════════
fs.mkdirSync(OUT, { recursive: true });
const results = [];

for (const s of SCENES) {
  console.log('═══ ' + s.name + '（' + s.id + '）═══');
  killElectron();
  sleepMs(2500);
  launch(s.id);

  // 等引擎 + 渲染
  let ready = false;
  for (let i = 0; i < 60; i++) {
    sleepMs(1000);
    const t = cdp('document.title');
    if (t && t.__raw && !t.__err && t.__raw.length > 1) { ready = true; break; }
    if (i > 50) break;
  }
  if (!ready) { console.log('  ✗ CDP 连不上'); results.push({ ...s, ok: false, err: 'CDP 连不上' }); continue; }

  sleepMs(3000);   // 等面板数据加载
  const r = cdp(INSPECT);
  if (r.__err) { console.log('  ✗ ' + r.__err); results.push({ ...s, ok: false, err: r.__err }); continue; }

  console.log('  面板 ' + (r.panels || []).length + ' 个:');
  for (const p of r.panels || []) {
    const flag = p.bodyLen < 10 ? '⚠空' : '  ';
    console.log('    ' + flag + ' ' + (p.num + ' ' + p.title).padEnd(24) + ' ' + String(p.bodyLen).padStart(5) + ' 字  ' + p.bodyHead.slice(0, 60));
  }
  if ((r.errors || []).length) {
    console.log('  ⚠ 错误特征: ' + r.errors.join(' | '));
  }
  results.push({ ...s, ok: (r.errors || []).length === 0, panels: r.panels, errors: r.errors });
  console.log();
}

// ══════════════════════════════════════════════════════════════
console.log('═'.repeat(76));
console.log('  汇总');
console.log('═'.repeat(76));
let okCount = 0;
for (const r of results) {
  if (r.ok) okCount++;
  console.log('  ' + (r.ok ? '✓' : '✗') + ' ' + r.name.padEnd(12) +
    (r.ok ? String((r.panels || []).length) + ' 面板全正常'
          : '问题: ' + (r.errors || [r.err]).join(', ')));
}
console.log();
console.log('  通过 ' + okCount + ' / ' + results.length);

fs.writeFileSync(OUT + '/_全场景检查.json', JSON.stringify(results, null, 2), 'utf8');
console.log('  报告: workbench/prototype/场景验证/_全场景检查.json');
