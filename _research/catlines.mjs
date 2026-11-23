import { readText } from './asar.mjs';

const t = readText(['dsh', 'node_modules', '@deepseek-ai', 'dsh-cordis-client-runner', 'lib', 'client.js']);
const lines = t.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (/key:\s*"main",/.test(lines[i])) console.log('main entry at line ' + (i + 1));
  if (/key:\s*"sidebar\.panellist",/.test(lines[i])) console.log('sidebar.panellist entry at line ' + (i + 1));
  if (/key:\s*"sidebar\.panellist\.actions",/.test(lines[i])) console.log('sidebar.panellist.actions at line ' + (i + 1));
}
console.log('total lines = ' + lines.length);
