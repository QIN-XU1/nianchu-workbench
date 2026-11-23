import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const src = fs.readFileSync('prototype/agent-ui/workbench-v0.html', 'utf8');
const outDir = 'C:/temp/v0';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const variants = [
  { name: 'dark',    html: src },
  { name: 'light',   html: src.replace('data-theme="dark" data-density="normal"', 'data-theme="light" data-density="normal"') },
  { name: 'compact', html: src.replace('data-theme="dark" data-density="normal"', 'data-theme="dark" data-density="compact"') },
];

for (const v of variants) {
  const file = outDir + '/idx-' + v.name + '.html';
  fs.writeFileSync(file, v.html, 'utf8');
  const png = outDir + '/v0-' + v.name + '.png';
  try {
    execFileSync(edge, [
      '--headless', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
      '--force-device-scale-factor=1',
      '--user-data-dir=' + process.env.TEMP + '\\edge-' + v.name,
      '--window-size=1600,1040',
      '--screenshot=' + png,
      'file:///' + file.replace(/\\/g, '/'),
    ], { stdio: 'ignore', timeout: 60000 });
  } catch (e) { /* Edge 非零退出是常态 */ }
  const ok = fs.existsSync(png);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + v.name.padEnd(8) + (ok ? Math.round(fs.statSync(png).size / 1024) + 'KB' : '失败'));
}
