import { readText } from './asar.mjs';

const t = readText(['dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets', 'index-BgUyXZcc.js']);
const nl = (i) => t.slice(0, i).split('\n').length;

const marks = {
  'SlotCore class (var OI=class)': 'var OI=class',
  'register options assembly (const l={component:t)': 'const l={component:t',
  'kind sort': 'u.sort(i.kind==="list"',
  'entriesOfSlot': 'entriesOfSlot(e){',
  'parseDshClient-free: YZ seed': 'function YZ()',
  'const FU=Object.freeze': 'const FU=Object.freeze',
  'const WZ=Object.freeze': 'const WZ=Object.freeze',
  'const MI=Object.freeze': 'const MI=Object.freeze',
  'function EI(': 'function EI(',
  'function II(': 'function II(',
  'function hi(': 'function hi(',
  'const vi=k.forwardRef': 'vi=k.forwardRef',
  'function $4(': 'function $4(',
  'function Mn(': 'function Mn(',
  'function WD(': 'function WD(',
  'function wy(': 'function wy(',
};
for (const [k, n] of Object.entries(marks)) {
  const i = t.indexOf(n);
  console.log(k.padEnd(52) + ' -> ' + (i < 0 ? 'NOT FOUND' : 'line ' + nl(i)));
}
