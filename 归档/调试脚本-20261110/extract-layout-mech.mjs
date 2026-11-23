#!/usr/bin/env node
/**
 * 深挖 main panel 的 retain 机制
 *
 * 从 dsh-client-ui-layout 的 client bundle 里找出：
 *   ① retainMainPanels 何时被调用
 *   ② selectPanel 如何影响 activePanelId
 *   ③ 新注册的 main key 如何被纳入 panel 列表
 */

import fs from 'node:fs';

const ASAR = 'D:/file/software/DeepSeek Harness/resources/app.asar';
const fd = fs.openSync(ASAR, 'r');
const hbuf = Buffer.alloc(16);
fs.readSync(fd, hbuf, 0, 16, 0);
const jsonSize = hbuf.readUInt32LE(12);
const hb = Buffer.alloc(jsonSize);
fs.readSync(fd, hb, 0, jsonSize, 16);
const header = JSON.parse(hb.toString('utf8'));
const DATA_START = 16 + jsonSize;

const ai = header.files.dsh.files.node_modules.files['@deepseek-ai'];

function read(node) {
  if (!node || typeof node.size !== 'number') return null;
  const b = Buffer.alloc(node.size);
  fs.readSync(fd, b, 0, node.size, DATA_START + Number(node.offset));
  return b.toString('utf8');
}

function getClientSrc(pkgName) {
  const pkgNode = ai.files[pkgName];
  const pkgJsonText = read(pkgNode.files['package.json']);
  const j = JSON.parse(pkgJsonText);
  let rel = (j.exports || {})['./client'];
  if (typeof rel === 'object') rel = rel.default || rel.import;
  const parts = String(rel).replace(/^\.\//, '').split('/');
  let cur = pkgNode;
  for (const p of parts) {
    if (!cur || !cur.files || !cur.files[p]) return null;
    cur = cur.files[p];
  }
  return read(cur);
}

const src = getClientSrc('dsh-client-ui-layout');
console.log('dsh-client-ui-layout  client: ' + src.length + ' B');
console.log();

// ══ 1. retainMainPanels ══
console.log('='.repeat(76));
console.log('  retainMainPanels');
console.log('='.repeat(76));
console.log();
let pos = 0;
let n = 0;
while ((pos = src.indexOf('retainMainPanels', pos)) >= 0 && n < 5) {
  console.log('--- offset ' + pos + ' ---');
  console.log(src.slice(Math.max(0, pos - 600), pos + 400).replace(/\s+/g, ' '));
  console.log();
  pos += 16;
  n++;
}

// ══ 2. selectPanel ══
console.log('='.repeat(76));
console.log('  selectPanel');
console.log('='.repeat(76));
console.log();
pos = 0;
n = 0;
while ((pos = src.indexOf('selectPanel', pos)) >= 0 && n < 4) {
  console.log('--- offset ' + pos + ' ---');
  console.log(src.slice(Math.max(0, pos - 300), pos + 500).replace(/\s+/g, ' '));
  console.log();
  pos += 11;
  n++;
}

// ══ 3. retainMainPanels 被谁调用 ══
console.log('='.repeat(76));
console.log('  谁调用了 retainMainPanels');
console.log('='.repeat(76));
console.log();
const calls = [...src.matchAll(/(\w+)\s*\(\s*\)/g)].map((m) => m[1]);
// 找 retainMainPanels 作为标识符出现的位置
pos = 0;
while ((pos = src.indexOf('retainMainPanels', pos)) >= 0) {
  const after = src.slice(pos, pos + 40);
  const before = src.slice(Math.max(0, pos - 80), pos);
  console.log('  前文: ...' + before.replace(/\s+/g, ' '));
  console.log('  此处: ' + after.replace(/\s+/g, ' '));
  console.log();
  pos += 16;
}

fs.closeSync(fd);
