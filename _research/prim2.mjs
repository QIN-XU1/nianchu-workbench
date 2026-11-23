import { readText } from './asar.mjs';

const t = readText(['dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets', 'index-BgUyXZcc.js']);

function findDef(name) {
  const pats = [
    new RegExp('function ' + name + '\\('),
    new RegExp(name + '\\s*=\\s*(?:k\\.)?(?:forwardRef|memo)\\('),
    new RegExp('const ' + name + '\\s*='),
    new RegExp('var ' + name + '\\s*='),
  ];
  for (const re of pats) {
    const i = t.search(re);
    if (i >= 0) return i;
  }
  return -1;
}

for (const name of ['Mn', '$4', 'S4', 'wy', 'YD', 'nR', 'eR', 'I4', 'WD', 'G1', 'iR']) {
  const i = findDef(name);
  if (i < 0) { console.log(name + ': NOT FOUND'); continue; }
  console.log('=== ' + name + ' at ' + i + ' ===');
  console.log(t.slice(i, i + 900).replace(/\n/g, ' '));
  console.log('');
}
