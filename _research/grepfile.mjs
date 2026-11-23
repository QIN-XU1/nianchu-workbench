import { readText } from './asar.mjs';

// usage: node grepfile.mjs <asarPath> <regexSubstring> [contextChars] [maxHits]
const p = process.argv[2];
const needle = process.argv[3];
const ctx = Number(process.argv[4] || 500);
const maxHits = Number(process.argv[5] || 10);
const text = readText(p.split('/').filter(Boolean));
const lines = text.split('\n');
let n = 0;
let i = 0;
while (i < lines.length && n < maxHits) {
  if (lines[i].includes(needle)) {
    n++;
    console.log('--- line ' + (i + 1) + ' ---');
    console.log(lines.slice(i, Math.min(lines.length, i + 25)).join('\n').slice(0, ctx * 4));
  }
  i++;
}
console.log('TOTAL_LINES=' + lines.length + '  hits=' + n);
