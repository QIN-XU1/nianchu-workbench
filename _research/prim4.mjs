import { readText } from './asar.mjs';

const t = readText(['dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets', 'index-BgUyXZcc.js']);

// Locate the export object and map name -> minified identifier
const start = t.indexOf('const FU=Object.freeze(');
let j = t.indexOf('{', start);
let depth = 0, end = -1;
for (let k = j; k < t.length; k++) {
  const c = t[k];
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { end = k; break; } }
}
const body = t.slice(j + 1, end);
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
const map = new Map();
for (const p of parts) {
  const idx = p.indexOf(':');
  if (idx < 0) continue;
  const name = p.slice(0, idx).trim();
  const id = p.slice(idx + 1).trim();
  if (/^[A-Za-z_$][\w$]*$/.test(id)) map.set(name, id);
}

for (const name of ['Menu', 'Tooltip', 'Button', 'Modal', 'MenuItemButton', 'Pill', 'Tag', 'Switch', 'Checkbox', 'Input', 'SegmentedControl', 'StateDot', 'DisclosureRow', 'HoverCard']) {
  const id = map.get(name);
  if (id === undefined) { console.log('== ' + name + ': (no identifier)'); continue; }
  const esc = id.replace(/\$/g, '\\$');
  let found = -1;
  for (const pat of [new RegExp('function ' + esc + '\\('), new RegExp(esc + '\\s*=\\s*k\\.'), new RegExp(esc + '\\s*=\\s*')]) {
    const i = t.search(pat);
    if (i >= 0) { found = i; break; }
  }
  console.log('== ' + name + ' -> ' + id + ' @ ' + found);
  if (found >= 0) console.log('   ' + t.slice(found, found + 600).replace(/\n/g, ' '));
  console.log('');
}
