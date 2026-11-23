#!/usr/bin/env node
/**
 * 检查 main slot 容器的真实布局约束
 *
 * 问题现象：面板内容被裁切，顶部顶栏被侧栏遮住
 * 原因推测：.mn-root 用了 position:absolute;inset:0，但父容器可能不是定位上下文
 *
 * 从 layout bundle 里找 mainPanel 的 CSS
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

function clientSrc(pkg) {
  const pn = ai.files[pkg];
  if (!pn) return null;
  const j = JSON.parse(read(pn.files['package.json']));
  let rel = (j.exports || {})['./client'];
  if (typeof rel === 'object') rel = rel.default || rel.import;
  const parts = String(rel).replace(/^\.\//, '').split('/');
  let cur = pn;
  for (const p of parts) {
    if (!cur.files || !cur.files[p]) return null;
    cur = cur.files[p];
  }
  return read(cur);
}

const src = clientSrc('dsh-client-ui-layout');
console.log('dsh-client-ui-layout: ' + src.length + ' B');
console.log();

// 找 mainPanel 相关 CSS
console.log('='.repeat(76));
console.log('  mainPanel 的 CSS');
console.log('='.repeat(76));
console.log();

const patterns = [
  /\.mainPanel\s*\{[^}]*\}/g,
  /mainPanel['"]?\s*:\s*['"][^'"]+['"]/g,
  /data-global-panel[^{]*\{[^}]*\}/g,
];

for (const re of patterns) {
  const m = src.match(re);
  if (m) {
    for (const x of m.slice(0, 5)) console.log(x + '\n');
  }
}

// 找 CSS 模块映射（className → 真实类名）
const modMatch = src.match(/AppFrame_module_css_default\s*=\s*\{[\s\S]{0,800}?\}/);
if (modMatch) {
  console.log('='.repeat(76));
  console.log('  AppFrame CSS 模块映射');
  console.log('='.repeat(76));
  console.log(modMatch[0].slice(0, 800));
  console.log();
}

// 找真实 CSS 文本（含 mainPanel 选择器）
const cssMatch = src.match(new RegExp('\\.[A-Za-z0-9_-]*mainPanel[A-Za-z0-9_-]*\\s*\\{[^}]{0,400}\\}', 'g'));
if (cssMatch) {
  console.log('='.repeat(76));
  console.log('  真实 CSS（含 mainPanel）');
  console.log('='.repeat(76));
  for (const c of cssMatch.slice(0, 6)) console.log(c + '\n');
}

fs.closeSync(fd);
