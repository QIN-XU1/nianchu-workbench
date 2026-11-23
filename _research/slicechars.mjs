import { readText } from './asar.mjs';
import fs from 'node:fs';

// usage: node slicechars.mjs <asarPath> <start> <end> <outFile>
const p = process.argv[2];
const start = Number(process.argv[3]);
const end = Number(process.argv[4]);
const out = process.argv[5];
const text = readText(p.split('/').filter(Boolean));
const chunk = text.slice(start, end);
// pretty-ish: insert newline after ; and { } to make it readable
const pretty = chunk.replace(/([;{}])/g, '$1\n');
fs.writeFileSync(out, pretty, 'utf8');
console.log('wrote ' + pretty.length + ' chars to ' + out);
