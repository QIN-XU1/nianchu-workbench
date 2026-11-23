import fs from 'node:fs';

const names = fs.readFileSync('primitives-names.txt', 'utf8').split('\n').filter(Boolean);
const iconComp = names.filter((n) => /^Icon[A-Z]/.test(n));
const iconConst = names.filter((n) => /^ICON_/.test(n));
const linkIcon = names.filter((n) => /LinkIcon/.test(n));
const refIcon = names.filter((n) => /ReferenceIcon/.test(n));
const perm = names.filter((n) => /^PermissionIcon/.test(n));

console.log('total exports        = ' + names.length);
console.log('^Icon[A-Z]* (comps)  = ' + iconComp.length);
console.log('^ICON_* (constants)  = ' + iconConst.length + '  ' + iconConst.join(', '));
console.log('LinkIcon*            = ' + linkIcon.length + '  ' + linkIcon.join(', '));
console.log('ReferenceIcon*       = ' + refIcon.length + '  ' + refIcon.join(', '));
console.log('PermissionIcon*      = ' + perm.length);
console.log('all icon-ish         = ' + (iconComp.length + iconConst.length + linkIcon.length + refIcon.length + perm.length));

// glyph families from Icon* components
const fam = new Map();
for (const n of iconComp) {
  const body = n.slice(4)
    .replace(/Outline(Medium|Regular)$/, '')
    .replace(/(Medium|Regular)$/, '');
  fam.set(body, (fam.get(body) || 0) + 1);
}
console.log('distinct glyph families (Icon* comps) = ' + fam.size);
console.log([...fam.keys()].sort().join(', '));
