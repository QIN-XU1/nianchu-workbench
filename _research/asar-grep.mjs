import { walk, readBuf, readText, nodeAt } from './asar.mjs';

// usage: node asar-grep.mjs <regex> [pathPrefix] [ext]
const pattern = process.argv[2];
const prefix = process.argv[3] || 'dsh/node_modules/@deepseek-ai/';
const extFilter = process.argv[4];
const re = new RegExp(pattern);
const prefixArr = prefix.split('/').filter(Boolean);
let count = 0;
walk((p, node) => {
  const rel = p.join('/');
  if (!rel.startsWith(prefix)) return;
  if (extFilter && !rel.endsWith(extFilter)) return;
  if (node.size > 40 * 1024 * 1024) return;
  let text;
  try {
    text = readBuf(p).toString('utf8');
  } catch {
    return;
  }
  if (rel.endsWith('.map')) return;
  if (!re.test(text)) return;
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) hits.push(i + 1 + ': ' + lines[i].slice(0, 400));
    if (hits.length >= 6) break;
  }
  if (hits.length === 0) return; // binary or single-line minified
  count++;
  console.log('### ' + rel);
  console.log(hits.join('\n'));
}, prefixArr);

console.log('files matched: ' + count);