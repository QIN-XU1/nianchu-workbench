/**
 * 网关验证 v2 —— 直接从会话存储文件读取结果（不依赖界面显示）
 *
 * 会话存储：<DSH_HOME>/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd
 * 用 zstd 解压后读 JSONL，找 assistant 消息
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SESS_ROOT = path.join(process.env.USERPROFILE || 'C:\\Users\\15282', '.dsh', 'sessions');
const SID = process.argv[2] || '';

function zstd(buf) {
  if (typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(buf);
  return null;
}

// 递归找 sessionId 目录
function findSession(sid) {
  for (const ws of fs.readdirSync(SESS_ROOT)) {
    const wsDir = path.join(SESS_ROOT, ws);
    try { if (!fs.statSync(wsDir).isDirectory()) continue; } catch { continue; }
    const sd = path.join(wsDir, sid);
    if (fs.existsSync(sd)) {
      const f = path.join(sd, 'session.v4.jsonl.zstd');
      if (fs.existsSync(f)) return { ws, dir: sd, file: f };
    }
  }
  return null;
}

if (!SID) {
  console.log('用法: node gateway-proof2.mjs <sessionId>');
  process.exit(1);
}

const found = findSession(SID);
console.log('=== 找会话文件 ===');
console.log('  ' + (found ? found.file : '未找到'));
if (!found) process.exit(1);

const raw = fs.readFileSync(found.file);
const out = zstd(raw);
if (!out) { console.log('  zstd 解压失败'); process.exit(1); }

const lines = out.toString('utf8').split('\n').filter(Boolean);
console.log('  JSONL 行数:', lines.length);
console.log();

// 解析所有事件
const events = [];
for (const l of lines) {
  try { events.push(JSON.parse(l)); } catch { /* ignore */ }
}

console.log('=== 事件类型 ===');
const types = {};
for (const e of events) {
  const t = e.type || '(无)';
  types[t] = (types[t] || 0) + 1;
}
for (const [k, v] of Object.entries(types).sort((a, b) => b[1] - a[1])) {
  console.log('  ' + k.padEnd(28) + v);
}
console.log();

// 找助手回复文本
console.log('=== 找助手回复 ===');
const texts = [];
for (const e of events) {
  const s = JSON.stringify(e);
  // 找 text 字段
  if (e.content || e.message || e.text) {
    texts.push({ type: e.type, snippet: s.slice(0, 200) });
  }
}

// 深挖：找所有 text 内容
function collectText(obj, acc, depth = 0) {
  if (depth > 8) return;
  if (typeof obj === 'string') {
    if (obj.length > 2 && obj.length < 2000) acc.push(obj);
    return;
  }
  if (Array.isArray(obj)) { for (const v of obj) collectText(v, acc, depth + 1); return; }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'text' || k === 'content' || k === 'delta' || k === 'value') collectText(v, acc, depth + 1);
      else if (typeof v === 'object') collectText(v, acc, depth + 1);
    }
  }
}

const allText = [];
for (const e of events) collectText(e, allText);

console.log('  收集到文本片段:', allText.length);
console.log();
for (const t of allText.slice(-20)) {
  console.log('    "' + t.replace(/\n/g, ' ').slice(0, 120) + '"');
}

// 关键判据
const EXPECT = '38643948';
console.log();
console.log('═══ 判定 ═══');
const hasAnswer = allText.some(t => t.includes(EXPECT));
const hasQuota = allText.some(t => /额度已用尽|ACCOUNT_QUOTA|QUOTA/.test(t));
console.log('  出现答案 ' + EXPECT + ' : ' + hasAnswer);
console.log('  出现 QUOTA              : ' + hasQuota);
if (hasAnswer && !hasQuota) console.log('  ✅ 网关通了');
else if (hasQuota) console.log('  ❌ QUOTA 未解决');
else console.log('  ? 会话可能还没写盘（等几秒再试）');
