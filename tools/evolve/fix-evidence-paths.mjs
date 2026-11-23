#!/usr/bin/env node
/**
 * 补全证据里的简写路径 —— 只在「对手仓库里**唯一匹配**」时才改，避免猜错。
 *
 * 背景（第 101 轮压力测试）：335 个 REAL 格里 63 格（18.8%）含无法解析的简写片段
 * （如 `matrix/send/edit-content.ts`、`rebuild/tools.rs`），这些片段无法被复核。
 *
 * 做法：对每个不可解析片段，在**该对手根目录**下找所有以该片段结尾的真实文件：
 *   · 恰好 1 个 → 把证据文本里的片段替换成完整相对路径（可复核）
 *   · 0 个或多个 → 不动，标记为「未能唯一确定」（绝不猜）
 * 改完重新跑 classifyEvidence 确认仍是 REAL；不是就回滚该格。
 *
 * 用法：node tools/evolve/fix-evidence-paths.mjs [--write]
 * 四态：0 完成（含未解析项统计）· 2 自检失败
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyEvidence, extractPaths, rootsOf } from './lib/evidence-provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WRITE = process.argv.includes('--write');
const P = path.join(ROOT, 'prototype/hermes-agents/matrix-data.json');
const mx = JSON.parse(readFileSync(P, 'utf8'));
const dims = []; for (const g of mx.dimensions) for (const it of g.items) dims.push(it);
const subjects = mx.subjects || [];
const v0 = (it, s) => (Array.isArray(it[s]) ? it[s][0] : '?');

const isFileLike = (s) => /\.[A-Za-z0-9]{1,6}$/.test(String(s)) && !/\.git$/i.test(s) && !/^(refs|repos)\//i.test(s);

// 每个对手的「文件名 → 相对路径列表」索引（懒建）
const indexCache = new Map();
function indexOf(oid) {
  if (indexCache.has(oid)) return indexCache.get(oid);
  const map = new Map();
  const roots = rootsOf(oid);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const walk = (dir, depth) => {
      if (depth > 8) return;
      let entries = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs, depth + 1);
        else if (e.isFile()) {
          if (!map.has(e.name)) map.set(e.name, []);
          map.get(e.name).push(path.relative(root, abs).replace(/\\/g, '/'));
        }
      }
    };
    walk(root, 0);
  }
  indexCache.set(oid, map);
  return map;
}

/** 找以 fragment 结尾的唯一真实路径 */
function uniqueMatch(oid, fragment) {
  const base = path.basename(fragment);
  const idx = indexOf(oid);
  const cands = idx.get(base) || [];
  // 先按「完整后缀」精确匹配；没有就退到「同名文件唯一」——仍要求唯一，绝不猜
  const exact = cands.filter((full) => full === fragment || full.endsWith('/' + fragment));
  if (exact.length === 1) return { cands: exact, unique: exact[0], how: 'suffix' };
  if (cands.length === 1) return { cands, unique: cands[0], how: 'basename' };
  return { cands, unique: null, how: 'ambiguous' };
}

/** 按原样能否解析（路径拼接后在对手根下存在） */
function resolvableAsIs(oid, p) {
  for (const r of rootsOf(oid)) if (existsSync(path.join(r, p.replace(/^[\\/]+/, '')))) return true;
  return false;
}

// ── 自检：唯一匹配逻辑（用我们自己的仓库造一个已知文件）──
{
  const t = uniqueMatch('dsh', 'tools/workbench/serve.mjs'); // dsh 里不该有我们的文件
  if (t.unique) { console.error('  ✗ 自检失败：别的对手仓库里不应唯一匹配到我们的文件'); process.exit(2); }
}

let fixed = 0, unresolved = 0, unchanged = 0;
const unresolvedList = [];
const fixedList = [];

for (const it of dims) {
  for (const s of subjects) {
    const verdict = v0(it, s.id);
    if (verdict === '判不了' || verdict === '?') continue;
    const raw = it[s.id];
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const ev = String(raw[1]);
    if (classifyEvidence(s.id, ev) !== 'REAL') continue;
    const frags = extractPaths(ev).filter(isFileLike);
    const bad = frags.filter((f) => !resolvableAsIs(s.id, f)); // 按原样解析不到 → 需要补全
    if (bad.length === 0) { unchanged++; continue; }

    let next = ev;
    let anyFixed = false;
    for (const f of bad) {
      const { unique } = uniqueMatch(s.id, f);
      if (unique) {
        if (next.includes(f)) { next = next.split(f).join(unique); anyFixed = true; }
        fixedList.push({ dim: it.id, opponent: s.id, from: f, to: unique });
      } else {
        unresolved++;
        unresolvedList.push({ dim: it.id, opponent: s.id, fragment: f });
      }
    }
    if (anyFixed) {
      // 保守：改完必须仍是 REAL，否则回滚该格
      if (classifyEvidence(s.id, next) === 'REAL') { raw[1] = next; fixed++; }
      else { unresolved++; unresolvedList.push({ dim: it.id, opponent: s.id, fragment: '(改后不再是 REAL，已回滚)' }); }
    }
  }
}

console.log('');
console.log('  证据简写路径补全（只改「唯一匹配」）');
console.log('  ' + '─'.repeat(70));
console.log('  已补全的格：' + fixed + '  子片段 ' + fixedList.length + ' 条');
console.log('  仍未唯一确定：' + unresolved + ' 条');
console.log('  无需改动的 REAL 格：' + unchanged);
if (fixedList.length) {
  console.log('  补全样例（前 8）：');
  for (const f of fixedList.slice(0, 8)) console.log('    ' + f.dim + '/' + f.opponent + '  ' + f.from + '  →  ' + f.to);
}
if (unresolvedList.length) {
  console.log('  未确定样例（前 6，保持原样不猜）：');
  for (const u of unresolvedList.slice(0, 6)) console.log('    ' + u.dim + '/' + u.opponent + '  ' + u.fragment);
}
console.log('  ' + '─'.repeat(70));
if (WRITE) { writeFileSync(P, JSON.stringify(mx, null, 2) + '\n', 'utf8'); console.log('  已写回矩阵（--write）'); }
else console.log('  （dry-run：未写回；加 --write 生效）');