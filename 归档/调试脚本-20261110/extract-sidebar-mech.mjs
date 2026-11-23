#!/usr/bin/env node
/**
 * 从 DSH 的 client bundle 里提取 sidebar 面板机制
 *
 * 目标：搞清楚
 *   ① sidebar.panellist 的组件如何被渲染（glyph 怎么用）
 *   ② 点击 sidebar 项如何切到 main
 *   ③ main panel 的 key 必须满足什么条件
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

const dsh = header.files.dsh;
const nm = dsh.files.node_modules;
const ai = nm.files['@deepseek-ai'];

function read(node) {
  if (!node || typeof node.size !== 'number') return null;
  const b = Buffer.alloc(node.size);
  fs.readSync(fd, b, 0, node.size, DATA_START + Number(node.offset));
  return b.toString('utf8');
}

function getClientSrc(pkgName) {
  const pkgNode = ai.files[pkgName];
  if (!pkgNode || !pkgNode.files) return null;
  const pkgJsonText = read(pkgNode.files['package.json']);
  if (!pkgJsonText) return null;
  const j = JSON.parse(pkgJsonText);
  let rel = (j.exports || {})['./client'];
  if (!rel) return null;
  if (typeof rel === 'object') rel = rel.default || rel.import;
  const parts = String(rel).replace(/^\.\//, '').split('/');
  let cur = pkgNode;
  for (const p of parts) {
    if (!cur || !cur.files || !cur.files[p]) return null;
    cur = cur.files[p];
  }
  return read(cur);
}

// ── 找 sidebar 相关代码 ──
console.log('='.repeat(76));
console.log('  在 client bundle 里找 sidebar.panellist 的渲染逻辑');
console.log('='.repeat(76));
console.log();

const pkgs = Object.keys(ai.files || {}).filter((p) => p.startsWith('dsh-client-ui-'));
for (const pkg of pkgs) {
  const src = getClientSrc(pkg);
  if (!src) continue;
  if (!src.includes('sidebar.panellist')) continue;

  console.log('▶ ' + pkg + '  (' + src.length + ' B)');

  // 找所有 sidebar.panellist 出现位置
  let pos = 0;
  let count = 0;
  while ((pos = src.indexOf('sidebar.panellist', pos)) >= 0 && count < 6) {
    console.log();
    console.log('  --- offset ' + pos + ' ---');
    console.log('  ' + src.slice(Math.max(0, pos - 400), pos + 500).replace(/\s+/g, ' '));
    pos += 18;
    count++;
  }
  console.log();
}

fs.closeSync(fd);
