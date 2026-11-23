import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SID = process.argv[2] || '';
const SESS_ROOT = path.join(process.env.USERPROFILE || 'C:\\Users\\15282', '.dsh', 'sessions');

function find(sid) {
  for (const ws of fs.readdirSync(SESS_ROOT)) {
    const d = path.join(SESS_ROOT, ws, sid);
    const f = path.join(d, 'session.v4.jsonl.zstd');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

const f = find(SID);
if (!f) { console.log('未找到会话文件'); process.exit(1); }
console.log('文件: ' + f);
console.log('大小: ' + (fs.statSync(f).size / 1024).toFixed(1) + ' KB');
console.log();

const buf = fs.readFileSync(f);

// ═══ 多帧 zstd 需要逐帧解压 ═══
// zstd 帧头魔数：0x28 0xB5 0x2F 0xFD
const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);

let offset = 0;
const frames = [];
while (offset < buf.length) {
  // 找下一个帧头
  const next = buf.indexOf(MAGIC, offset + 1);
  const end = next < 0 ? buf.length : next;
  const chunk = buf.subarray(offset, end);
  try {
    const out = zlib.zstdDecompressSync(chunk);
    frames.push(out);
  } catch (e) {
    // 可能是尾部垃圾
  }
  offset = end;
  if (next < 0) break;
}

console.log('解压帧数: ' + frames.length);
const full = Buffer.concat(frames).toString('utf8');
const lines = full.split('\n').filter(Boolean);
console.log('总行数: ' + lines.length);
console.log();

const events = [];
for (const l of lines) {
  try { events.push(JSON.parse(l)); } catch { /* ignore */ }
}

console.log('事件类型:');
const types = {};
for (const e of events) types[e.type || '?'] = (types[e.type || '?'] || 0) + 1;
for (const [k, v] of Object.entries(types).sort((a, b) => b[1] - a[1])) {
  console.log('  ' + k.padEnd(30) + v);
}
console.log();

// 收集所有文本
function collect(obj, acc, depth = 0) {
  if (depth > 10) return;
  if (typeof obj === 'string') { if (obj.length > 1) acc.push(obj); return; }
  if (Array.isArray(obj)) { for (const v of obj) collect(v, acc, depth + 1); return; }
  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) collect(v, acc, depth + 1);
  }
}
const texts = [];
for (const e of events) collect(e, texts);

console.log('文本片段: ' + texts.length);
console.log();

const EXPECT = '38643948';
const hasAnswer = texts.some(t => t.includes(EXPECT));
const hasQuota = texts.some(t => /额度已用尽|ACCOUNT_QUOTA/.test(t));

console.log('═══ 判定 ═══');
console.log('  出现答案 ' + EXPECT + ' : ' + hasAnswer);
console.log('  出现 QUOTA              : ' + hasQuota);
console.log();

// 打印最近的几条非元信息文本
console.log('最近文本:');
const interesting = texts.filter(t => t.length > 5 && !t.startsWith('session-') && t.length < 500).slice(-12);
for (const t of interesting) {
  console.log('  "' + t.replace(/\n/g, ' ').slice(0, 140) + '"');
}
