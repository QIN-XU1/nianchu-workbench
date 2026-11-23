// 在已抽取的 UI 文案表里按关键词检索（UTF-8 安全，输出紧凑）
//
// 用法：node research/frontend-benchmark/tools/zh-grep.mjs <outJson> <关键词...>
//
// 为什么要它：PowerShell 直接 grep 中文会因为控制台编码把关键字弄坏；
// 走 JSON + node 输出，字节原样。
import fs from 'node:fs';

const [jsonPath, ...kws] = process.argv.slice(2);
if (!jsonPath || kws.length === 0) {
  console.error('usage: node zh-grep.mjs <outJson> <keyword...>');
  process.exit(2);
}
const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const all = new Map();
for (const a of data) for (const [t, c] of a.top) all.set(t, (all.get(t) || 0) + c);
const rows = [...all.entries()];
for (const kw of kws) {
  const hit = rows
    .filter(([t]) => t.includes(kw))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14);
  console.log(`【${kw}】(${hit.length}) ` + hit.map(([t, c]) => `${t}(${c})`).join(' · '));
}
