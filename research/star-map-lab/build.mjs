/**
 * 把真实场景数据 + 组件打包成可直接在浏览器打开的 HTML，
 * 然后由 Edge 无头截图做像素级验证。
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';

const ROOT = path.resolve(process.cwd(), '..', '..');
const boardDir = path.join(ROOT, 'workbench', 'sceneboard', 'scenes');
const scenDir = path.join(ROOT, 'workbench', '外壳', 'scenarios');

const ids = fs
  .readdirSync(boardDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

const nodes = [];
const edges = [];
for (const id of ids) {
  const c = JSON.parse(fs.readFileSync(path.join(boardDir, id + '.json'), 'utf8'));
  const s = JSON.parse(fs.readFileSync(path.join(scenDir, id + '.json'), 'utf8'));
  nodes.push({
    id,
    name: s.name || c.name || id,
    role: c.role || s.description || '',
    panels: (s.panels || []).length,
    hasContract: true,
    memBytes: 0,
  });
  for (const o of c.outputs || []) {
    for (const to of o.to || []) {
      if (!ids.includes(to) || to === id) continue;
      edges.push({ from: id, to, kind: 'flow', label: o.name || '' });
    }
  }
}
// 去重
const seen = new Set();
const uniq = edges.filter((e) => {
  const k = e.from + '>' + e.to;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

fs.writeFileSync(path.join(ROOT, 'research/star-map-lab/data.json'), JSON.stringify({ nodes, edges: uniq }, null, 2));

buildSync({
  entryPoints: [path.join(ROOT, 'research/star-map-lab/entry.jsx')],
  bundle: true,
  format: 'iife',
  outfile: path.join(ROOT, 'research/star-map-lab/bundle.js'),
  loader: { '.js': 'jsx', '.jsx': 'jsx' },
  jsx: 'transform',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});

const tpl = fs.readFileSync(path.join(ROOT, 'research/star-map-lab/index.template.html'), 'utf8');
const bundleJs = fs.readFileSync(path.join(ROOT, 'research/star-map-lab/bundle.js'), 'utf8');
fs.writeFileSync(
  path.join(ROOT, 'research/star-map-lab/index.html'),
  tpl
    .replace('__DATA_JSON__', JSON.stringify({ nodes, edges: uniq }))
    // 用函数替换：字符串里的 $& / $' 会被当成替换模式，必须避开
    .replace('<script src="./bundle.js"></script>', () => '<script>\n' + bundleJs + '\n</script>'),
);

console.log('nodes', nodes.length, 'edges', uniq.length);
