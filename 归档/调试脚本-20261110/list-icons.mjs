#!/usr/bin/env node
/**
 * 找出 client bundle 里所有可用的图标组件
 *
 * 这些图标由 primitives 提供，在 Client 运行时通过 require 拿到。
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

// primitives 包
const prim = ai.files['dsh-client-ui-primitives'];
console.log('dsh-client-ui-primitives 存在: ' + !!prim);
if (prim && prim.files) {
  console.log('子项: ' + Object.keys(prim.files).join(', '));
}
console.log();

// 从所有 client bundle 里收集 Icon* 用法
const iconNames = new Map();
const pkgs = Object.keys(ai.files || {}).filter((p) => p.startsWith('dsh-client-ui-'));

for (const pkg of pkgs) {
  const pkgNode = ai.files[pkg];
  if (!pkgNode || !pkgNode.files) continue;
  const pkgJsonText = read(pkgNode.files['package.json']);
  if (!pkgJsonText) continue;
  let j;
  try { j = JSON.parse(pkgJsonText); } catch { continue; }
  let rel = (j.exports || {})['./client'];
  if (!rel) continue;
  if (typeof rel === 'object') rel = rel.default || rel.import;
  const parts = String(rel).replace(/^\.\//, '').split('/');
  let cur = pkgNode;
  let ok = true;
  for (const p of parts) {
    if (!cur || !cur.files || !cur.files[p]) { ok = false; break; }
    cur = cur.files[p];
  }
  if (!ok) continue;
  const src = read(cur);
  if (!src) continue;

  // 找 primitives.IconXxx
  const re = /_deepseek_ai_dsh_client_ui_primitives\.(Icon[A-Za-z0-9]+)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    if (!iconNames.has(name)) iconNames.set(name, new Set());
    iconNames.get(name).add(pkg);
  }
}

console.log('可用图标组件: ' + iconNames.size + ' 个');
console.log();
const sorted = [...iconNames.entries()].sort((a, b) => a[0].localeCompare(b[0]));
for (const [name, users] of sorted) {
  console.log('  ' + name.padEnd(46) + ' 用在 ' + users.size + ' 个包');
}

fs.closeSync(fd);
