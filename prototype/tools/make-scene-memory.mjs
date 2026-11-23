/**
 * 为 docs-index 场景建一份真实的 MEMORY.md（场景记忆）。
 * 验证：红线检查器能在真实场景上工作。
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const dir = join(HERE, '..', 'scenes', 'docs-index');
const memPath = join(dir, 'MEMORY.md');

if (existsSync(memPath)) {
  console.log('MEMORY.md 已存在，跳过');
} else {
  writeFileSync(memPath, [
    '# 文档索引场景记忆',
    '',
    '## 核心职责',
    '',
    '- 保证 `方案/README.md` 索引覆盖全部文档',
    '- 保证索引不指向不存在的文档',
    '- 保证索引无重复',
    '',
    '不碰：文档内容本身、代码、发布。',
    '',
    '## §〇 当前交接',
    '',
    '### 1) 上次交接',
    '',
    '- 2026-11-06：发现 README 漏登 13/14/15 三篇，已补登；`refresh-docs-index.mjs` 已可实时刷新。',
    '',
    '### 2) 当前项目',
    '',
    '| 项目 | 记忆文件 | 状态 | 下一步 |',
    '|---|---|---|---|',
    '| 文档索引 | 本文件 | 进行中 | 每次新增文档后跑 refresh |',
    '',
    '### 3) 下一步 / 卡点',
    '',
    '- 下一步：新增文档时自动跑 refresh（可挂到 check 流程）',
    '- 卡点：无',
    '',
    '## 历史记录',
    '',
    '- 2026-11-06：初始建立场景，data/ 与 baseline/ 分离。',
    '',
  ].join('\n'), 'utf8');
  console.log('created MEMORY.md for docs-index');
}
