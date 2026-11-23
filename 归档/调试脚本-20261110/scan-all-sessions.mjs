import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SESS_ROOT = String.raw`C:\Users\15282\.dsh\sessions`;

function decompressZstd(buf) {
  if (typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(buf);
  return null;
}

// 扫全部工作区的全部会话，提取元信息
const all = [];
for (const ws of fs.readdirSync(SESS_ROOT)) {
  const wsDir = path.join(SESS_ROOT, ws);
  try { if (!fs.statSync(wsDir).isDirectory()) continue; } catch { continue; }

  for (const sid of fs.readdirSync(wsDir)) {
    const sd = path.join(wsDir, sid);
    try { if (!fs.statSync(sd).isDirectory()) continue; } catch { continue; }

    const f = path.join(sd, 'session.v4.jsonl.zstd');
    if (!fs.existsSync(f)) continue;

    let meta = null;
    try {
      const out = decompressZstd(fs.readFileSync(f));
      if (out) {
        const firstLine = out.toString('utf8').split('\n')[0];
        const e = JSON.parse(firstLine);
        if (e.type === 'session') meta = e;
      }
    } catch { /* ignore */ }

    if (meta) {
      all.push({
        workspace: ws,
        sessionId: sid,
        createdAt: meta.createdAt,
        cwd: meta.cwd,
        origin: meta.origin || 'user',
        parent: meta.parentSession || null,
        seeded: meta.isSeeded,
        preset: meta.agentPreset,
        depth: meta.delegationDepth || 0,
      });
    }
  }
}

console.log('总会话数:', all.length);
console.log();

// 只看主会话（非 subagent）
const main = all.filter(s => s.origin !== 'subagent');
console.log('主会话（非 subagent）:', main.length);
console.log();

// 按 cwd 分组
const byCwd = {};
for (const s of main) {
  (byCwd[s.cwd] = byCwd[s.cwd] || []).push(s);
}

console.log('=== 按工作目录分组 ===');
for (const [cwd, list] of Object.entries(byCwd)) {
  console.log();
  console.log('  ' + cwd);
  console.log('    ' + list.length + ' 个主会话');
  for (const s of list) {
    const t = new Date(s.createdAt);
    console.log('      ' + s.sessionId.padEnd(42) + '  ' + t.toISOString().slice(0, 16) + '  preset=' + (s.preset || '?'));
  }
}

fs.writeFileSync(String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\all-sessions.json`,
  JSON.stringify(all, null, 2), 'utf8');
console.log();
console.log('已保存 prototype/all-sessions.json');
