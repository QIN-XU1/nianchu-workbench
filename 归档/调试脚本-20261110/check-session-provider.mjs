import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SID = process.argv[2] || '';
const SESS_ROOT = path.join(process.env.USERPROFILE || 'C:\\Users\\15282', '.dsh', 'sessions');

function find(sid) {
  for (const ws of fs.readdirSync(SESS_ROOT)) {
    const f = path.join(SESS_ROOT, ws, sid, 'session.v4.jsonl.zstd');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

const f = find(SID);
if (!f) { console.log('未找到'); process.exit(1); }

const buf = fs.readFileSync(f);
const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
let off = 0;
const frames = [];
while (off < buf.length) {
  const next = buf.indexOf(MAGIC, off + 1);
  const end = next < 0 ? buf.length : next;
  try { frames.push(zlib.zstdDecompressSync(buf.subarray(off, end))); } catch { /* ignore */ }
  if (next < 0) break;
  off = next;
}
const full = Buffer.concat(frames).toString('utf8');
const events = full.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

console.log('=== 关键字段提取 ===');
console.log();

// 找 provider / model
function findKeys(obj, wanted, acc, depth = 0, trail = '') {
  if (depth > 10) return;
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      const p = trail ? trail + '.' + k : k;
      if (wanted.includes(k)) acc.push({ key: p, val: typeof v === 'string' ? v : JSON.stringify(v).slice(0, 80) });
      findKeys(v, wanted, acc, depth + 1, p);
    }
  } else if (Array.isArray(obj)) {
    for (const v of obj) findKeys(v, wanted, acc, depth + 1, trail);
  }
}

const acc = [];
for (const e of events) findKeys(e, ['provider', 'model', 'providerName', 'modelId'], acc);

console.log('provider / model 字段:');
const seen = new Set();
for (const a of acc) {
  const line = a.key + ' = ' + a.val;
  if (seen.has(line)) continue;
  seen.add(line);
  console.log('  ' + line);
}

console.log();
console.log('=== 助手消息 ===');
for (const e of events) {
  if (e.type === 'assistant/message') {
    console.log('  ' + JSON.stringify(e).slice(0, 400));
  }
}

console.log();
console.log('=== 是否有错误 ===');
const txt = full;
console.log('  QUOTA: ' + /额度已用尽|ACCOUNT_QUOTA/.test(txt));
console.log('  error: ' + /"type":"error"|turnError/.test(txt));
