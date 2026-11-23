---
name: subagent-delegation
category: 协作
depth: deep
description: 给 agent 派子代理：隔离上下文、深度上限拒绝、并发批量、结果按索引对齐。当用户要"把子任务拆出去并行做"时使用。
---

# 子代理委派 技能

> 主 agent 上下文塞满时，把子任务派给子代理。但「派出去」不等于「隔离」，也不等于「能并行」。
> 判据：**子代理拿不到父对话吗？深度到顶会拒绝吗？并发有上限且结果对得上吗？**

## 什么时候用

- 主任务要拆成可独立做的子任务
- 上下文快满，想把子任务隔离出去
- 要评审「子代理/并行」这类声明

## 什么时候**不**用

- 子任务和主任务强耦合（需要同一份上下文）

## 第 1 步：隔离上下文（签名上就收不到父对话）

子代理的 prompt 只由 `task + systemPrompt` 组成，**签名上根本不传父对话**。这样隔离是结构性的，不是靠「记得别传」。

## 第 2 步：深度上限，到顶拒绝（不静默降级）

`depth` 记录嵌套层级，`depthLimit` 是上限。到顶时返回 **FAIL + refused=true + 原因「深度上限」**，不要静默降级成「在主 agent 里跑」。

## 第 3 步：并发批量 + 结果对齐

- `spawnBatch` 有并发上限（不要一次起 100 个）
- 结果**按索引对齐**（第 i 个结果对应第 i 个子任务）
- peak 并发可审计（事后知道峰值是多少）

## 反例（写下来防复发）

- ✗ 子代理能读到父对话 → 隔离形同虚设
- ✗ 深度到顶静默在主 agent 跑 → 嵌套失控
- ✗ 批量结果顺序乱 → 张冠李戴
- ✗ 无并发上限 → 起爆资源

## 自检清单

- [ ] 子代理 prompt 里无父对话
- [ ] 深度到顶 FAIL + refused
- [ ] 批量结果按索引对齐
- [ ] 有并发上限且 peak 可审计

## 参考实现指路

本仓库 `tools/agent/subagent.mjs`：spawnSubagent（composeSubagentPrompt 只拿 task+systemPrompt、depth/depthLimit 拒绝式上限）、spawnBatch（并发上限、索引对齐、peak 审计）。`verify-subagent.mjs` 是它的可复算反例。

## 实测数据（本仓库，可复算）

```
node tools/agent/verify-subagent.mjs
```

实测 **10 通过 / 0 失败**：

- **隔离**：`composeSubagentPrompt` 只接收 `task + systemPrompt`，**签名上没有父对话** → 隔离是结构性的
- **深度上限**：`depth: 5, depthLimit: 2` → 返回 `FAIL` + `refused: true` + 原因含「深度上限」
- **反例**：空任务 → `FAIL` 且**不调模型**（省一次调用）
- **并发批量**：结果按索引对齐，peak 并发可审计

**注意一个诚实边界**：其中「未到上限的子代理能跑（state=PASS）」依赖真模型；
本环境网关 401，该条被 `_modelOk` 守卫跳过（不判 FAIL）。

**教训**：**「隔离」最可靠的实现方式是「签名上就拿不到」**，而不是「记得别传」。
后者会随重构失效，前者不会。
