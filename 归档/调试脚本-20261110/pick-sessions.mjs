import fs from 'node:fs';
import path from 'node:path';

const P = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\all-sessions.json`;
const all = JSON.parse(fs.readFileSync(P, 'utf8'));

// 主会话，按 createdAt 降序
const main = all.filter(s => s.origin !== 'subagent').sort((a, b) => b.createdAt - a.createdAt);

console.log('=== 最新的 20 个主会话 ===');
console.log('  ' + 'sessionId'.padEnd(46) + '创建时间'.padEnd(18) + 'cwd');
console.log('  ' + '─'.repeat(110));
for (const s of main.slice(0, 20)) {
  const t = new Date(s.createdAt).toISOString().slice(0, 16).replace('T', ' ');
  console.log('  ' + s.sessionId.padEnd(46) + t.padEnd(18) + (s.cwd || '').slice(0, 44));
}

console.log();
console.log('合计主会话:', main.length);

// 推荐：优先用 Agent自研 目录下的
const ours = main.filter(s => (s.cwd || '').includes('Agent自研'));
console.log();
console.log('=== Agent自研 目录下的主会话（推荐用这些）===');
for (const s of ours) {
  const t = new Date(s.createdAt).toISOString().slice(0, 16).replace('T', ' ');
  console.log('  ' + s.sessionId + '   ' + t + '   preset=' + (s.preset || '?'));
}
