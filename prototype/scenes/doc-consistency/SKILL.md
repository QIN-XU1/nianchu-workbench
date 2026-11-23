---
category: 数据
name: doc-consistency
description: 术语是否出现、有无未登记缩写。当用户要检查或修复与「文档一致性」相关的一致性时使用。
---

# 文档一致性 场景技能

## 什么时候用

保证文档里登记的术语都出现、且没有未登记的缩写

## 怎么做

1. 跑 `node prototype/scenes/doc-consistency/check.mjs`
2. 其余步骤 / 判据 / 坑：见 `prototype/scenes/_shared/consistency-check.md`（本技能=doc-consistency，与另外 5 个一致性技能共用同一份，改一处全生效）
