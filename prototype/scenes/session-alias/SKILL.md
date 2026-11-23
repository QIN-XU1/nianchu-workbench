---
name: session-alias
category: 工程
depth: deep
description: 给前后端方法名做别名映射：斜杠名与驼峰名互认、未知名如实报错、别名表可审计。当用户要"方法名改了别断接口"时使用。
---

# 方法名别名映射 技能

> 前端调 `agent/submitDialogTurn`，后端注册的是 `agent.submitDialogTurn`——名字对不上，接口就断了。
> 判据：**两种命名都能走通吗？拼错的名字会如实报错吗？**

## 什么时候用

- 前后端命名风格不一致（斜杠 vs 驼峰 vs 下划线）
- 方法重命名要向后兼容
- 要评审「接口兼容」这类声明

## 什么时候**不**用

- 前后端命名已经统一

## 第 1 步：别名表显式登记

把「前端真实名 → 后端实现」写成一张表，例如：

- `create_assistant_workspace` → 原样名
- `agent/listSessions` → `agent.listSessions`
- `agent/submitDialogTurn` → `agent.submitDialogTurn`

**显式登记**，不靠字符串自动转换猜（自动转换在边界情况会错）。

## 第 2 步：两种命名都走通

斜杠名与驼峰名都要能调到同一个实现。测试要覆盖两类。

## 第 3 步：未知方法如实报错

拼错的名字必须返回「方法不存在」（如 JSON-RPC `-32601`），**不能假装成功或挂起**。

## 反例（写下来防复发）

- ✗ 只支持一种命名 → 前端调不通
- ✗ 自动转换猜别名 → 边界名映射错
- ✗ 未知方法返回空 result → 假装成功
- ✗ 别名表散落各处 → 无法审计

## 自检清单

- [ ] 别名表显式登记
- [ ] 斜杠/驼峰两种都走通
- [ ] 未知方法如实报错（不假装成功）
- [ ] 别名表可审计

## 参考实现指路

本仓库 `tools/agent/verify-alias.mjs`（真连 WS 验：`create_assistant_workspace` 原样名、`agent/listSessions`、`agent/createSession`、`agent/submitDialogTurn`、`agent/getSession` 斜杠名；含反例「不存在的方法名如实报错」）。
