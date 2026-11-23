#!/usr/bin/env node
/**
 * 从 asar 提取指定路径到本地（可用版）
 *
 * 修了之前的 bug：readFile 每次重开文件句柄，应该共用。
 */

import fs from 'node:fs';
import path from 'node:path';

const ASAR = process.argv[2] || 'D:/file/software/DeepSeek Harness/resources/app.asar';
const OUT = process.argv[3] || path.join(process.cwd(), '_extract');
const MODE = process.argv[4] || 'probe';   // probe | core | all

const fd = fs.openSync(ASAR, 'r');
const hbuf = Buffer.alloc(16);
fs.readSync(fd, hbuf, 0, 16, 0);
const jsonSize = hbuf.readUInt32LE(12);
const hb = Buffer.alloc(jsonSize);
fs.readSync(fd, hb, 0, jsonSize, 16);
const header = JSON.parse(hb.toString('utf8'));
const DATA_START = 16 + jsonSize;

console.log('='.repeat(74));
console.log('  asar 提取器');
console.log('='.repeat(74));
console.log();
console.log('  源: ' + ASAR);
console.log('  出: ' + OUT);
console.log('  模式: ' + MODE);
console.log('  数据起点: ' + DATA_START);
console.log();

function findNode(p) {
  const parts = p.split('/').filter(Boolean);
  let cur = header.files;
  for (const part of parts) {
    if (!cur || !cur[part]) return null;
    cur = cur[part];
  }
  return cur;
}

function readFileSync(p) {
  const node = findNode(p);
  if (!node || typeof node.size !== 'number') return null;
  const b = Buffer.alloc(node.size);
  fs.readSync(fd, b, 0, node.size, DATA_START + Number(node.offset));
  return b.toString('utf8');
}

function collectFiles(node, basePath, out) {
  if (!node) return;
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      collectFiles(child, basePath ? basePath + '/' + name : name, out);
    }
  } else if (typeof node.size === 'number') {
    out.push({ path: basePath, size: node.size, offset: Number(node.offset) });
  }
}

// ══════════════════════════════════════════════════════════════
//  probe 模式：读关键文件内容
// ══════════════════════════════════════════════════════════════
if (MODE === 'probe') {
  const PROBES = [
    'dsh/package.json',
    'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js',
    'dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json',
  ];

  for (const p of PROBES) {
    console.log('-'.repeat(74));
    console.log('  ' + p);
    console.log('-'.repeat(74));
    const content = readFileSync(p);
    if (!content) {
      console.log('  (读不到)');
      console.log();
      continue;
    }
    console.log('  大小: ' + content.length + ' 字节');
    console.log();

    // 如果是 JSON，格式化打印关键字段
    if (p.endsWith('.json')) {
      try {
        const j = JSON.parse(content);
        for (const k of ['name', 'version', 'main', 'bin', 'type']) {
          if (j[k] !== undefined) console.log('  ' + k + ': ' + JSON.stringify(j[k]));
        }
        if (j.dependencies) {
          console.log('  dependencies (' + Object.keys(j.dependencies).length + '):');
          for (const [k, v] of Object.entries(j.dependencies).slice(0, 30)) {
            console.log('    ' + k.padEnd(48) + v);
          }
          if (Object.keys(j.dependencies).length > 30) {
            console.log('    ... 另有 ' + (Object.keys(j.dependencies).length - 30) + ' 个');
          }
        }
      } catch (e) {
        console.log('  JSON 解析失败: ' + e.message);
        console.log('  前 200 字符: ' + content.slice(0, 200));
      }
    } else {
      // JS：打印前 30 行
      const lines = content.split('\n');
      console.log('  前 ' + Math.min(30, lines.length) + ' 行:');
      for (let i = 0; i < Math.min(30, lines.length); i++) {
        console.log('    ' + String(i + 1).padStart(3) + ': ' + lines[i].slice(0, 100));
      }
    }
    console.log();
  }

  fs.closeSync(fd);
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════
//  core 模式：提取核心（裁掉 experimental + libreoffice）
// ══════════════════════════════════════════════════════════════
const all = [];
collectFiles(header, '', all);

let targets;
if (MODE === 'all') {
  targets = all;
} else {
  // core：排除 experimental 和 libreoffice
  targets = all.filter(f => {
    if (f.path.includes('/experimental')) return false;
    if (f.path.includes('libreoffice')) return false;
    return true;
  });
}

const totalBytes = targets.reduce((s, f) => s + f.size, 0);
console.log('  待提取: ' + targets.length + ' 文件, ' + (totalBytes / 1024 / 1024).toFixed(1) + ' MB');
console.log();

fs.mkdirSync(OUT, { recursive: true });

let written = 0;
let bytes = 0;
const t0 = Date.now();

for (const f of targets) {
  const outPath = path.join(OUT, f.path);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const b = Buffer.alloc(f.size);
  fs.readSync(fd, b, 0, f.size, DATA_START + f.offset);
  fs.writeFileSync(outPath, b);
  written++;
  bytes += f.size;

  if (written % 2000 === 0) {
    const pct = Math.round(written / targets.length * 100);
    process.stdout.write('\r  进度: ' + written + '/' + targets.length + ' (' + pct + '%)   ');
  }
}

fs.closeSync(fd);
console.log('\r  完成: ' + written + ' 文件, ' + (bytes / 1024 / 1024).toFixed(1) + ' MB    ');
console.log('  耗时: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log('  位置: ' + OUT);
