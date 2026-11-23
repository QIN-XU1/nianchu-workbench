import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SESS = String.raw`C:\Users\15282\.dsh\sessions\--D-file-AI~0020Temp-DeepSeek-Agent~81EA~7814--`;

function decompressZstd(buf) {
  if (typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(buf);
  return null;
}

const dirs = fs.readdirSync(SESS).filter(d => {
  try { return fs.statSync(path.join(SESS, d)).isDirectory(); } catch { return false; }
});

// 深挖第一个会话的完整结构
const first = dirs[0];
const f = path.join(SESS, first, 'session.v4.jsonl.zstd');
const out = decompressZstd(fs.readFileSync(f));
const lines = out.toString('utf8').split('\n').filter(Boolean);

console.log('=== 会话 ' + first + ' 的结构 ===');
console.log('总行数:', lines.length);
console.log();

// 看前 5 行的完整结构
for (let i = 0; i < Math.min(5, lines.length); i++) {
  try {
    const e = JSON.parse(lines[i]);
    console.log(`--- 第 ${i + 1} 行 ---`);
    console.log('  keys:', Object.keys(e).join(', '));
    console.log('  ' + JSON.stringify(e).slice(0, 400));
    console.log();
  } catch (err) {
    console.log(`--- 第 ${i + 1} 行 解析失败 ---`);
  }
}

// 找所有 type 字段
const types = {};
for (const l of lines) {
  try {
    const e = JSON.parse(l);
    const t = e.type || e.kind || e.event || '(无)';
    types[t] = (types[t] || 0) + 1;
  } catch { /* ignore */ }
}
console.log('=== 事件类型分布 ===');
for (const [k, v] of Object.entries(types).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(30)} ${v}`);
}

// 找标题相关字段
console.log();
console.log('=== 找标题 ===');
for (const l of lines) {
  try {
    const e = JSON.parse(l);
    const s = JSON.stringify(e);
    if (/title|name|summary/i.test(s) && s.length < 500) {
      console.log('  ' + s.slice(0, 300));
      break;
    }
  } catch { /* ignore */ }
}
