#!/usr/bin/env node
/**
 * 提取已发布插件的真实实现细节
 *
 * 目标：学习顶尖做法
 *   ① 侧边栏图标组件（PluginsPanelIcon / TaskManagerIcon）怎么写的
 *   ② 主面板（TaskManagerPage）的结构与样式
 *   ③ 它们如何用 theme token / locale / primitives
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
  if (!pkgNode) return null;
  const pkgJsonText = read(pkgNode.files['package.json']);
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

const OUT_DIR = process.argv[2] || '.';
const MARKS = [
  ['dsh-client-ui-plugin-manager', 'PluginsPanelIcon'],
  ['dsh-client-ui-schedule', 'TaskManagerIcon'],
  ['dsh-client-ui-jobs', 'JobsPanelIcon'],
];

for (const [pkg, compName] of MARKS) {
  const src = getClientSrc(pkg);
  if (!src) { console.log('✗ ' + pkg); continue; }

  console.log('='.repeat(76));
  console.log('  ' + pkg + ' :: ' + compName);
  console.log('='.repeat(76));
  console.log();

  // 找组件定义（容忍签名的换行）
  const re = new RegExp('function ' + compName + '\\s*\\(');
  const m = src.match(re);
  if (m) {
    const start = m.index;
    // 从函数体第一个 { 开始平衡括号（跳过参数里的默认值）
    let i = src.indexOf(')', start);
    let braceStart = src.indexOf('{', i);
    let depth = 0;
    let end = braceStart;
    for (; end < src.length; end++) {
      if (src[end] === '{') depth++;
      else if (src[end] === '}') { depth--; if (depth === 0) break; }
    }
    const body = src.slice(start, end + 1);
    console.log('长度: ' + body.length + ' B');
    console.log();
    console.log(body);
    console.log();
  } else {
    // 可能是箭头函数或别名
    const idx = src.indexOf(compName);
    if (idx >= 0) {
      console.log('（未匹配 function 定义，附近代码）');
      console.log(src.slice(Math.max(0, idx - 200), idx + 600).replace(/\s+/g, ' '));
      console.log();
    } else {
      console.log('（找不到该组件）');
      console.log();
    }
  }
}

fs.closeSync(fd);
