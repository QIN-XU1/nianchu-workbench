import { readText } from './asar.mjs';

const t = readText(['dsh', 'node_modules', '@deepseek-ai', 'dsh-cordis-client-runner', 'lib', 'client.js']);
const re = /key:\s*"(main[^"]*)"/g;
let mm;
while ((mm = re.exec(t))) {
  const start = mm.index;
  console.log('=== ' + mm[1] + ' at ' + start + ' ===');
  console.log(t.slice(start, start + 3200));
  console.log('');
}
