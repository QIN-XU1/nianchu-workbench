import { readText } from './asar.mjs';

const pkgs = [
  'dsh-client-ui-plugin-manager',
  'dsh-client-ui-schedule',
  'dsh-client-ui-jobs',
  'dsh-client-ui-layout',
  'dsh-client-ui-conversation',
  'dsh-client-ui-renderer',
  'dsh-client-modules',
];

for (const p of pkgs) {
  const raw = readText(['dsh', 'node_modules', '@deepseek-ai', p, 'package.json']);
  const lines = raw.split('\n');
  const start = lines.findIndex((l) => l.trim() === '"dsh": {');
  if (start < 0) { console.log('### ' + p + ': no dsh block'); continue; }
  let depth = 0, end = start;
  for (let i = start; i < lines.length; i++) {
    for (const c of lines[i]) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    if (depth === 0) { end = i; break; }
  }
  console.log('### ' + p + '  (package.json lines ' + (start + 1) + '-' + (end + 1) + ')');
  console.log(lines.slice(start, end + 1).join('\n'));
  console.log('');
}
