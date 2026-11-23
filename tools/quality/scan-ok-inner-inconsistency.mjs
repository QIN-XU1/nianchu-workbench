#!/usr/bin/env node
/**
 * 「外层 ok:true 内层失败」反模式扫描 —— 每个候选都必须被白名单**写明理由**。
 *
 * 【为什么需要】第 93 轮修了 `/api/memory put`：store 拒绝写入时外层仍回 200 + ok:true，
 * 失败藏在 result.ok:false 里。第 94 轮又发现 `/api/plugin-run` 同样问题（kernelOk:false 仍回 200）。
 * 这类 bug 的共同形状是：**HTTP 说成功，body 里说失败**。
 *
 * 做法：扫描 `send(...)` / `writeHead(2xx)` 附近同时出现 `ok: true` 与 `result`/`...spread` 的行，
 * 逐个要求 `tools/quality/ok-inner-whitelist.json` 给出解释（file + snippet + reason）。
 * 解释不了 = exit 1。这样「新增一处」或「白名单文字与代码脱钩」都会被抓到。
 *
 * 四态：0 全部有解释 · 1 有未解释候选 · 2 工具自检失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOOLS = path.join(ROOT, 'tools');
const WL = path.join(ROOT, 'tools/quality/ok-inner-whitelist.json');

/** 扫描：返回候选 {file, line, text} */
function scan(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { scan(p, acc); continue; }
    if (!e.name.endsWith('.mjs')) continue;
    // 验证/测试文件本身不算产品代码
    if (/^verify|\.test\.|\.selftest\./.test(e.name)) continue;
    if (e.name === 'scan-ok-inner-inconsistency.mjs') continue; // 本文件里的探针字符串不算产品代码
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      const t = text.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.includes('【第')) return; // 注释
      if (!/ok:\s*true/.test(t)) return;
      if (!/(result|\.\.\.)/.test(t)) return;
      if (!/(send\(|writeHead|200)/.test(t)) return;
      acc.push({ file: path.relative(ROOT, p).replace(/\\/g, '/'), line: i + 1, text: t.replace(/\s+/g, ' ').slice(0, 120) });
    });
  }
  return acc;
}

// ── 工具自检：scan 必须能抓到已知形状 ──
{
  const probe = [
    'send(res, 200, { ok: true, result: r ?? null });',
    'send(200, { ok: true, ...r });',
    'send(200, { ok: true, at: x });',   // 无 result → 不该被抓
    '// send(200, { ok: true, result: x })', // 注释 → 不该被抓
  ];
  const hits = probe.filter((p) => {
    const t = p.trim();
    if (t.startsWith('//')) return false;
    return /ok:\s*true/.test(t) && /(result|\.\.\.)/.test(t) && /(send\(|writeHead|200)/.test(t);
  });
  if (hits.length !== 2) { console.error('  ✗ 自检失败：应抓 2 条，实得 ' + hits.length); process.exit(2); }
}

const candidates = scan(TOOLS);
const wl = fs.existsSync(WL) ? JSON.parse(fs.readFileSync(WL, 'utf8').replace(/^\uFEFF/, '')) : { explained: [] };
const explained = Array.isArray(wl.explained) ? wl.explained : [];

function whyFor(c) {
  return explained.find((x) => x.file === c.file && c.text.includes(x.snippet));
}

console.log('');
console.log('  「外层 ok:true / 内层失败」反模式扫描 · 候选 ' + candidates.length + ' 处');
console.log('  ' + '─'.repeat(74));
let unexplained = 0;
for (const c of candidates) {
  const w = whyFor(c);
  if (w) console.log('  ✓ ' + (c.file + ':' + c.line).padEnd(42) + ' — ' + w.reason.slice(0, 40));
  else { unexplained++; console.log('  ✗ ' + (c.file + ':' + c.line).padEnd(42) + ' — 未解释：' + c.text.slice(0, 50)); }
}
console.log('  ' + '─'.repeat(74));
console.log('  白名单条数 ' + explained.length + ' · 候选 ' + candidates.length + ' · 未解释 ' + unexplained);
console.log('  四态: ' + (unexplained === 0 ? 'PASS' : 'FAIL'));
process.exit(unexplained === 0 ? 0 : 1);