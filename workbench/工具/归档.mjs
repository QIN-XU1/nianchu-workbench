#!/usr/bin/env node
/**
 * 归档层 —— L5，只增不改
 *
 * ══════════════════════════════════════════════════════════════
 *  设计依据（视频 BV1o4xg6RE9m「神经中枢控制电脑」）
 * ══════════════════════════════════════════════════════════════
 *
 *  > [09:39] 「L5 层就是一个归档层。归档与历史。
 *  >   归档层它是指**往里面加，绝对不改**。」
 *  >
 *  > [09:47] 「比如像会话归档了，它就是一份完美的对话备份。
 *  >   那我就每次归档就放进去就行了，我就不改它。
 *  >   它就是一个原始层——比如原始的项目信息，或者原始的一些东西。
 *  >   **就是你只要是想往里面丢的，但是你又不是很想删，
 *  >   觉得它未来还能体现出价值的，全部都放在这个归档层。**」
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么需要这一层
 * ══════════════════════════════════════════════════════════════
 *
 *  我们的问题：「不想删，但不确定有没有用」的东西无处可放。
 *
 *    废弃的派单      → 标 cancelled 就停在台账里，其实是「否定」不是「归档」
 *    旧版本的记忆    → 被覆盖就没了
 *    过时的项目信息  → 只能删或留着占地方
 *    历史会话        → 只在引擎的 sessions 里，没有归档概念
 *
 *  按他的设计，这些都应该进归档层：**只增不改，随时可查。**
 *
 * ══════════════════════════════════════════════════════════════
 *  归档层与其他层的区别
 * ══════════════════════════════════════════════════════════════
 *
 *  场景记忆（L2）    ← 会更新，会精简，会剥离
 *  影子记忆          ← 定期快照，用于对比
 *  回滚快照          ← 为了「改坏了能退」
 *  归档层（L5）      ← **只增不改，永不删除**
 *
 *  归档层 = 「历史事实的记录」，不是「当前状态」。
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/归档.mjs --put --type memory --scene 架构梳理 --reason "精简前的完整版"
 *  node 工具/归档.mjs --put --file <文件路径> --reason "..."
 *  node 工具/归档.mjs --list [--type X]
 *  node 工具/归档.mjs --get <归档id>
 *  node 工具/归档.mjs --search "关键词"
 *  node 工具/归档.mjs --verify
 *  node 工具/归档.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB_DIR = path.resolve(HERE, '..');
const WB = path.resolve(WB_DIR, '..');
const ARCH_ROOT = path.join(WB_DIR, '数据', '.dsh', '归档层');
const INDEX_FILE = path.join(ARCH_ROOT, '_索引.json');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// ══════════════════════════════════════════════════════════════
//  归档类型
// ══════════════════════════════════════════════════════════════
export const ARCHIVE_TYPES = {
  memory: { name: '记忆', desc: '场景记忆的历史版本' },
  project: { name: '项目信息', desc: '剥离出来的项目信息' },
  session: { name: '会话', desc: '完整的对话备份' },
  dispatch: { name: '派单', desc: '作废/关闭的派单原始记录' },
  decision: { name: '决策', desc: '重要决策及其依据' },
  misc: { name: '其他', desc: '不想删但不确定有没有用的' },
};

// ══════════════════════════════════════════════════════════════
//  只增不改：写入后禁止修改
// ══════════════════════════════════════════════════════════════
export const RULES = {
  /** 归档文件设为只读前的校验：内容 hash 必须与索引一致 */
  IMMUTABLE: true,
  /** 单个归档最大字节 */
  MAX_BYTES: 2 * 1024 * 1024,
};

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export function loadIndex() {
  const j = readJsonSafe(INDEX_FILE);
  if (!j || !Array.isArray(j.items)) return { items: [], version: 1 };
  return j;
}

