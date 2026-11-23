#!/usr/bin/env node
/**
 * 量化「纯前端 fork」缺了什么
 *
 * 起因：跑 OpenBitFun 自己的治理检查时发现它们**假设完整 monorepo**：
 *   - typography:audit  → missing-typography-owner（要 src/crates/assembly/core/src/service/config/types.rs）
 *   - theme:color-audit → exclusions[0..15].path does not exist（要 src/crates/、src/apps/mobile/ 等）
 *
 * 这不是我们写错了，是**只 fork 前端**的结构性后果。
 * 这个脚本量出：上游有哪些顶层目录、我们有哪些、各多大。
 */
import fs from 'node:fs';
import path from 'node:path';

const UP = 'D:/refs/openbitfun-src/OpenBitFun-main';
const US = process.cwd();

function topDirs(root) {
  const out = {};
  const walk = (dir, depth, prefix) => {
    if (depth > 2) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (/^(node_modules|\.git|target|dist|\.cargo)$/.test(e.name)) continue;
      const rel = prefix ? prefix + '/' + e.name : e.name;
      let n = 0;
      try { n = fs.readdirSync(path.join(dir, e.name)).length; } catch { /* */ }
      out[rel] = (out[rel] || 0) + n;
      walk(path.join(dir, e.name), depth + 1, rel);
    }
  };
  walk(root, 0, '');
  return out;
}

console.log('');
console.log('  纯前端 fork 缺了什么');
console.log('  ' + '='.repeat(74));

const up = topDirs(UP);
const us = topDirs(US);

// 只看前两层
const upTop = Object.keys(up).filter((k) => !k.includes('/'));
const usTop = Object.keys(us).filter((k) => !k.includes('/'));

console.log('');
console.log('  上游顶层目录 (' + upTop.length + ')');
for (const d of upTop.sort()) {
  const here = usTop.includes(d);
  console.log('    ' + (here ? '✓' : '✗') + ' ' + d.padEnd(22) + String(up[d]).padStart(5) + ' 项' + (here ? '' : '   ← 缺'));
}

console.log('');
console.log('  我们有的顶层目录 (' + usTop.length + ')');
console.log('    ' + usTop.sort().join('  '));

// 治理检查依赖的路径
console.log('');
console.log('  治理检查依赖但缺失的路径');
const NEED = [
  'src/crates/assembly/core/src/service/config/types.rs',
  'src/crates/contracts/product-domains/src/miniapp/builtin/assets/ppt-live/src',
  'src/crates/contracts/product-domains/src/miniapp/builtin/assets/ppt-live/test',
  'src/crates/contracts/product-domains/src/miniapp/builtin/assets/ppt-live/dist',
  'src/apps/mobile/android/app/src/main/res/drawable',
  'src/apps/mobile/ios/OpenBitFun/Resources.xcassets',
  'src/apps/mobile/harmonyos/entry/src/main/resources/base/media',
  'src/apps/mobile/design-system/preview/generated',
  'src/apps/data-tools/ui/generated',
  'src/apps/desktop/src/generated',
  'src/crates/contracts/product-domains/src/miniapp/generated',
];
let miss = 0, have = 0;
for (const p of NEED) {
  const a = fs.existsSync(path.join(US, p));
  const b = fs.existsSync(path.join(UP, p));
  if (!a) miss++; else have++;
  console.log('    ' + (a ? '✓ 有' : '✗ 缺') + '  ' + (b ? '（上游有）' : '（上游也没有）') + '  ' + p);
}
console.log('');
console.log('  缺失 ' + miss + ' / ' + NEED.length);

// src 下的对比
console.log('');
console.log('  src/ 下第二层对比');
const upSrc = Object.keys(up).filter((k) => k.startsWith('src/'));
const usSrc = Object.keys(us).filter((k) => k.startsWith('src/'));
for (const d of upSrc.sort()) {
  const here = usSrc.includes(d);
  if (!here) console.log('    ✗ ' + d.padEnd(30) + String(up[d]).padStart(5) + ' 项');
}
console.log('');
console.log('  上游 src/ 二层 ' + upSrc.length + ' 个 · 我们 ' + usSrc.length + ' 个');
console.log('');