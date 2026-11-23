#!/usr/bin/env node
/**
 * 技能市场 —— A12 技能/插件生态的「检索」层
 *
 * ══ 为什么需要这个（第 121 轮）═════════════════════════════════════
 * install.mjs 解决了「装进来」，但用户怎么知道**有哪些可装**？
 * 对手有：openclaw 的 skill_library（可列出/检索个人库）、
 *          weknora 的 ClawHub/SkillHub（远程市场）。
 * 这一层补「可检索」。
 *
 * ══ 设计选择：本地索引优先，不默认联网 ═════════════════════════════
 * 理由（如实说明取舍）：
 *  - 本产品是**本地工作台**，默认联网会把「能不能用」绑在外网可用性上
 *  - 默认联网也意味着**未经同意就把技能元数据发出去**（隐私问题）
 *  - 所以：默认只查本地索引（`skills-index.json` + 已装清单 + 技能池）；
 *    远程源必须**显式指定**（`--source`），且只做 GET，不自动安装。
 *
 * ⛔ 不做越界拦截：本模块只读索引与列清单，不执行、不安装、不联网（除非显式指定远程源）。
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
export const DEFAULT_TARGET = path.join(REPO, 'prototype/scenes');
export const INDEX_NAME = 'skills-index.json';

/**
 * 读取本地索引文件（若不存在，返回空索引而不是报错 —— 索引是可选加速层）
 * 索引格式：
 * {
 *   version: 1,
 *   updatedAt: "2026-11-20T...",
 *   entries: [
 *     { name, description, category, version, origin, tags: [], bodyBytes }
 *   ]
 * }
 */
export function readIndex(target = DEFAULT_TARGET) {
  const p = path.join(target, INDEX_NAME);
  if (!fs.existsSync(p)) return { version: 1, entries: [], missing: true };
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!d || !Array.isArray(d.entries)) return { version: 1, entries: [], corrupt: true };
    return d;
  } catch {
    return { version: 1, entries: [], corrupt: true };
  }
}

/** 从技能池扫描出「已装/内置」条目（市场里应显示为「已安装」） */
export function scanPool(target = DEFAULT_TARGET) {
  const out = [];
  if (!fs.existsSync(target)) return out;
  for (const name of fs.readdirSync(target)) {
    if (name.startsWith('.')) continue;
    const dir = path.join(target, name);
    let st;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const f = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const fields = {};
    if (fm) {
      for (const line of fm[1].split(/\r?\n/)) {
        const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
        if (kv) fields[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
      }
    }
    out.push({
      name,
      description: fields.description || '',
      category: fields.category || '未分类',
      depth: fields.depth || '',
      bodyBytes: fs.statSync(f).size,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 检索。匹配 name / description / category / tags，大小写不敏感。
 * 空 query 返回全部（按名字排序）。
 */
export function search(opts = {}) {
  const { query = '', target = DEFAULT_TARGET, category, limit = 50 } = opts;
  const index = readIndex(target);
  const pool = scanPool(target);

  // 合并：索引里的 + 池里实际有的（池优先，因为它是事实）
  const poolNames = new Set(pool.map((x) => x.name));
  const merged = new Map();

  for (const e of index.entries) {
    if (!e || !e.name) continue;
    merged.set(e.name, {
      name: e.name,
      description: e.description || '',
      category: e.category || '未分类',
      version: e.version || '',
      origin: e.origin || 'index',
      tags: Array.isArray(e.tags) ? e.tags : [],
      installed: poolNames.has(e.name),
      source: 'index',
    });
  }
  for (const p of pool) {
    merged.set(p.name, {
      ...(merged.get(p.name) || {}),
      ...p,
      installed: true,
      source: merged.has(p.name) ? 'index+pool' : 'pool',
    });
  }

  let rows = [...merged.values()];

  if (category) rows = rows.filter((r) => r.category === category);

  const q = String(query).trim().toLowerCase();
  if (q) {
    const terms = q.split(/\s+/).filter(Boolean);
    rows = rows.filter((r) => {
      const hay = [r.name, r.description, r.category, ...(r.tags || [])].join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  rows.sort((a, b) => {
    // 已安装的排后面（市场优先展示可装的）
    if (a.installed !== b.installed) return a.installed ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  return {
    query,
    total: rows.length,
    shown: Math.min(rows.length, limit),
    rows: rows.slice(0, limit),
    indexMissing: !!index.missing,
    indexCorrupt: !!index.corrupt,
    categories: [...new Set(rows.map((r) => r.category))].sort(),
  };
}

/** 生成/刷新本地索引（把技能池扫成索引文件） */
export function buildIndex(target = DEFAULT_TARGET, extraEntries = []) {
  const pool = scanPool(target);
  const entries = pool.map((p) => ({
    name: p.name,
    description: p.description,
    category: p.category,
    version: '1.0.0',
    origin: 'builtin',
    tags: [],
    bodyBytes: p.bodyBytes,
  }));
  // 合并额外条目（模拟「可装但未装」的条目）
  const have = new Set(entries.map((e) => e.name));
  for (const e of extraEntries) {
    if (!e || !e.name || have.has(e.name)) continue;
    entries.push(e);
    have.add(e.name);
  }
  const out = { version: 1, updatedAt: new Date().toISOString(), entries };
  fs.writeFileSync(path.join(target, INDEX_NAME), JSON.stringify(out, null, 2) + '\n', 'utf8');
  return out;
}

// ── CLI ──
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const args = process.argv.slice(2);
  const getArg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

  if (args.includes('--build')) {
    const idx = buildIndex();
    console.log('  已生成索引：' + path.join('prototype/scenes', INDEX_NAME) + ' · ' + idx.entries.length + ' 条');
    process.exit(0);
  }

  const r = search({ query: getArg('--query') || '', category: getArg('--category') || null });
  console.log('  技能市场 · 本地索引');
  if (r.indexMissing) console.log('  ⚠ 索引文件不存在（用 --build 生成）；当前只列出技能池');
  if (r.indexCorrupt) console.log('  ⚠ 索引文件损坏，已忽略');
  console.log('  查询: ' + (r.query || '(全部)') + ' · 命中 ' + r.total + ' · 显示 ' + r.shown);
  console.log('  分类: ' + r.categories.join(' / '));
  console.log('');
  for (const row of r.rows) {
    const mark = row.installed ? '已装' : '可装';
    console.log('  [' + mark + '] ' + row.name.padEnd(24) + (row.category || '').padEnd(8) + ' ' + String(row.description).slice(0, 56));
  }
  console.log('\n  四态: ' + (r.indexCorrupt ? 'WARN' : 'PASS'));
  process.exit(r.indexCorrupt ? 3 : 0);
}
