---
category: 数据
name: data-reconcile
description: 两份数据记录集合与金额是否一致。当用户要检查或修复与「数据核对」相关的一致性时使用。
---

# 数据核对 场景技能

## 什么时候用

核对两份数据源的记录集合与金额是否完全一致

## 怎么做

1. 跑 `node prototype/scenes/data-reconcile/check.mjs`
2. 其余步骤 / 判据 / 坑：见 `prototype/scenes/_shared/consistency-check.md`（本技能=data-reconcile，与另外 5 个一致性技能共用同一份，改一处全生效）
