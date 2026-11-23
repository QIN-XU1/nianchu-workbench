import { walk, readBuf } from './asar.mjs';

// usage: node asar-tokens.mjs <regex> [pathPrefix] [ext] [maxHitsPerFile] [before] [after]
const pattern = process.argv[2];
const prefix = process.argv[3] || 'dsh/node_modules/@deepseek-ai/';
const extFilter = process.argv[4] || '';
const maxHits = Number(process.argv[5] || 4);
const after = Number(process.argv[6] || 0);
const re = new RegExp(pattern);
const prefixArr = prefix.split('/').filter(Boolean);
const seenFiles = new Set();

walk((p, node) => {
  const rel = p.join('/');
  if (!rel.startsWith(prefix)) return;
  if (extFilter && !rel.endsWith(extFilter)) return;
  if (rel.endsWith('.map') || rel.endsWith('.d.ts')) return;
  if (node.size > 30 * 1024 * 1024) return;
  let text;
  try {
    text = readBuf(p).toString('utf8');
  } catch {
    return;
  }
  const idx = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(pattern.replace(/^\/|\/$/g, ''), from);
    if (i < 0) break;
    idx.push(i);
    from = i + 1;
    if (idx.length >= maxHits) break;
  }
  if (idx.length === 0) return;
  console.log('### ' + rel + '   (' + idx.length + ' hits)');
  for (const i of idx) {
    const before = text.lastIndexOf('\n', i);
    const start = Math.max(0, Math.max(before, i - 600));
    let end = i + 400;
    for (let k = 0; k < after; k++) {
      const nl = text.indexOf('\n', end);
      if (nl < 0) break;
      end = nl + 1;
    }
    console.log('-----');
    console.log(text.slice(start, end));
  }
}, prefixArr);
