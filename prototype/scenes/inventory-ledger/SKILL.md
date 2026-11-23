---
category: 数据
name: inventory-ledger
description: 每种物料的账面量与仓库记录一致，且物料号在物料主数据里。当用户要检查或修复与「库存台账」相关的一致性时使用。
---

# 库存台账 场景技能

## 什么时候用

保证账面量与仓库记录一致，且物料号在物料主数据里

## 怎么做

1. 跑 `node prototype/scenes/inventory-ledger/check.mjs`
2. 其余步骤 / 判据 / 坑：见 `prototype/scenes/_shared/consistency-check.md`（本技能=inventory-ledger，与另外 5 个一致性技能共用同一份，改一处全生效）
