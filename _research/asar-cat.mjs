import { readText } from './asar.mjs';
import fs from 'node:fs';

// usage: node asar-cat.mjs <dotted-or-slash path under asar root> [startLine] [numLines]
const p = process.argv[2];
const startLine = Number(process.argv[3] || 1);
const numLines = Number(process.argv[4] || 400);
const arr = p.split('/').filter(Boolean);
const text = readText(arr);
const lines = text.split('\n');
const out = [];
for (let i = startLine - 1; i < Math.min(lines.length, startLine - 1 + numLines); i++) {
  out.push(String(i + 1).padStart(6) + '  ' + lines[i]);
}
console.log('TOTAL_LINES=' + lines.length);
console.log(out.join('\n'));
