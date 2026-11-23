#!/usr/bin/env node
/**
 * REAL 判据压力测试 —— 若要求「证据里**每条**路径都可解析」，REAL 还剩多少？
 *
 * 背景（第 100 轮发现）：`classifyEvidence` 只要**一条**路径能在对手根目录下找到就判 REAL，
 * 于是 190/366 个 REAL 格的证据里混着不可解析的简写片段 —— 那些片段无法被复核。
 *
 * 本工具把 REAL 分成两档：
 *   STRICT：证据里**所有**可解析性检查都通过（每条像路径的片段都能在对手根下找到）
 *   WEAK  ：至少有一条片段找不到（REAL 是靠剩下的那条撑起来的）
 * 并统计 STRICT/WEAK 数与占比 —— 这就是「判据收紧后 REAL 会缩水多少」的硬数字。
 *
 * 片段过滤：明显不是文件的（以 .git 结尾、仓库根引用、纯目录名）不计入分母，
 * 否则会把「refs/dsh.git」这种噪声也算成不可解析，冤枉数据。
 *
 * 四态：0 输出统计（不判失败，这是审计不是门禁）· 2 自检失败
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyEvidence, extractPaths, rootsOf } from './lib/evidence-provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mx = JSON.parse(readFileSync(path.join(ROOT, 'prototype/hermes-agents/matrix-data.json'), 'utf8'));
const dims = []; for (const g of mx.dimensions) for (const it of g.items) dims.push(it);
const subjects = mx.subjects || [];
const v0 = (it, s) => (Array.isArray(it[s]) ? it[s][0] : '?');

/** 片段是否值得作为「可复核文件」要求（过滤明显噪声） */
function isFileLike(p) {
  const s = String(p).trim();
  if (!s) return false;
  if (/\.git$/i.test(s)) return false;              // 仓库引用
  if (/^(refs|repos)\//i.test(s)) return false;      // 根引用前缀
  if (!/\.[A-Za-z0-9]{1,6}$/.test(s)) return false;  // 没有扩展名 → 多半是目录
  return true;
}

function resolvable(oid, p) {
  for (const r of rootsOf(oid)) if (existsSync(path.join(r, p.replace(/^[\\/]+/, '')))) return true;
  return false;
}

// ── 自检 ──
{
  if (isFileLike('refs/dsh.git')) { console.error('  ✗ 自检失败：.git 结尾应被过滤'); process.exit(2); }
  if (!isFileLike('tools/x.mjs')) { console.error('  ✗ 自检失败：带扩展名应保留'); process.exit(2); }
  if (isFileLike('some/dir/')) { console.error('  ✗ 自检失败：无扩展名应过滤'); process.exit(2); }
}

let strict = 0, weak = 0;
const weakList = [];
const perOpp = {};
for (const it of dims) {
  for (const s of subjects) {
    const verdict = v0(it, s.id);
    if (verdict === '判不了' || verdict === '?') continue;
    const raw = it[s.id];
    const ev = Array.isArray(raw) && raw.length > 1 ? String(raw[1]) : '';
    if (classifyEvidence(s.id, ev) !== 'REAL') continue;
    const all = extractPaths(ev);
    const fileLike = all.filter(isFileLike);
    const bad = fileLike.filter((p) => !resolvable(s.id, p));
    if (bad.length === 0) strict++;
    else {
      weak++;
      weakList.push({ dim: it.id, opponent: s.id, bad: bad.slice(0, 3), total: fileLike.length });
      perOpp[s.id] = (perOpp[s.id] || 0) + 1;
    }
  }
}

const total = strict + weak;
console.log('');
console.log('  REAL 判据压力测试：若要求「每条文件型片段都可解析」，REAL 会缩水多少？');
console.log('  ' + '─'.repeat(74));
console.log('  REAL 格总数：' + total);
console.log('  STRICT（全部片段可解析）：' + strict + '  (' + (total ? (strict / total * 100).toFixed(1) : 0) + '%)');
console.log('  WEAK  （至少一条不可解析）：' + weak + '  (' + (total ? (weak / total * 100).toFixed(1) : 0) + '%)');
if (weak) {
  const top = Object.entries(perOpp).sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log('  WEAK 最多的对手：' + top.map(([k, n]) => k + '=' + n).join(' , '));
  console.log('  WEAK 样例（前 8）：');
  for (const w of weakList.slice(0, 8)) console.log('    ' + w.dim + '/' + w.opponent + '  不可解析：' + w.bad.join(' , '));
}
console.log('  ' + '─'.repeat(74));
console.log('  说明：这是审计数字，不是门禁。WEAK 不等于假证据，只表示「证据里含无法复核的片段」。');

mkdirSync(path.join(ROOT, 'evidence/evolve'), { recursive: true });
writeFileSync(path.join(ROOT, 'evidence/evolve/real-strict-audit.json'),
  JSON.stringify({ at: new Date().toISOString(), total, strict, weak, perOpponent: perOpp, samples: weakList.slice(0, 60) }, null, 2) + '\n', 'utf8');
console.log('  已写 evidence/evolve/real-strict-audit.json');