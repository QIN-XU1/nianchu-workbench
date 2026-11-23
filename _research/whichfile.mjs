import { walk, readBuf } from './asar.mjs';

const targets = ['util', 'url', 'react-dom/client', '@deepseek-ai/dsh-client-ui-dockkit', '@deepseek-ai/dsh-api-gateway/client', '@deepseek-ai/dsh-client-ui-slots', '@tanstack/react-virtual', 'zod', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store'];
const re = /require\("([^"]+)"\)/g;

walk((p, node) => {
  const rel = p.join('/');
  if (!rel.startsWith('dsh/node_modules/@deepseek-ai/')) return;
  if (!/\/(lib|dist)\/.*\.js$/.test(rel)) return;
  if (rel.endsWith('.map')) return;
  if (node.size > 20 * 1024 * 1024) return;
  let t;
  try { t = readBuf(p).toString('utf8'); } catch { return; }
  const found = new Set();
  let mm;
  re.lastIndex = 0;
  while ((mm = re.exec(t))) if (targets.includes(mm[1])) found.add(mm[1]);
  if (found.size) console.log(rel + '  ->  ' + [...found].join(', '));
});
