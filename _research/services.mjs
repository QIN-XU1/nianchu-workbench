import { walk, readBuf } from './asar.mjs';

const hits = new Set();
walk((p, node) => {
  const rel = p.join('/');
  if (!rel.startsWith('dsh/node_modules/@deepseek-ai/')) return;
  if (!/\/lib\/client\.js$/.test(rel)) return;
  if (node.size > 20 * 1024 * 1024) return;
  let s;
  try { s = readBuf(p).toString('utf8'); } catch { return; }
  const re = /\.provide\(\s*"([^"]+)"/g;
  let mm;
  while ((mm = re.exec(s))) hits.add(mm[1]);
});
console.log('client services provided (' + hits.size + '):');
console.log([...hits].sort().join(', '));
