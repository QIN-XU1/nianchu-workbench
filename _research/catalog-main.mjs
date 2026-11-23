import { readText } from './asar.mjs';

const t = readText(['dsh', 'node_modules', '@deepseek-ai', 'dsh-cordis-client-runner', 'lib', 'client.js']);
const re = /key:\s*"(main[^"]*)"/g;
const seen = new Set();
let mm;
while ((mm = re.exec(t))) seen.add(mm[1]);
console.log('keys starting with main:', [...seen].join(', ') || '(none)');
const i = t.indexOf('SLOT_CATALOG');
console.log('--- SLOT_CATALOG near ' + i + ' ---');
console.log(t.slice(Math.max(0, i - 200), i + 1200));
