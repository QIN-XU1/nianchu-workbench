---
name: checkpoint-recovery
category: 工程
depth: deep
description: 让长任务可中断续跑：原子检查点、中断保留、未闭合轮修复、会话级续跑。当用户要"跑长任务、中途断了能接着跑"时使用。
---

# 检查点与续跑恢复 技能

> 长任务最怕中途崩了白干。能续跑，是「一个可持续的 agent」和「一次性脚本」的分水岭。
> 判据：**中断后能不能从检查点接着跑，且已完成的步骤不被破坏？**

## 什么时候用

- 跑多轮、多步的长任务
- 进程可能被打断（Ctrl+C、超时、崩溃）
- 要评审「自愈/失败恢复」这类声明

## 什么时候**不**用

- 单步、秒级任务（检查点的开销不值得）

## 第 1 步：进入循环即写检查点，每步更新

- 循环开始写一个初始检查点
- **每一步都更新**检查点（含当前进度、已完成的工具记录）
- 检查点写**原子**：先写临时文件再 rename，避免写一半崩了留下坏文件

## 第 2 步：区分「正常结束」和「中断」

- 正常结束 → **删除**检查点（不留垃圾）
- 中断 → **保留**检查点，并标记 `resumable = true`

判据：只有正常结束才删。中断保留，是「能接着跑」的前提。

## 第 3 步：坏文件与未闭合轮要能处理

- 读检查点：找不到 → 返回 null；**坏文件** → 标 `corrupted`，不崩、不假装
- 「未闭合的轮」用 `repairSession` 补一个 `turn-repaired` 标记，**不动已闭合的部分**
- 支持**消息级续跑**（seedMessages：从指定消息开始）

## 反例（写下来防复发）

- ✗ 中断也删检查点 → 崩了就真白干
- ✗ 检查点非原子（直接写）→ 崩在写中间留下坏文件，读不到
- ✗ 把已闭合的轮改坏来"修复" → 破坏已完成成果
- ✗ 坏文件直接崩 → 应该标 corrupted 并继续可用部分

## 自检清单

- [ ] 中断后 resumable=true 且检查点在
- [ ] 正常结束检查点被删
- [ ] 坏文件标 corrupted，不崩
- [ ] 未闭合轮补 turn-repaired，已闭合不动
- [ ] 消息级续跑可用

## 参考实现指路

本仓库 `tools/agent/checkpoint.mjs`：saveCheckpoint 原子覆盖写 / loadCheckpoint 坏文件标 corrupted / listResumable / discardCheckpoint / repairSession；loop.mjs 进入即写、每步更新、正常结束删、中断保留 resumable=true。`verify-resume.mjs` 是它的可复算反例。

## 实测数据（本仓库，可复算）

```
node tools/agent/verify-resume.mjs
```

实测 **21 通过 / 0 失败**，覆盖：

- 中断后 `resumable=true` 且检查点在；正常结束时检查点被删
- 坏检查点文件 → 标 `corrupted`，不崩、不假装
- `repairSession` 给未闭合轮补 `turn-repaired`，**不动已闭合的轮**
- `seedMessages` 消息级续跑
- `listResumable` / `discardCheckpoint` 行为一致

**实现要点（`tools/agent/checkpoint.mjs`）**：
- 写检查点用「临时文件 + rename」保证原子
- 进入循环即写初始检查点，**每一步更新**
- 只有正常结束才 `discardCheckpoint`；中断保留并标 resumable

**教训**：**「能续跑」的判据不是「有个 checkpoint 文件」，而是「中断后能接着跑且已完成的不被破坏」**。
