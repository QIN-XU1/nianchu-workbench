import { readText } from './asar.mjs';

const p = process.argv[2];
const needles = process.argv.slice(3);
const text = readText(p.split('/').filter(Boolean));
for (const n of needles) {
  let f = 0, c = 0;
  console.log('##### ' + n);
  while (c < 3) {
    const i = text.indexOf(n, f);
    if (i < 0) break;
    console.log('  hit ' + i + ': ' + text.slice(Math.max(0, i - 300), i + 400).replace(/\n/g, ' '));
    f = i + 1;
    c++;
  }
  if (c === 0) console.log('  NOT FOUND');
}
