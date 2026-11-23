---
category: 数据
name: support-assign
description: 每单有 owner、owner 在值班表、无重复单。当用户要检查或修复与「客服分派」相关的一致性时使用。
---

# 客服分派 场景技能

## 什么时候用

保证每单有 owner、owner 在值班表、无重复单

## 怎么做

1. 跑 `node prototype/scenes/support-assign/check.mjs`
2. 其余步骤 / 判据 / 坑：见 `prototype/scenes/_shared/consistency-check.md`（本技能=support-assign，与另外 5 个一致性技能共用同一份，改一处全生效）
