const path = require('path');
const fs = require('fs');

const NM = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\node_modules`;

console.log('═══ node-pty 可用性检测 ═══');
console.log();

// ① 找 .node 文件
const ptyDir = path.join(NM, 'node-pty');
const found = [];

function walk(dir, depth) {
  if (depth > 4) return;
  let items;
  try { items = fs.readdirSync(dir); } catch (e) { return; }
  for (const it of items) {
    const full = path.join(dir, it);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (st.isDirectory()) walk(full, depth + 1);
    else if (it.endsWith('.node')) found.push(full);
  }
}

walk(ptyDir, 0);
console.log('① .node 二进制文件 (' + found.length + ' 个):');
for (const f of found) {
  const size = fs.statSync(f).size;
  console.log('   ' + path.relative(ptyDir, f) + '  (' + Math.round(size / 1024) + ' KB)');
}

// ② 尝试 require
console.log();
console.log('② 尝试 require("node-pty"):');
try {
  const pty = require(path.join(ptyDir));
  console.log('   ✓ 加载成功');
  console.log('   导出:', Object.keys(pty).join(', '));
} catch (e) {
  console.log('   ✗ 失败: ' + e.message.slice(0, 200));
}

// ③ Electron ABI 检查
console.log();
console.log('③ Electron ABI 与 node-pty 是否匹配:');
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(ptyDir, 'package.json'), 'utf8'));
  console.log('   node-pty 版本: ' + pkg.version);
} catch (e) { /* ignore */ }

// Electron 版本
const electronPkg = path.join(NM, 'electron', 'package.json');
if (fs.existsSync(electronPkg)) {
  const ej = JSON.parse(fs.readFileSync(electronPkg, 'utf8'));
  console.log('   electron 版本: ' + ej.version);
}

// ④ prebuilds 目录内容
const prebuilds = path.join(ptyDir, 'prebuilds');
if (fs.existsSync(prebuilds)) {
  console.log();
  console.log('④ prebuilds 目录:');
  for (const d of fs.readdirSync(prebuilds)) {
    console.log('   ' + d);
  }
}
