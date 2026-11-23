import fs from 'node:fs';

const names = fs.readFileSync('primitives-names.txt', 'utf8').split('\n').filter(Boolean);
const isIcon = (n) =>
  /^Icon[A-Z]/.test(n) || /^PermissionIcon/.test(n) || /^ICON_/.test(n) ||
  /^LinkIcon/.test(n) || /^ReferenceIcon/.test(n);

const icons = names.filter(isIcon);
const rest = names.filter((n) => !isIcon(n));
console.log('total           = ' + names.length);
console.log('icon-ish        = ' + icons.length);
console.log('non-icon        = ' + rest.length + '  (含 __proto__ 伪条目)');
console.log('non-icon minus __proto__ = ' + rest.filter((n) => n !== '__proto__').length);
console.log('');
console.log(rest.join('\n'));
