/**
 * 文档密度索引判定（需求 6 的后半段）
 *
 * 用户原话：
 *   "整个项目一旦做起来，文件会越来越多，几十上百个文档，AI 不可能每次都全量看一遍，
 *    这时候就建立一个索引机制，按判据给文档密集的目录建索引，
 *    比如一个目录里三五十个文档，就必须有一份，
 *    稀疏的、临时的、缓存的、备份的、豁免掉，再用体检去查漏"
 *
 * 本模块做三件事：
 *   1. scan(root)      —— 遍历目录，统计每个目录的"可索引文档数"
 *   2. judge(scandir)  —— 按判据判定：需要索引 / 不需要 / 豁免
 *   3. check(root)     —— 查出"该有索引却没有"的目录（体检）
 *
 * 豁免规则（用户点名的几类）：
 *   - 稀疏（文档数 < 阈值）
 *   - 临时（_tmp / temp / .cache / node_modules / .git）
 *   - 缓存
 *   - 备份（backup / 归档 / archive / .bak）
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

export const DEFAULTS = {
  denseThreshold: 30,     // ≥30 个文档 ⇒ 必须建索引（用户说"三五十个"）
  warnThreshold: 15,      // 15-29 ⇒ 建议建（不算违规）
  indexFileNames: ['INDEX.md', '_索引.md', 'README.md'],   // 任一存在即视为"有索引"
  skipDirs: [
    'node_modules', '.git', '.cache', 'dist', 'build', 'out',
    '_tmp', 'tmp', 'temp', '.tmp',
    '备份', '归档', 'archive', 'backup', 'bak', '.bak',
    '配图', 'assets', 'images', 'img',     // 资源目录不算文档目录
  ],
  docExtensions: ['.md', '.txt', '.json', '.yaml', '.yml'],
};

function isSkippedDir(name, opts) {
  const n = name.toLowerCase();
  return opts.skipDirs.some(s => n === s.toLowerCase() || n.endsWith('.' + s.toLowerCase()));
}

/** 统计一个目录里的"直接子文档"数（不递归） */
function countDocs(dir, opts) {
  const docs = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return { count: 0, docs: [] }; }

  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isFile()) {
      const ext = name.includes('.') ? '.' + name.split('.').pop().toLowerCase() : '';
      if (opts.docExtensions.includes(ext)) docs.push(name);
    }
  }
  return { count: docs.length, docs };
}

/** 遍历并产出每个目录的画像 */
export function scan(root, opts = DEFAULTS) {
  const out = [];
  if (!existsSync(root)) return out;

  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }

    const subdirs = entries.filter(e => e.isDirectory() && !isSkippedDir(e.name, opts)).map(e => e.name);
    const { count, docs } = countDocs(dir, opts);

    const hasIndex = opts.indexFileNames.some(n => existsSync(join(dir, n)));

    out.push({
      dir,
      rel: relative(root, dir) || '.',
      docCount: count,
      docs: docs.sort(),
      hasIndex,
    });

    for (const sd of subdirs) walk(join(dir, sd));
  }

  walk(root);
  return out;
}

/** 按判据判定一个目录 */
export function judge(entry, opts = DEFAULTS) {
  const reasons = [];
  let verdict;

  if (opts.indexFileNames.some(n => entry.hasIndex)) {
    verdict = 'HAS_INDEX';
    reasons.push('已有索引文件');
  } else if (entry.docCount >= opts.denseThreshold) {
    verdict = 'MUST_INDEX';
    reasons.push(`文档数 ${entry.docCount} ≥ ${opts.denseThreshold}，必须有索引`);
  } else if (entry.docCount >= opts.warnThreshold) {
    verdict = 'SHOULD_INDEX';
    reasons.push(`文档数 ${entry.docCount} 介于 ${opts.warnThreshold}-${opts.denseThreshold}，建议建索引`);
  } else {
    verdict = 'SPARSE_OK';
    reasons.push(`文档数 ${entry.docCount} < ${opts.warnThreshold}，稀疏目录可不建`);
  }

  return { ...entry, verdict, reasons };
}

/** 体检：查出"该有索引却没有"的目录 */
export function check(root, opts = DEFAULTS) {
  const profiles = scan(root, opts).map(e => judge(e, opts));
  const violations = profiles.filter(p => p.verdict === 'MUST_INDEX');
  const warnings = profiles.filter(p => p.verdict === 'SHOULD_INDEX');

  return {
    ok: violations.length === 0,
    root,
    scanned: profiles.length,
    mustIndex: violations.map(v => ({ rel: v.rel, docCount: v.docCount, docs: v.docs.slice(0, 5) })),
    shouldIndex: warnings.map(v => ({ rel: v.rel, docCount: v.docCount })),
    withIndex: profiles.filter(p => p.verdict === 'HAS_INDEX').map(p => ({ rel: p.rel, docCount: p.docCount })),
  };
}
