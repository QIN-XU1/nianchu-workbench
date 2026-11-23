const fs = require('fs');
const r = 'D:/refs/dsh-claude-style-master/dsh-claude-style-master';
const j = JSON.parse(fs.readFileSync(r + '/packages/client/src/theme/tokens.json', 'utf8'));
const p = j.palette;
console.log('palette keys:', Object.keys(p));
for (const k of Object.keys(p)) {
  const v = p[k];
  if (v && typeof v === 'object' && !Array.isArray(v)) console.log(k, '->', Object.keys(v).slice(0, 12));
}
console.log('\n--- claude preset ---');
const cl = p.presets && p.presets.claude ? p.presets.claude : (p.claude || null);
console.log(JSON.stringify(cl, null, 2).slice(0, 2000));
