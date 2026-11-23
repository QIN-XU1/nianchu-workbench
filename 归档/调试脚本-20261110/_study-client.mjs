import { readFileSync } from 'node:fs';

const P = 'C:/Users/15282/.dsh/profiles/desktop/node_modules/dsh-claude-style/lib/client.js';
const src = readFileSync(P, 'utf8');

console.log('文件大小: ' + src.length + ' B');
console.log();

// 找 slots.register 用法
const re = /slots\.register\s*\(\s*\{/g;
let m;
let count = 0;
while ((m = re.exec(src)) !== null && count < 6) {
  const start = Math.max(0, m.index - 80);
  const end = Math.min(src.length, m.index + 320);
  console.log('--- 第 ' + (count + 1) + ' 处 (offset ' + m.index + ') ---');
  console.log(src.slice(start, end).replace(/\n/g, ' ').replace(/\s+/g, ' '));
  console.log();
  count++;
}

console.log('slots.register 共 ' + (src.match(/slots\.register/g) || []).length + ' 处');
console.log('slots.inject 共 ' + (src.match(/slots\.inject/g) || []).length + ' 处');
console.log();

// 找 sidebar.panellist
const idx = src.indexOf('sidebar.panellist');
if (idx >= 0) {
  console.log('=== sidebar.panellist 上下文 ===');
  console.log(src.slice(Math.max(0, idx - 500), idx + 500).replace(/\s+/g, ' '));
  console.log();
} else {
  console.log('没有 sidebar.panellist');
}

// 找 main
const idx2 = src.indexOf('"main"');
if (idx2 >= 0) {
  console.log('=== "main" 上下文 ===');
  console.log(src.slice(Math.max(0, idx2 - 400), idx2 + 400).replace(/\s+/g, ' '));
}
