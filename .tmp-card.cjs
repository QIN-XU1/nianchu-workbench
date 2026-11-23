const fs = require('fs');
const r = 'D:/refs/dsh-claude-style-master/dsh-claude-style-master';
const j = JSON.parse(fs.readFileSync(r + '/packages/client/src/theme/tokens.json', 'utf8'));
const cards = j.palette.cards;
console.log('cards type:', Array.isArray(cards) ? 'array' : typeof cards);
const arr = Array.isArray(cards) ? cards : Object.values(cards);
console.log('card ids:', arr.map(c => c && c.id));
const claude = arr.find(c => c && (c.id === 'claude' || /claude/i.test(c.id || '')));
console.log('\nCLAUDE CARD:\n', JSON.stringify(claude, null, 2));
