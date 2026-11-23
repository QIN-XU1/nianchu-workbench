---
name: stop-reason-design
category: 工程
depth: deep
description: 给 agent 循环设计可判定的停止原因：显式枚举、是否终态、对应四态、防假绿。当用户要"agent 为什么停、停得对不对"时使用。
---

# 停止原因设计 技能

> agent 停止不是「跑完了」一种。撞步数上限、工具全失败、被取消、模型报错——每种都该有名字。
> 判据：**每次停止都能说出「为什么停、是不是终态、该判什么四态」吗？撞预算的不许判 PASS。**

## 什么时候用

- 设计 agent 循环的终止条件
- 要解释「这次运行为什么结束」
- 评审「停止条件可判定」这类声明

## 什么时候**不**用

- 单步无循环的任务

## 第 1 步：显式枚举停止原因（不要用 if-else 堆）

列一张判定表，每个原因有：

| 字段 | 含义 |
|---|---|
| 原因 id | done / step_budget / token_budget / time_budget / tool_error / model_error / empty_output / truncated / user_abort |
| 中文名 | 人能读（撞步数上限 / 工具全失败 / 被取消…） |
| 是否终态 | 还会不会继续 |
| 对应四态 | PASS / WARN / FAIL / UNKNOWN |

用一张表 + 一个 `classifyStop` 函数，取代散落的 if-else。

## 第 2 步：返回可审计的字段

运行结果带 `stopReason` / `stopLabel` / `stopDetail`，界面和日志才能说清「为什么停」。

## 第 3 步：防假绿（撞预算不许判 PASS）

这是最容易错的一步：**因为撞了步数/预算而停，不能判 PASS**。它没做完，只是没报错。

写一个 `assertNotFalseGreen` 守门：撞预算类原因 → 四态至少 WARN，不能是 PASS。

## 反例（写下来防复发）

- ✗ 撞步数上限却判 PASS → 半成品被当完成品
- ✗ 被用户取消判 FAIL → 取消不是失败，是用户意图
- ✗ 停止原因只有「完成/失败」两种 → 分不清「没做完」和「做错了」
- ✗ 截断输出算 PASS → 截断是没写完

## 自检清单

- [ ] 每个停止原因有中文名 + 终态 + 四态
- [ ] 运行结果带 stopReason/stopLabel
- [ ] 撞预算不判 PASS（防假绿守门）
- [ ] 取消 ≠ 失败
- [ ] 截断不算 PASS

## 参考实现指路

本仓库 `tools/agent/stop.mjs`：9 个停止原因判定表 + `classifyStop` + `assertNotFalseGreen`；loop.mjs 已改用 classifyStop 取代 if-else，返回 stopReason/stopLabel/stopDetail。
