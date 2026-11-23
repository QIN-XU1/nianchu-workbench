#!/usr/bin/env node
/**
 * 统计 web-ui 源码里「硬编码中文」的分布（与 i18n:audit 的 source candidate 口径接近）
 *
 * 口径：含中文字符、且不是纯注释行（// * /* {/*）
 * 用途：i18n 门禁预算为 0，需要知道剩余行落在哪些文件、属于谁写的。
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const ROOT = path.join(REPO, 'apps/vouch-web/src/web-ui/src');
const SKIP_DIR = /node_modules|[\\/]\.git|dist|build|__tests__/;
const CODE = /\.(tsx?|jsx?)$/;

const out = [];
function walk(dir, depth = 0) {
  if (depth > 14) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.test(p)) walk(p, depth + 1); continue; }
    if (!CODE.test(e.name) || /\.(test|spec)\./.test(e.name)) continue;
    let t;
    try { t = fs.readFileSync(p, 'utf8'); } catch { continue; }
    let n = 0;
    for (const ln of t.split('\n')) {
      if (!/[\u4e00-\u9fff]/.test(ln)) continue;
      const s = ln.trim();
      if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*') || s.startsWith('{/*')) continue;
      n++;
    }
    // 生成文件不算手写欠账 —— i18n:generate 的产物，机器写的不是人写的
    const rel = path.relative(ROOT, p).replace(/\\\\/g, '/');
    const generated = /generatedLocaleContract|generated.*Contract|\.generated\./.test(rel);
    if (n) out.push([n, rel, generated]);
  }
}
walk(ROOT);
out.sort((a, b) => b[0] - a[0]);
const tot = out.reduce((a, [n]) => a + n, 0);
const genTot = out.filter(([, , g]) => g).reduce((a, [n]) => a + n, 0);
const handTot = tot - genTot;

console.log('');
console.log('  web-ui 硬编码中文分布');
console.log('  ' + '='.repeat(74));
console.log('  文件数 ' + out.length + ' · 合计 ' + tot + ' 行');
console.log('');
for (const [n, f] of out.slice(0, 20)) {
  const ours = /scenes\/(vouch|benchmark)\//.test(f) ? '  ← 我们' : '';
  console.log('  ' + String(n).padStart(4) + '  ' + f + ours);
}
if (out.length > 20) console.log('  ... 还有 ' + (out.length - 20) + ' 个文件');
console.log('');
const oursTot = out.filter(([, f]) => /scenes\/(vouch|benchmark)\//.test(f)).reduce((a, [n]) => a + n, 0);
console.log('  手写欠账: ' + handTot + ' 行 · 生成产物: ' + genTot + ' 行 · 其中我们写的: ' + oursTot + ' 行');
console.log('');
