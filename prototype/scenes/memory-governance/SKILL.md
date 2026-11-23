---
name: memory-governance
category: 数据
depth: deep
description: 给 agent 记忆加治理：溯源拒写、冲突 supersede、TTL 四态、审计与 gc。当用户要"记忆可信、不静默覆盖"时使用。
---

# 记忆治理 技能

> agent 有记忆是好事，但「什么都记、静默覆盖、旧值消失」会让记忆不可信。
> 判据：**每条记忆有来源吗？冲突时旧值还查得到吗？过期的是不是悄悄消失？**

## 什么时候用

- 给 agent 建持久记忆库
- 要评审「记忆/记忆治理」这类能力
- 记忆出现「明明记过却查不到」

## 什么时候**不**用

- 单次会话的临时上下文（那不是持久记忆）

## 第 1 步：溯源——没有来源的写入拒绝

凭印象的记忆不许进存储。每次写入必须带 `source`，缺了就**拒绝写入并说明原因**。

每条记：source / by / createdAt / lastSeen / touchCount。

## 第 2 步：冲突——同 key 不同值时 supersede，不静默覆盖

- 同 key 同值 → 只 touch（更新 lastSeen），不堆新条目
- 同 key **不同值** → 旧条目标 `superseded` 并链 `supersededBy`，**旧值永远可查**
- `audit` 能找出「同 key 多值未解决」的情况

## 第 3 步：TTL——四态与 gc

按注入的时钟算 `effectiveState`：

- fresh（有效）
- superseded（被新值取代）
- expired（过期）
- conflicted（冲突未解决）

过期不进查询结果，但**保留历史**。`gc` 只删「既过期又被推翻」的，不误删还有价值的。

## 反例（写下来防复发）

- ✗ 静默覆盖旧值 → 记忆不可信，事后查不到为什么变了
- ✗ 没 source 也写 → 一堆「不知哪来的」记忆
- ✗ 过期直接物理删 → 想追溯时没了
- ✗ 同 key 不同值堆两条都算有效 → 查询出歧义

## 自检清单

- [ ] 无 source 写入被拒
- [ ] 冲突时旧值标 superseded 且可查
- [ ] effectiveState 四态正确
- [ ] gc 只删过期且被推翻的
- [ ] audit 能报未解决冲突

## 参考实现指路

本仓库 `tools/memory/store.mjs`：put 无 source 拒绝、同 key supersede + supersededBy、effectiveState 四态、audit/gc；经 `POST /api/memory` 接入产品主链路（put/get/audit/gc/state 真实 HTTP 可复算）。
