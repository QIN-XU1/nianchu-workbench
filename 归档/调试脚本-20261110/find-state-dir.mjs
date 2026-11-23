import fs from 'node:fs';
import path from 'path';
import os from 'os';

const PKG = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\引擎数据\.dsh-tui\profiles\dsh-tui\node_modules\@deepseek-harness-tui\dsh-tui`;

console.log('═══ 找 .dsh-tui 目录的路径逻辑 ═══');
console.log();

function walk(dir, depth) {
  if (depth > 3) return;
  let items;
  try { items = fs.readdirSync(dir); } catch (e) { return; }
  for (const it of items) {
    const full = path.join(dir, it);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (st.isDirectory()) { walk(full, depth + 1); continue; }
    if (!it.endsWith('.js') && !it.endsWith('.mjs')) continue;
    if (st.size > 2 * 1024 * 1024) continue;

    try {
      const t = fs.readFileSync(full, 'utf8');
      if (t.includes('session-mounts') || t.includes('.dsh-tui')) {
        console.log('★ ' + path.relative(PKG, full));
        const lines = t.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          if (l.includes('session-mounts') || l.includes('.dsh-tui') || l.includes('STATE_DIR') || l.includes('stateDir')) {
            if (i < 400) console.log('   ' + (i + 1) + ': ' + l.trim().slice(0, 120));
          }
        }
        console.log();
      }
    } catch (e) { /* ignore */ }
  }
}

walk(PKG, 0);

console.log();
console.log('═══ 找可覆盖的环境变量名 ═══');
const envHints = [];
function walk2(dir, depth) {
  if (depth > 3) return;
  let items;
  try { items = fs.readdirSync(dir); } catch (e) { return; }
  for (const it of items) {
    const full = path.join(dir, it);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (st.isDirectory()) { walk2(full, depth + 1); continue; }
    if (!it.endsWith('.js') && !it.endsWith('.mjs')) continue;
    if (st.size > 2 * 1024 * 1024) continue;
    try {
      const t = fs.readFileSync(full, 'utf8');
      const m = t.match(/DSH_TUI_[A-Z_]+/g);
      if (m) envHints.push(...m);
    } catch (e) { /* ignore */ }
  }
}
walk2(PKG, 0);
const uniq = [...new Set(envHints)].sort();
console.log('  DSH_TUI_* 环境变量:');
for (const v of uniq) console.log('    ' + v);
