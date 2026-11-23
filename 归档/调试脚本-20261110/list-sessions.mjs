import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SESS = String.raw`C:\Users\15282\.dsh\sessions\--D-file-AI~0020Temp-DeepSeek-Agent~81EA~7814--`;

// Node 24 有内置 zstd
function decompressZstd(buf) {
  try {
    if (typeof zlib.zstdDecompressSync === 'function') {
      return zlib.zstdDecompressSync(buf);
    }
  } catch (e) { /* ignore */ }
  return null;
}

const dirs = fs.readdirSync(SESS).filter(d => {
  try { return fs.statSync(path.join(SESS, d)).isDirectory(); } catch { return false; }
});

console.log('会话数:', dirs.length);
console.log();

const results = [];
for (const d of dirs) {
  const f = path.join(SESS, d, 'session.v4.jsonl.zstd');
  if (!fs.existsSync(f)) continue;
  const raw = fs.readFileSync(f);
  const out = decompressZstd(raw);
  if (!out) {
    results.push({ id: d, title: '(解压失败)', bytes: raw.length });
    continue;
  }
  const lines = out.toString('utf8').split('\n').filter(Boolean);
  let title = '';
  let firstUser = '';
  let createdAt = '';
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      // 找标题字段
      if (!title && e.title) title = e.title;
      if (!createdAt && (e.at || e.time || e.timestamp)) createdAt = e.at || e.time || e.timestamp;
      // 找第一条用户消息
      if (!firstUser) {
        const content = e.content || (e.payload && e.payload.content);
        if (content && typeof content === 'string' && content.length > 5 && content.length < 200) {
          firstUser = content.slice(0, 60);
        }
      }
    } catch { /* ignore */ }
  }
  results.push({ id: d, title: title || '(无标题)', firstUser, createdAt, bytes: out.length, lines: lines.length });
}

console.log('会话清单：');
console.log('  ' + 'ID'.padEnd(12) + '标题'.padEnd(30) + '首条消息');
console.log('  ' + '-'.repeat(90));
for (const r of results) {
  console.log('  ' + String(r.id).slice(0, 10).padEnd(12) +
    String(r.title).slice(0, 26).padEnd(30) +
    String(r.firstUser || '').slice(0, 40));
}

fs.writeFileSync(String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\sessions-list.json`,
  JSON.stringify(results, null, 2), 'utf8');
console.log();
console.log('已保存 prototype/sessions-list.json');
