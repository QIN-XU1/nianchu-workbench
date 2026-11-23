import { readText } from './asar.mjs';

const t = readText(['dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets', 'index-BgUyXZcc.js']);

for (const id of ['LP', 'mD', 'cN', 'lN']) {
  const re = new RegExp('\\b' + id + '\\s*=\\s*M\\(');
  const mm = t.match(re);
  if (mm) {
    console.log(id + ' -> ' + t.slice(mm.index, mm.index + 90));
  } else {
    console.log(id + ' -> pattern miss; searching plain occurrence');
    const i = t.indexOf(id + '=');
    console.log('   ' + (i >= 0 ? t.slice(i, i + 90) : 'none'));
  }
}
const qi = t.indexOf('"sparkle-outline"');
console.log('--- sparkle glyph record ---');
console.log(t.slice(Math.max(0, qi - 40), qi + 400));
const wi = t.indexOf('"workspace-tree-outline"');
console.log('--- workspace-tree glyph record ---');
console.log(t.slice(Math.max(0, wi - 40), wi + 400));
