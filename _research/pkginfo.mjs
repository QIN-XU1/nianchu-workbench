import { nodeAt } from './asar.mjs';

const pkgs = process.argv.slice(2);
for (const p of pkgs) {
  const base = ['dsh', 'node_modules', '@deepseek-ai', p];
  const node = nodeAt(base);
  console.log('=== ' + p + ' ===');
  const pj = nodeAt([...base, 'package.json']);
  const text = (await import('./asar.mjs')).readText([...base, 'package.json']);
  try {
    const j = JSON.parse(text);
    console.log(JSON.stringify({ name: j.name, version: j.version, exports: j.exports, dsh: j.dsh, main: j.main, files: j.files, type: j.type }, null, 2));
  } catch (e) {
    console.log('parse error', e.message);
  }
  console.log('--- files (depth 2) ---');
  const listDir = (pathArr, depth, prefix) => {
    const n = nodeAt(pathArr);
    for (const k of Object.keys(n.files).sort()) {
      const e = n.files[k];
      console.log(prefix + k + (e.files ? '/' : '  [' + e.size + ']'));
      if (e.files && depth > 1) listDir([...pathArr, k], depth - 1, prefix + '  ');
    }
  };
  listDir(base, 2, '');
  console.log('');
}
