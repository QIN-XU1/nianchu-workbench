import { readText } from './asar.mjs';

const t = readText(['dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets', 'index-BgUyXZcc.js']);

const names = ['$4', 'Mn', 'C2', 'sA', 'la', 'Cu', 'cA', 'rA', 'GD'];
for (const n of names) {
  const escaped = n.replace(/\$/g, '\\$');
  const re = new RegExp(escaped + '\\s*=\\s*');
  const i = t.search(re);
  console.log('=== ' + n + ' ' + (i < 0 ? 'NOT FOUND' : 'at ' + i) + ' ===');
  if (i >= 0) console.log(t.slice(i, i + 700).replace(/\n/g, ' '));
  console.log('');
}
