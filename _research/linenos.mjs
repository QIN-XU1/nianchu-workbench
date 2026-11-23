import { readText } from './asar.mjs';

const t = readText(['dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets', 'index-BgUyXZcc.js']);
const nl = (i) => t.slice(0, i).split('\n').length;

console.log('FU (primitives export object) line = ' + nl(t.indexOf('const FU=Object.freeze')));
console.log('YZ (PLATFORM_MODULES seed)   line = ' + nl(t.indexOf('function YZ()')));
console.log('WZ (dockkit export object)   line = ' + nl(t.indexOf('const WZ=Object.freeze')));
console.log('MI (ui-slots export object)  line = ' + nl(t.indexOf('const MI=Object.freeze')));
console.log('SlotCore class (OI)          line = ' + nl(t.indexOf('var OI=class')));
console.log('resolveSlotLabel (EI)        line = ' + nl(t.indexOf('function EI(')));
console.log('Button (vi)                  line = ' + nl(t.indexOf('vi=k.forwardRef')));
console.log('Menu ($4)                    line = ' + nl(t.indexOf('function $4(')));
console.log('Tooltip (Mn)                 line = ' + nl(t.indexOf('function Mn(')));
console.log('installIconSprite caller check:');
const ci = t.indexOf('installIconSprite');
console.log('  first mention at char ' + ci + ' line ' + nl(ci));
