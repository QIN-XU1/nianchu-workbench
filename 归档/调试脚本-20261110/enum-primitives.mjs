#!/usr/bin/env node
/**
 * 枚举 primitives 包的全部导出
 *
 * 从所有 client bundle 里收集 xxx_primitives.Yyy 的用法，
 * 反推导出清单（含组件与图标）。
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

const members = new Map();   // name -> Set(pkg)

const pkgs = Object.keys(ai.files || {}).filter((p) => p.startsWith('dsh-client-ui-'));
for (const pkg of pkgs) {
  const pkgNode = ai.files[pkg];
  if (!pkgNode || !pkgNode.files) continue;
  const pkgJsonText = read(pkgNode.files['package.json']);
  if (!pkgJsonText) continue;
  let j;
  try { j = JSON.parse(pkgJsonText); } catch { continue; }
  const exp = j.exports || {};
  let rel = exp['./client'];
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

  // 匹配 <任何别名>_primitives.Member  或  require("...primitives").Member
  let m;
  const re1 = /\b\w*[Pp]rimitives\.([A-Z][A-Za-z0-9_]*)/g;
  while ((m = re1.exec(src)) !== null) {
    const name = m[1];
    if (!members.has(name)) members.set(name, new Set());
    members.get(name).add(pkg);
  }
  const re2 = /require\(\s*["']@deepseek-ai\/dsh-client-ui-primitives["']\s*\)\.([A-Z][A-Za-z0-9_]*)/g;
  while ((m = re2.exec(src)) !== null) {
    const name = m[1];
    if (!members.has(name)) members.set(name, new Set());
    members.get(name).add(pkg);
  }
}

console.log('primitives 成员数: ' + members.size);
console.log();

const icons = [];
const comps = [];
for (const [name, users] of members) {
  if (name.startsWith('Icon')) icons.push([name, users]);
  else comps.push([name, users]);
}

console.log('=== 组件 / 工具 (' + comps.length + ') ===');
for (const [name, users] of comps.sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log('  ' + name.padEnd(40) + users.size + ' 包');
}
console.log();

console.log('=== 图标 (' + icons.length + ') ===');
const names = icons.map((x) => x[0]).sort();
for (let i = 0; i < names.length; i += 2) {
  const a = names[i];
  const b = names[i + 1] || '';
  console.log('  ' + a.padEnd(44) + b);
}

fs.closeSync(fd);
