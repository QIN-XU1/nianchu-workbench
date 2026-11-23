import { walk, readBuf } from './asar.mjs';

const counts = new Map();
const perFile = [];
const re = /require\("([^"]+)"\)/g;

walk((p, node) => {
  const rel = p.join('/');
  if (!rel.startsWith('dsh/node_modules/@deepseek-ai/')) return;
  if (!/\/lib\/(client|client\.[a-z0-9]+)\.js$/.test(rel)) return;
  if (node.size > 20 * 1024 * 1024) return;
  let t;
  try { t = readBuf(p).toString('utf8'); } catch { return; }
  const local = new Set();
  let mm;
  re.lastIndex = 0;
  while ((mm = re.exec(t))) {
    counts.set(mm[1], (counts.get(mm[1]) || 0) + 1);
    local.add(mm[1]);
  }
  perFile.push([rel, [...local].join(' ')]);
});

const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
console.log('=== require specifier histogram (built-in client bundles) ===');
for (const [k, v] of rows) console.log(String(v).padStart(4) + '  ' + k);
console.log('');
console.log('=== files that require primitives ===');
for (const [f, l] of perFile) if (l.includes('primitives')) console.log(f + '   -> ' + l);
