const fs = require('fs');
const r = 'D:/refs/dsh-claude-style-master/dsh-claude-style-master';
const j = JSON.parse(fs.readFileSync(r + '/packages/client/src/theme/tokens.json', 'utf8'));
console.log('top keys:', Object.keys(j).slice(0, 20));
function walk(o, path, depth) {
  if (depth > 2 || !o || typeof o !== 'object') return;
  for (const k of Object.keys(o)) {
    if (/claude|parchment|forest|dusk|rose|preset|scheme|palette/i.test(k)) console.log(path + '.' + k, Array.isArray(o[k]) ? '[array ' + o[k].length + ']' : typeof o[k]);
    walk(o[k], path + '.' + k, depth + 1);
  }
}
walk(j, '', 0);
// print first palette if found
const s = JSON.stringify(j);
console.log('contains D97757?', s.includes('D97757') || s.includes('d97757'));
