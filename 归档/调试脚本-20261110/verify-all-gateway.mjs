/**
 * 验证全部 11 个场景的会话都走网关
 *
 * 判据：读每个会话的存储文件，检查
 *   ① header.config.provider == 'raccoon'
 *   ② 没有 QUOTA 错误
 *   ③ 有 assistant 消息
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const WB = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench`;
const SC = path.join(WB, '外壳', 'scenarios');
const SESS_ROOT = path.join(process.env.USERPROFILE || 'C:\\Users\\15282', '.dsh', 'sessions');

function findSessionFile(sid) {
  for (const ws of fs.readdirSync(SESS_ROOT)) {
    const f = path.join(SESS_ROOT, ws, sid, 'session.v4.jsonl.zstd');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function decompressAll(buf) {
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
  return Buffer.concat(frames).toString('utf8');
}

function collect(obj, acc, depth = 0) {
  if (depth > 12) return;
  if (typeof obj === 'string') { if (obj.length > 0) acc.push(obj); return; }
  if (Array.isArray(obj)) { for (const v of obj) collect(v, acc, depth + 1); return; }
  if (obj && typeof obj === 'object') { for (const v of Object.values(obj)) collect(v, acc, depth + 1); }
}

console.log('═══ 验证 11 个场景会话是否都走网关 ═══');
console.log();

// 读场景绑定
const scenes = [];
for (const f of fs.readdirSync(SC)) {
  if (!f.endsWith('.json') || f.startsWith('_')) continue;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(SC, f), 'utf8').replace(/\uFEFF/g, ''));
    const h = (j.panels || []).find(p => p.type === 'harness');
    if (h && h.sessionId) scenes.push({ id: j.id, sid: h.sessionId });
  } catch { /* ignore */ }
}
scenes.sort((a, b) => a.id.localeCompare(b.id));

console.log('  ' + '场景'.padEnd(20) + 'provider'.padEnd(12) + 'model'.padEnd(28) + '助手消息' + '  QUOTA');
console.log('  ' + '─'.repeat(86));

let okCount = 0;
const problems = [];

for (const s of scenes) {
  const f = findSessionFile(s.sid);
  if (!f) {
    console.log('  ' + s.id.padEnd(20) + '(找不到会话文件)');
    problems.push({ id: s.id, reason: 'no session file' });
    continue;
  }

  let provider = '?', model = '?', hasAssistant = false, hasQuota = false;

  try {
    const txt = decompressAll(fs.readFileSync(f));
    const events = txt.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    // 找 provider/model
    for (const e of events) {
      if (e.data?.header?.config) {
        provider = e.data.header.config.provider || provider;
        model = e.data.header.config.model || model;
      }
      if (e.type === 'assistant/message') {
        hasAssistant = true;
        const src = e.data?.message?.source;
        if (src?.provider) provider = src.provider;
        if (src?.model) model = src.model;
      }
    }
    hasQuota = /额度已用尽|ACCOUNT_QUOTA/.test(txt);
  } catch (e) {
    problems.push({ id: s.id, reason: 'decompress fail: ' + e.message.slice(0, 30) });
    continue;
  }

  const ok = provider === 'raccoon' && !hasQuota;
  if (ok) okCount++;
  else problems.push({ id: s.id, reason: 'provider=' + provider + ' quota=' + hasQuota });

  const mark = ok ? '✓' : '✗';
  console.log('  ' + mark + ' ' + s.id.padEnd(18) + String(provider).padEnd(12) + String(model).slice(0, 26).padEnd(28) +
    (hasAssistant ? '是' : '无').padEnd(8) + (hasQuota ? '有' : '无'));
}

console.log();
console.log('═══ 结论 ═══');
console.log('  走网关: ' + okCount + '/' + scenes.length);
if (problems.length === 0) {
  console.log('  ✅ 全部 11 个场景的会话都走 raccoon 网关');
} else {
  console.log('  问题:');
  for (const p of problems) console.log('    ' + p.id + ': ' + p.reason);
}