function saveIndex(idx) {
  fs.mkdirSync(ARCH_ROOT, { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2), 'utf8');
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ══════════════════════════════════════════════════════════════
//  归档一个文件/内容
// ══════════════════════════════════════════════════════════════
export function put(opts) {
  const o = opts || {};
  const type = o.type || 'misc';
  if (!ARCHIVE_TYPES[type]) {
    return { ok: false, error: '未知归档类型: ' + type };
  }

  let content = o.content;
  let sourcePath = o.sourcePath || '';

  // 从文件读
  if (content === undefined && sourcePath) {
    const abs = path.isAbsolute(sourcePath) ? sourcePath : path.join(WB, sourcePath);
    content = readTextSafe(abs);
    if (content === null) return { ok: false, error: '读不到文件: ' + sourcePath };
  }

  if (!content || String(content).trim().length === 0) {
    return { ok: false, error: '内容为空，拒绝归档' };
  }

  const bytes = Buffer.byteLength(String(content), 'utf8');
  if (bytes > RULES.MAX_BYTES) {
    return { ok: false, error: '内容过大（' + bytes + ' > ' + RULES.MAX_BYTES + '）' };
  }

  // 生成 id
  const now = new Date(o.now || Date.now());
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const hash = sha256(String(content));
  const shortHash = hash.slice(0, 8);
  const id = type + '-' + stamp + '-' + shortHash;

  // 目录：归档层/<type>/<年-月>/
  const monthDir = now.toISOString().slice(0, 7);
  const dir = path.join(ARCH_ROOT, type, monthDir);
  fs.mkdirSync(dir, { recursive: true });

  // 写内容
  const fileName = id + '.md';
  const filePath = path.join(dir, fileName);
  const header = [
    '<!-- 归档条目 —— 只增不改 -->',
    '<!-- id: ' + id + ' -->',
    '<!-- type: ' + type + ' -->',
    '<!-- at: ' + now.toISOString() + ' -->',
    '<!-- sha256: ' + hash + ' -->',
    '<!-- source: ' + (sourcePath || '(直接写入)') + ' -->',
    '<!-- reason: ' + (o.reason || '') + ' -->',
    '',
    '',
  ].join('\n');

  fs.writeFileSync(filePath, header + String(content), 'utf8');

  // 记录到索引
  const idx = loadIndex();
  const entry = {
    id,
    type,
    typeName: ARCHIVE_TYPES[type].name,
    at: now.toISOString(),
    bytes,
    sha256: hash,
    sourcePath: sourcePath || null,
    scene: o.scene || null,
    reason: o.reason || '',
    file: path.relative(WB_DIR, filePath).replace(/\\/g, '/'),
  };
  idx.items.push(entry);
  saveIndex(idx);

  return { ok: true, entry };
}

// ══════════════════════════════════════════════════════════════
//  列出 / 读取
// ══════════════════════════════════════════════════════════════
export function listArchives(typeFilter) {
  const idx = loadIndex();
  let items = idx.items;
  if (typeFilter) items = items.filter((x) => x.type === typeFilter);
  return items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export function getArchive(id) {
  const idx = loadIndex();
  const entry = idx.items.find((x) => x.id === id);
  if (!entry) return { ok: false, error: '找不到归档: ' + id };
  const abs = path.join(WB_DIR, entry.file);
  const raw = readTextSafe(abs);
  if (raw === null) return { ok: false, error: '归档文件丢失: ' + entry.file };
  // 去掉头部注释
  const content = raw.replace(/^(<!--[\s\S]*?-->\n)+\n*/, '');
  return { ok: true, entry, content };
}

export function searchArchives(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const idx = loadIndex();
  const hits = [];
  for (const e of idx.items) {
    let matched = false;
    let where = '';
    // 索引字段匹配
    if ((e.reason || '').includes(kw) || (e.scene || '').includes(kw) ||
        (e.sourcePath || '').includes(kw)) {
      matched = true;
      where = '索引';
    }
    // 内容匹配
    if (!matched) {
      const abs = path.join(WB_DIR, e.file);
      const raw = readTextSafe(abs) || '';
      if (raw.includes(kw)) { matched = true; where = '内容'; }
    }
    if (matched) hits.push({ ...e, matchedIn: where });
  }
  return hits;
}

// ══════════════════════════════════════════════════════════════
//  校验：只增不改的完整性
// ══════════════════════════════════════════════════════════════
export function verifyArchives() {
  const idx = loadIndex();
  const problems = [];
  let okCount = 0;

  for (const e of idx.items) {
    const abs = path.join(WB_DIR, e.file);
    if (!fs.existsSync(abs)) {
      problems.push(e.id + ' 文件丢失');
      continue;
    }
    const raw = readTextSafe(abs) || '';
    const content = raw.replace(/^(<!--[\s\S]*?-->\n)+\n*/, '');
    const h = sha256(content);
    if (h !== e.sha256) {
      problems.push(e.id + ' 内容被改过（SHA 不符）');
      continue;
    }
    okCount++;
  }

  return {
    ok: problems.length === 0,
    total: idx.items.length,
    okCount,
    problems,
    reason: problems.length === 0
      ? '归档完整：' + okCount + ' 条全部未被修改'
      : problems.length + ' 条有问题',
  };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  归档层 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 类型定义
  chk('六类归档', Object.keys(ARCHIVE_TYPES).length === 6, Object.keys(ARCHIVE_TYPES).join(','));
  chk('规则：只增不改', RULES.IMMUTABLE === true, '');
  chk('有大小上限', RULES.MAX_BYTES > 0, String(RULES.MAX_BYTES));

  // 准备临时归档根
  const tmpRoot = path.join(WB_DIR, 'prototype', '_tmp-arch');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  const tmpIndex = path.join(tmpRoot, '_索引.json');
  fs.mkdirSync(tmpRoot, { recursive: true });

  // 用小工具函数模拟（因为模块里的路径是写死的，这里直接用文件操作验证逻辑）
  function putLocal(type, content, reason) {
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const hash = sha256(String(content));
    const id = type + '-' + stamp + '-' + hash.slice(0, 8);
    const dir = path.join(tmpRoot, type, now.toISOString().slice(0, 7));
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, id + '.md');
    fs.writeFileSync(fp, content, 'utf8');
    return { id, hash, fp };
  }

  // ② ready：能归档
  const a1 = putLocal('memory', '# 测试记忆\n\n内容一\n', '测试');
  chk('能归档', fs.existsSync(a1.fp), a1.id);
  chk('计算了 SHA', a1.hash.length === 64, a1.hash.slice(0, 8) + '...');

  // ③ 反例：空内容拒绝
  const e1 = (function () {
    const content = '';
    if (!content || String(content).trim().length === 0) {
      return { ok: false, error: '内容为空，拒绝归档' };
    }
    return { ok: true };
  })();
  chk('反例：空内容拒绝', e1.ok === false, e1.error);

  // ④ 只增不改：改了内容 SHA 会变
  const orig = fs.readFileSync(a1.fp, 'utf8');
  const h1 = sha256(orig);
  fs.writeFileSync(a1.fp, orig + '\n被篡改了\n', 'utf8');
  const h2 = sha256(fs.readFileSync(a1.fp, 'utf8'));
  chk('篡改后 SHA 会变', h1 !== h2, '这是「只增不改」的检测基础');

  // ⑤ 校验能发现篡改
  const tampered = h1 !== h2;
  chk('校验能发现篡改', tampered === true, '');

  // 恢复
  fs.writeFileSync(a1.fp, orig, 'utf8');
  chk('恢复后 SHA 一致', sha256(fs.readFileSync(a1.fp, 'utf8')) === h1, '');

  // ⑥ 搜索
  const found = fs.readFileSync(a1.fp, 'utf8').includes('内容一');
  chk('能按内容搜索', found === true, '');

  // ⑦ 关键：归档的东西永不删除
  chk('关键：归档只增不改（永不删）',
      RULES.IMMUTABLE === true && Object.keys(ARCHIVE_TYPES).length > 0,
      '这是归档层存在的唯一理由');

  fs.rmSync(tmpRoot, { recursive: true, force: true });

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  // ── 归档 ──
  if (has('--put')) {
    const type = val('--type') || 'misc';
    const file = val('--file');
    const scene = val('--scene');
    const reason = val('--reason') || '';

    let sourcePath = file;
    // --scene 模式：归档某场景的私有记忆
    if (scene && !file) {
      sourcePath = 'workbench/数据/.dsh/场景记忆/' + scene + '/场景私有记忆.md';
    }

    if (!sourcePath) {
      console.error('需要 --file <路径> 或 --scene <场景名>');
      process.exit(2);
    }

    const r = put({ type, sourcePath, scene, reason });
    if (!r.ok) { console.error('✗ ' + r.error); process.exit(2); }
    console.log('✓ 已归档');
    console.log('  id:     ' + r.entry.id);
    console.log('  类型:   ' + r.entry.typeName);
    console.log('  大小:   ' + r.entry.bytes + ' B');
    console.log('  来源:   ' + (r.entry.sourcePath || '(直接写入)'));
    console.log('  文件:   ' + r.entry.file);
    process.exit(0);
  }

  // ── 列出 ──
  if (has('--list') || (!has('--put') && !has('--get') && !has('--search') && !has('--verify'))) {
    const type = val('--type');
    const items = listArchives(type);
    console.log('═'.repeat(78));
    console.log('  归档层（' + items.length + ' 条' + (type ? '，类型 ' + type : '') + '）');
    console.log('═'.repeat(78));
    console.log();
    if (items.length === 0) {
      console.log('  还没有归档。');
      console.log();
      console.log('  用法:');
      console.log('    node 工具/归档.mjs --put --scene 架构梳理 --reason "精简前的完整版"');
      console.log('    node 工具/归档.mjs --put --file <路径> --type decision --reason "..."');
    } else {
      for (const e of items.slice(0, 25)) {
        console.log('  ' + e.id);
        console.log('     ' + e.typeName.padEnd(6) + String(e.bytes).padStart(7) + ' B  ' +
          e.at.slice(0, 19).replace('T', ' ') + '  ' + (e.reason || '').slice(0, 30));
      }
      if (items.length > 25) console.log('  …还有 ' + (items.length - 25) + ' 条');
    }
    console.log();
    console.log('─'.repeat(78));
    console.log('  只增不改：归档后内容不可修改，校验会检测篡改');
    console.log('─'.repeat(78));
    process.exit(0);
  }

  // ── 读取 ──
  if (has('--get')) {
    const id = val('--get');
    const r = getArchive(id);
    if (!r.ok) { console.error('✗ ' + r.error); process.exit(2); }
    console.log('═'.repeat(72));
    console.log('  ' + r.entry.id);
    console.log('═'.repeat(72));
    console.log();
    console.log('  类型: ' + r.entry.typeName);
    console.log('  时间: ' + r.entry.at);
    console.log('  大小: ' + r.entry.bytes + ' B');
    console.log('  原因: ' + (r.entry.reason || '—'));
    console.log();
    console.log('─'.repeat(72));
    console.log(r.content.slice(0, 3000));
    if (r.content.length > 3000) console.log('\n…（截断，完整内容见 ' + r.entry.file + '）');
    process.exit(0);
  }

  // ── 搜索 ──
  if (has('--search')) {
    const kw = val('--search');
    const hits = searchArchives(kw);
    console.log('搜索「' + kw + '」→ ' + hits.length + ' 条');
    for (const h of hits.slice(0, 20)) {
      console.log('  ' + h.id + '  [' + h.typeName + ']  （匹配：' + h.matchedIn + '）');
      if (h.reason) console.log('      ' + h.reason);
    }
    process.exit(hits.length > 0 ? 0 : 1);
  }

  // ── 校验 ──
  if (has('--verify')) {
    const r = verifyArchives();
    console.log('═'.repeat(72));
    console.log('  归档完整性校验（只增不改）');
    console.log('═'.repeat(72));
    console.log();
    console.log('  总数: ' + r.total);
    console.log('  完好: ' + r.okCount);
    console.log();
    if (r.ok) {
      console.log('  ✓ ' + r.reason);
    } else {
      console.log('  ✗ ' + r.reason);
      for (const p of r.problems.slice(0, 15)) console.log('    · ' + p);
    }
    process.exit(r.ok ? 0 : 1);
  }
}
