/**
 * 从方案/README.md 实时生成 docs-index 场景的数据。
 *
 * 为什么需要它（方案 15 篇 E1）：
 *   手工快照的场景数据会过期 —— 一个不自动更新的检查，本身就是会过期的检查。
 *
 * 用法：node prototype/tools/refresh-docs-index.mjs
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const PROTOTYPE = join(HERE, '..');
const PROJECT = join(PROTOTYPE, '..');
const DOCS_DIR = join(PROJECT, '方案');
const README = join(DOCS_DIR, 'README.md');
const SCENE = join(PROTOTYPE, 'scenes', 'docs-index');

if (!existsSync(README)) {
  console.error('README 不存在：' + README);
  process.exit(2);
}

// ---- 1. 实际存在的文档 ----
const docs = readdirSync(DOCS_DIR)
  .filter(f => f.endsWith('.md') && f !== 'README.md')
  .sort();

// ---- 2. README 里实际链接到的文档 ----
const readme = readFileSync(README, 'utf8');
const linked = [...readme.matchAll(/\]\(([^)]+\.md)\)/g)]
  .map(m => m[1])
  .filter(f => !f.includes('/') && !f.startsWith('http'))
  .sort();
const indexed = [...new Set(linked)];

// ---- 3. 写入 ---- (data = 真实，baseline = 干净)
const dataDir = join(SCENE, 'data');
const baseDir = join(SCENE, 'baseline');
mkdirSync(dataDir, { recursive: true });
mkdirSync(baseDir, { recursive: true });

writeFileSync(join(dataDir, 'docs.json'), JSON.stringify(docs, null, 2), 'utf8');
writeFileSync(join(dataDir, 'indexed.json'), JSON.stringify(indexed, null, 2), 'utf8');

writeFileSync(join(baseDir, 'docs.json'), JSON.stringify(docs, null, 2), 'utf8');
writeFileSync(join(baseDir, 'indexed.json'), JSON.stringify(docs, null, 2), 'utf8');

const missing = docs.filter(d => !indexed.includes(d));
const ghost = indexed.filter(i => !docs.includes(i));
console.log(`刷新完成：文档 ${docs.length} 篇，README 索引 ${indexed.length} 篇`);
console.log(`  真实缺失：${missing.length}${missing.length ? ' -> ' + missing.join(', ') : ''}`);
console.log(`  幽灵链接：${ghost.length}${ghost.length ? ' -> ' + ghost.join(', ') : ''}`);
