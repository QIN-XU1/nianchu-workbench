import { readText } from './asar.mjs';

const t = readText(['dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets', 'index-BgUyXZcc.js']);

function show(label, re, max = 2, before = 200, after = 1200) {
  console.log('##### ' + label);
  let c = 0;
  let mm;
  re.lastIndex = 0;
  while ((mm = re.exec(t)) && c < max) {
    const i = mm.index;
    console.log('--- at ' + i + ' ---');
    console.log(t.slice(Math.max(0, i - before), i + after));
    c++;
  }
  if (c === 0) console.log('NOT FOUND');
  console.log('');
}

show('Button (vi)', /\bconst vi=/, 1, 100, 2600);
show('Menu ($4)', /\bconst \$4=/, 1, 100, 1800);
show('Tooltip (Mn)', /\bconst Mn=/, 1, 100, 1400);
