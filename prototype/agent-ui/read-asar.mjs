#!/usr/bin/env node
/**
 * 最小 asar 读取器 —— 不装 @electron/asar 也能读。
 *
 * 为什么需要：用户机器上装着 Qoder / Codex 这些真实产品，
 * 它们的界面样式在 app.asar 里。这是「本地源码 > 联网文档」的最高一级证据，
 * 比任何截图和二手描述都可靠。
 *
 * asar 格式（Chromium pickle）：
 *   [0..4)   = 4 字节 uint32，总是 4（pickle 里 payload size 的字段宽度）
 *   [4..8)   = 4 字节 uint32，header pickle 的长度
 *   [8..12)  = 4 字节 uint32，header 字符串长度
 *   [12..16) = 4 字节 uint32，header JSON 长度
 *   然后 header JSON，然后按 offset 排布的文件内容
 *
 * 用法：
 *   node read-asar.mjs <app.asar> list [关键字]
 *   node read-asar.mjs <app.asar> cat <内部路径> [最大字节数]
 */

import fs from 'node:fs';

const [asarPath, cmd, arg1, arg2] = process.argv.slice(2);
if (!asarPath || !cmd) {
  console.log('  node read-asar.mjs <app.asar> list [关键字] | cat <内部路径> [maxBytes]');
  process.exit(1);
}

const fd = fs.openSync(asarPath, 'r');
const sizeBuf = Buffer.alloc(16);
fs.readSync(fd, sizeBuf, 0, 16, 0);
const headerPickleSize = sizeBuf.readUInt32LE(4);
const headerJsonLen = sizeBuf.readUInt32LE(12);
const headerBuf = Buffer.alloc(headerJsonLen);
fs.readSync(fd, headerBuf, 0, headerJsonLen, 16);
const header = JSON.parse(headerBuf.toString('utf8'));
const dataOffset = 16 + headerPickleSize; // 文件内容起点（8 + pickleSize 对齐后再 +8）

// 精确起点：16 + headerPickleSize 是常见算法（8 字节 pickle 前缀 + 对齐）
// 保险做法：直接用 8 + headerPickleSize 再对齐到 4
const base = 8 + headerPickleSize;

function walk(node, prefix, out) {
  for (const [name, meta] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (meta.files) walk(meta, p, out);
    else out.push({ path: p, size: meta.size || 0, offset: meta.offset });
  }
}

const all = [];
walk(header, '', all);

if (cmd === 'list') {
  const kw = (arg1 || '').toLowerCase();
  const hit = kw
    ? all.filter((f) => f.path.toLowerCase().includes(kw))
    : all;
  console.log('  总文件 ' + all.length + '，匹配 ' + hit.length);
  for (const f of hit.sort((a, b) => b.size - a.size).slice(0, 40)) {
    console.log('  ' + String(Math.round(f.size / 1024)).padStart(7) + 'KB  ' + f.path);
  }
} else if (cmd === 'cat') {
  const target = all.find((f) => f.path === arg1) || all.find((f) => f.path.endsWith(arg1));
  if (!target) { console.log('  没找到: ' + arg1); process.exit(2); }
  const max = Number(arg2 || 200000);
  const len = Math.min(target.size, max);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, base + target.offset);
  process.stdout.write(buf.toString('utf8'));
} else {
  console.log('  未知命令: ' + cmd);
}
fs.closeSync(fd);
