
const fs = require('fs');
const OUT = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\_probe-result.txt`;

const lines = [];
lines.push('execPath=' + process.execPath);
lines.push('argv=' + JSON.stringify(process.argv.slice(0, 3)));
lines.push('ELECTRON_RUN_AS_NODE=' + (process.env.ELECTRON_RUN_AS_NODE || '(unset)'));
lines.push('stdin.isTTY=' + process.stdin.isTTY);
lines.push('stdin.setRawMode=' + typeof process.stdin.setRawMode);
lines.push('stdin.fd=' + process.stdin.fd);
lines.push('stdout.isTTY=' + process.stdout.isTTY);
lines.push('stdout.columns=' + process.stdout.columns);
lines.push('stdout.rows=' + process.stdout.rows);
if (typeof process.stdin.setRawMode === 'function') {
  try {
    process.stdin.setRawMode(true);
    lines.push('setRawMode(true)=OK');
    process.stdin.setRawMode(false);
    lines.push('setRawMode(false)=OK');
  } catch (e) {
    lines.push('setRawMode=ERROR ' + e.message);
  }
} else {
  lines.push('setRawMode=MISSING');
}
fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
process.exit(0);
