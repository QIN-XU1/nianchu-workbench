---
category: 写作
name: docs-index
description: README 索引必须覆盖全部文档，且不得重复。当用户要检查或修复与「文档索引」相关的一致性时使用。
---

# 文档索引 场景技能

## 什么时候用

保证 README 索引覆盖全部文档，且不指向不存在的文档、不重复

## 怎么做

1. 跑 `node prototype/scenes/docs-index/check.mjs`
2. 其余步骤 / 判据 / 坑：见 `prototype/scenes/_shared/consistency-check.md`（本技能=docs-index，与另外 5 个一致性技能共用同一份，改一处全生效）
