import { readText } from './asar.mjs';

// usage: node findin.mjs <asarPath> <needle> [before] [after]
const p = process.argv[2];
const needle = process.argv[3];
const before = Number(process.argv[4] || 600);
const after = Number(process.argv[5] || 600);
const text = readText(p.split('/').filter(Boolean));
let from = 0;
let n = 0;
while (n < 12) {
  const i = text.indexOf(needle, from);
  if (i < 0) break;
  n++;
  console.log('=== hit ' + n + ' at ' + i + ' / len ' + text.length + ' ===');
  console.log(text.slice(Math.max(0, i - before), i + after));
  from = i + needle.length;
}
if (n === 0) console.log('NOT FOUND: ' + needle + ' len=' + text.length);
