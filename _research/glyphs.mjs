import { readText } from './asar.mjs';

const t = readText(['dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets', 'index-BgUyXZcc.js']);

for (const g of ['focus-outline', 'pointer', 'target', 'crosshair', 'cursor']) {
  const needle = '"' + g + '"';
  const i = t.indexOf(needle);
  console.log(g + ' -> ' + (i < 0 ? 'NOT FOUND' : 'found at ' + i));
}

const re = /PermissionIcon[A-Za-z]+/g;
const s = new Set();
let mm;
while ((mm = re.exec(t))) s.add(mm[0]);
console.log('--- PermissionIcon exports ---');
console.log([...s].sort().join('\n'));
