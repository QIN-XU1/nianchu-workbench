import fs from 'node:fs';
import path from 'node:path';

// 从 app.asar 里抽出 dsh 自己的源码，供 rg 检索用。
// 目的：矩阵里 DSH 那 13 个「去那儿找了但没有」的锚点，其实是因为源码在 asar 里，
// 而 rg 对 asar 只会报 "binary file matches"。解出来才能真正定位到 文件:行号。

const ASAR = 'D:/file/software/DeepSeek Harness/resources/app.asar';
const OUT = path.resolve(import.meta.dirname, '../../evidence/dsh-src');

const buf = fs.readFileSync(ASAR);
const base = 8 + buf.readUInt32LE(4);
const jsonLen = buf.readUInt32LE(12);
const header = JSON.parse(buf.toString('utf8', 16, 16 + jsonLen));

const EXTS = /\.(ts|tsx|js|mjs|cjs|json|md)$/;
const KEEP = /@deepseek-ai|dsh-/;   // 只要 dsh 自己的包
const MAX = 400 * 1024;             // 跳过超大打包产物

fs.mkdirSync(OUT, { recursive: true });
let n = 0, bytes = 0;

(function walk(node, prefix) {
  for (const [name, v] of Object.entries(node.files || {})) {
    const p = prefix + '/' + name;
    if (v.files) { walk(v, p); continue; }
    if (v.size === undefined) continue;
    if (!EXTS.test(name)) continue;
    if (v.size > MAX) continue;
    if (!KEEP.test(p)) continue;

    const rel = p.replace(/^\//, '');
    const dst = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, buf.subarray(base + Number(v.offset), base + Number(v.offset) + v.size));
    n++; bytes += v.size;
  }
})(header, '');

console.log('  解出 ' + n + ' 个文件 / ' + (Math.round(bytes / 1024 / 1024 * 10) / 10) + 'MB');
console.log('  → ' + path.relative(process.cwd(), OUT));