/**
 * 自我复盘的档案浏览（Host 侧）
 *
 * 对应需求 7.3：
 *   "有时候我要看文件，那就加一个文件窗口，想看文件内容，那就加一个预览窗口"
 *
 * 设计：文件窗口（列表）+ 预览窗口（内容）并排 —— 这是 luanyujia 里复用率最高的搭配。
 *
 * 数据来源：
 *   - 方案/ 下的全部 md（项目的"设计档案"）
 *   - research/ 下的深读报告
 *   - 场景自己的 CONTEXT/MEMORY/SKILL
 *
 * 安全：
 *   - 只读
 *   - 路径必须落在白名单目录内（防目录穿越）
 *   - 单文件 ≤200KB
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, normalize, sep } from 'node:path';

/** 允许浏览的根（相对项目根的路径） */
const ALLOWED_ROOTS = [
  { key: 'plan', label: '方案文档', dir: '方案', ext: ['.md'] },
  { key: 'research', label: '研究材料', dir: 'research', ext: ['.md'] },
  { key: 'scene', label: '场景文档', dir: 'prototype/scenes', ext: ['.md', '.json'] },
  { key: 'plugin', label: '插件源码', dir: 'plugins', ext: ['.js', '.json', '.yml', '.svg'] },
];

/**
 * 列出某根下的文件（最多 2 层递归，避免太深）
 */
export function listProfiles(home, rootKey, { maxDepth = 2, limit = 200 } = {}) {
  const root = ALLOWED_ROOTS.find(r => r.key === rootKey);
  if (!root) throw new Error(`未知的根：${rootKey}（可用：${ALLOWED_ROOTS.map(r => r.key).join(', ')}）`);

  const baseDir = join(home, root.dir);
  if (!existsSync(baseDir)) return { root: rootKey, label: root.label, files: [] };

  const files = [];

  function walk(dir, depth) {
    if (depth > maxDepth || files.length >= limit) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const e of entries) {
      if (files.length >= limit) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        // 跳过噪声目录
        if (/^(node_modules|\.git|\.cache|dist|build|_临时|归档)$/.test(e.name)) continue;
        walk(p, depth + 1);
        continue;
      }
      const ext = '.' + e.name.split('.').pop().toLowerCase();
      if (!root.ext.includes(ext)) continue;
      try {
        const st = statSync(p);
        // 相对项目根的路径，用于后续读取
        const rel = relative(home, p).replace(/\\/g, '/');
        files.push({
          rel,
          name: e.name,
          dir: relative(home, dir).replace(/\\/g, '/'),
          bytes: st.size,
          mtime: st.mtimeMs,
        });
      } catch { /* ignore */ }
    }
  }

  walk(baseDir, 0);
  files.sort((a, b) => b.mtime - a.mtime);
  return { root: rootKey, label: root.label, total: files.length, files };
}

/**
 * 读一个文件（必须在白名单根内）
 */
export function readProfile(home, relPath) {
  if (!relPath || typeof relPath !== 'string') throw new Error('缺少路径');

  // 归一化并防穿越
  const norm = normalize(relPath).replace(/\\/g, '/');
  if (norm.startsWith('..') || norm.includes('/../')) throw new Error('路径不允许：' + relPath);

  const allowed = ALLOWED_ROOTS.some(r => norm.startsWith(r.dir + '/'));
  if (!allowed) throw new Error(`路径不在允许浏览的目录内：${norm}（允许：${ALLOWED_ROOTS.map(r => r.dir).join(', ')}）`);

  const abs = join(home, norm);
  if (!existsSync(abs)) throw new Error('文件不存在：' + norm);

  const st = statSync(abs);
  if (!st.isFile()) throw new Error('不是文件：' + norm);
  if (st.size > 200 * 1024) throw new Error(`文件太大（${Math.round(st.size / 1024)}KB > 200KB）`);

  return {
    rel: norm,
    name: norm.split('/').pop(),
    content: readFileSync(abs, 'utf8'),
    bytes: st.size,
    mtime: st.mtimeMs,
  };
}

export { ALLOWED_ROOTS };
