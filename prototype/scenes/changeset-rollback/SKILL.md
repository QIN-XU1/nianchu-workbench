---
name: changeset-rollback
category: 工程
depth: deep
description: 给 agent 的写操作加变更集与一键回滚：before/after 快照、原子记录、回滚到操作前、清理已确认变更。当用户要"改错了能撤回"时使用。
---

# 变更集与回滚 技能

> agent 改了 5 个文件，第 6 个改错了。没有回滚，用户只能手动逐个还原。
> 判据：**每次写操作前有没有留 before 快照？能不能一键回到操作前？**

## 什么时候用

- agent 会写/改文件、执行有副作用的操作
- 要让用户「不满意一键回滚」
- 评审「变更集/回滚」这类声明

## 什么时候**不**用

- 只读任务

## 第 1 步：写之前留 before 快照

每次修改文件前，记下：

- 文件路径
- **修改前内容**（before）
- **修改后内容**（after）

存进一个变更集（changeset），按操作顺序。

## 第 2 步：原子记录，改动可见

- 变更集记录要原子写（避免记一半崩了）
- 界面上能列出「这次改了哪些文件、每个 diff」

## 第 3 步：一键回滚到操作前

- 回滚 = 按变更集倒序，把 after 还原成 before
- 回滚后文件内容 == 修改前（逐字节）
- 已确认/已提交的变更可以清理（cleanup），不再占回滚空间

## 反例（写下来防复发）

- ✗ 只记 after 不记 before → 无法还原
- ✗ 变更集记一半崩了 → 回滚时数据不一致
- ✗ 回滚顺序错（正序）→ 改乱了
- ✗ 回滚后内容不完全等于 before → 残留脏数据

## 自检清单

- [ ] 每次写操作有 before/after
- [ ] 变更集原子记录
- [ ] 一键回滚到操作前（逐字节一致）
- [ ] 已确认变更可清理

## 参考实现指路

本仓库 `tools/agent/changeset.mjs`：before/after 快照、原子记录、一键回滚、cleanup。`verify-changeset.mjs` / `verify-changeset-cleanup.mjs` / `verify-changeset-rpc.mjs` 是它的可复算反例。前端「动手」面板能看到 diff 并一键回滚。
