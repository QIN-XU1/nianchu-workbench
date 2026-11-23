---
name: step-injection
category: 工程
depth: deep
description: 在 agent 循环的步边界注入新指令：每步拉取、插入为 user 消息、记录 kind=inbox、返回 injectedCount 可审计。当用户要"跑到一半补话"时使用。
---

# 步边界注入 技能

> 用户常在 agent 跑到一半时说「顺便也做 X」。如果只在开头读一次指令，这句就丢了。
> 判据：**新指令能在步边界被拉取、插入、记录吗？注入了几条能审计吗？**

## 什么时候用

- 长任务中用户追加指令
- 要让 agent 在运行中接收新信息
- 评审「循环注入/可中断」这类声明

## 什么时候**不**用

- 一次性短任务（开头读一次够）

## 第 1 步：每步边界拉取一次 inbox

在循环的**每一步开始前**调用 `inbox()`：

- 返回字符串 → 有注入，插为一条 user 消息
- 返回 null → 无注入，继续

不要只在循环开头读一次。

## 第 2 步：插入并落 transcript（kind=inbox）

注入的消息要落进 transcript，标 `kind: 'inbox'`，这样事后能看出「哪一步被插了什么」。

## 第 3 步：返回 injectedCount 可审计

运行结果带 `injectedCount`，调用方知道这次注入了几条。没有这个数字，「注入过没」就成了玄学。

## 第 4 步：注入不能破坏收尾

有注入时仍要能正常结束（四态合法）。注入是「加料」，不是「打断」。

## 反例（写下来防复发）

- ✗ 只在开头读 inbox → 中途补的话丢了
- ✗ 注入了但不记录 → 事后查不到
- ✗ 返回 injectedCount=undefined → 无法审计
- ✗ 注入把循环搞崩 → 收尾失败

## 自检清单

- [ ] 每步拉取 inbox（至少 1 次）
- [ ] 注入落 transcript kind=inbox
- [ ] 返回 injectedCount 数字
- [ ] 有注入仍正常收尾
- [ ] inbox 恒 null 时 injectedCount=0

## 参考实现指路

本仓库 `tools/agent/loop.mjs` 的 `runWithTools({ inbox })`：每步拉取、非空插 user 消息落 kind=inbox、返回 injectedCount。`verify-loop-control.mjs` 是它的可复算反例。

## 实测数据（本仓库，可复算）

```
node tools/agent/verify-loop-control.mjs
```

实测 **10 通过 / 0 失败**：

- `inbox` 被**按步拉取**（至少 1 次）
- 注入落 transcript 且标 `kind: 'inbox'`
- 返回 `injectedCount` 数字（可审计）
- **反例**：`inbox` 恒返回 null → `injectedCount = 0`（不误报注入）
- **反例**：不传 `signal`/`inbox` → 行为不变（向后兼容，`aborted = false`）

**注意边界**：这几条里「跑到一半取消」和「注入生效」依赖真跑一轮模型；
本环境网关 401，相关段由 `_modelOk` 守卫跳过，不判 FAIL。

**教训**：**注入必须能「一次都不注入」**。只测「能注入」不测「恒 null 时不误报」，会掩盖计数错误。
