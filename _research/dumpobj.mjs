import { readText } from './asar.mjs';

const p = process.argv[2];
const startNeedle = process.argv[3];
const text = readText(p.split('/').filter(Boolean));
const i = text.indexOf(startNeedle);
if (i < 0) throw new Error('not found');
// find the end of the freeze object literal by bracket matching from the "{" after "Object.freeze(Object.defineProperty({"
let j = text.indexOf('{', i);
let depth = 0;
let end = -1;
for (let k = j; k < text.length; k++) {
  const c = text[k];
  if (c === '{') depth++;
  else if (c === '}') {
    depth--;
    if (depth === 0) { end = k; break; }
  }
}
console.log('LEN=' + (end - i));
console.log(text.slice(i, end + 200));
