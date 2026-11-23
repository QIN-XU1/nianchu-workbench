import { readText } from './asar.mjs';
import fs from 'node:fs';

const t = readText(['dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets', 'index-BgUyXZcc.js']);
const start = t.indexOf('const FU=Object.freeze(');
let j = t.indexOf('{', start);
let depth = 0, end = -1;
for (let k = j; k < t.length; k++) {
  const c = t[k];
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { end = k; break; } }
}
const body = t.slice(j + 1, end);
// split top-level commas
const parts = [];
let d = 0, cur = '', inStr = null;
for (let k = 0; k < body.length; k++) {
  const c = body[k];
  if (inStr) { cur += c; if (c === inStr && body[k - 1] !== '\\') inStr = null; continue; }
  if (c === '"' || c === "'") { inStr = c; cur += c; continue; }
  if (c === '{' || c === '[' || c === '(') d++;
  if (c === '}' || c === ']' || c === ')') d--;
  if (c === ',' && d === 0) { parts.push(cur); cur = ''; continue; }
  cur += c;
}
if (cur.trim()) parts.push(cur);
const names = parts.map((p) => p.split(':')[0].trim()).filter(Boolean);

const icons = names.filter((n) => /^Icon[A-Z]/.test(n) || /^PermissionIcon/.test(n));
const rest = names.filter((n) => !(/^Icon[A-Z]/.test(n) || /^PermissionIcon/.test(n)));

fs.writeFileSync('primitives-names.txt', names.join('\n'), 'utf8');
console.log('TOTAL EXPORTS: ' + names.length);
console.log('ICON-LIKE: ' + icons.length);
console.log('OTHER: ' + rest.length);
console.log('');
console.log('=== NON-ICON EXPORTS ===');
console.log(rest.join('\n'));
console.log('');
console.log('=== ICON EXPORT COUNT BY FAMILY ===');
const fam = new Map();
for (const n of icons) {
  const m = n.match(/^Icon(.+?)(Outline)?(Fill)?(Regular|Medium)$/) || n.match(/^PermissionIcon(.+?)(Regular|Medium)$/);
  const key = m ? m[1] : n;
  fam.set(key, (fam.get(key) || 0) + 1);
}
console.log([...fam.keys()].sort().join(', '));
