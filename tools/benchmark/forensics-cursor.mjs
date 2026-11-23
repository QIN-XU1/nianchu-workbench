#!/usr/bin/env node
/**
 * Cursor 安装包取证 —— 从真实的 198MB 安装器里提取结构证据
 *
 * 纪律：
 *   · 只解包、只读结构与元数据
 *   · 不运行安装器、不改系统
 *   · 不引用任何用户数据
 *
 * 用法：node tools/benchmark/forensics-cursor.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const INST = 'D:/refs/_installers/CursorUserSetup-x64-3.30.14.exe';
const OUT = path.join(REPO, 'research/拆解/cursor-forensics.json');
const EXTRACT = 'D:/refs/_installers/cursor-extract';

console.log('');
console.log('  Cursor 安装包取证');
console.log('  ' + '─'.repeat(72));

if (!fs.existsSync(INST)) {
  console.error('  ✗ 安装包不存在：' + INST);
  process.exit(1);
}
const instSize = fs.statSync(INST).size;
console.log('  安装包 ' + Math.round(instSize / 1024 / 1024 * 10) / 10 + 'MB');

// ── 1. 用 7z 解包（安装器是 NSIS/Inno 自解压）──
const sevenZ = [
  'C:/Program Files/7-Zip/7z.exe',
  'C:/Program Files (x86)/7-Zip/7z.exe',
  'D:/file/software/7-Zip/7z.exe',
].find((p) => fs.existsSync(p));

let extracted = false;
if (sevenZ) {
  console.log('  7z: ' + sevenZ);
  fs.mkdirSync(EXTRACT, { recursive: true });
  try {
    execFileSync(sevenZ, ['x', INST, '-o' + EXTRACT, '-y'], { stdio: 'ignore', timeout: 600000 });
    extracted = true;
    console.log('  ✓ 解包成功');
  } catch (e) {
    console.log('  ✗ 解包失败：' + String(e.message).slice(0, 80));
  }
} else {
  console.log('  ✗ 没有 7z，改用其他方式');
}

// ── 2. 从 exe 尾部找 7z 签名并手工解（7z 不可用时的备选）──
let fallbackUsed = false;
if (!extracted) {
  // Inno/NSIS 自解压把 payload 放在偏移处；找 7z magic
  const buf = fs.readFileSync(INST);
  const MAGIC = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);  // 7z
  let off = -1;
  for (let i = buf.length - 6; i > 0; i--) {
    if (buf.compare(MAGIC, 0, 6, i, i + 6) === 0) { off = i; break; }
  }
  if (off > 0) {
    const out7z = path.join(path.dirname(EXTRACT), 'cursor-payload.7z');
    fs.writeFileSync(out7z, buf.subarray(off));
    console.log('  ✓ 找到 7z payload @ ' + off + '，已切出 ' + Math.round((buf.length - off) / 1024 / 1024) + 'MB');
    fallbackUsed = true;
  } else {
    console.log('  ✗ 没找到 7z 签名');
  }
}

// ── 3. 分析解出来的结构 ──
const rec = {
  what: 'Cursor 安装包取证（只解包，未安装、未运行）',
  at: new Date().toISOString(),
  generator: 'tools/benchmark/forensics-cursor.mjs',
  installer: { path: INST, mb: Math.round(instSize / 1024 / 1024 * 10) / 10, version: '3.30.14', commit: '5f54c8173e5552412beb40702adac16275677fa0' },
  extracted: extracted,
  fallbackUsed,
};

if (extracted && fs.existsSync(EXTRACT)) {
  const files = [];
  const walk = (dir, depth = 0) => {
    if (depth > 6) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      try {
        const sz = fs.statSync(p).size;
        files.push({ rel: path.relative(EXTRACT, p).replace(/\\/g, '/'), size: sz });
      } catch { /* 忽略 */ }
    }
  };
  walk(EXTRACT);

  rec.files = { total: files.length, mb: Math.round(files.reduce((a, f) => a + f.size, 0) / 1024 / 1024 * 10) / 10 };
  rec.byExt = {};
  for (const f of files) {
    const ext = path.extname(f.rel).toLowerCase() || '(none)';
    rec.byExt[ext] = (rec.byExt[ext] || 0) + 1;
  }
  rec.byExt = Object.fromEntries(Object.entries(rec.byExt).sort((a, b) => b[1] - a[1]).slice(0, 15));

  // 顶层目录
  rec.topDirs = {};
  for (const f of files) {
    const top = f.rel.split('/')[0] || '(root)';
    rec.topDirs[top] = (rec.topDirs[top] || 0) + 1;
  }
  rec.topDirs = Object.fromEntries(Object.entries(rec.topDirs).sort((a, b) => b[1] - a[1]).slice(0, 15));

  // 大文件
  rec.bigFiles = files.sort((a, b) => b.size - a.size).slice(0, 12).map((f) => ({ rel: f.rel, mb: Math.round(f.size / 1024 / 1024 * 10) / 10 }));

  console.log('  解出 ' + rec.files.total + ' 文件 / ' + rec.files.mb + 'MB');
  console.log('  顶层: ' + Object.entries(rec.topDirs).slice(0, 8).map(([k, v]) => k + '(' + v + ')').join(' '));
  console.log('  大文件:');
  for (const f of rec.bigFiles.slice(0, 6)) console.log('    ' + String(f.mb).padStart(7) + 'MB  ' + f.rel);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(rec, null, 2) + '\n', 'utf8');
console.log('');
console.log('  → ' + path.relative(REPO, OUT));
console.log('');