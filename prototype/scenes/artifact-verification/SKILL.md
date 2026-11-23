---
name: artifact-verification
category: 工程
depth: deep
description: 校验 agent 的产出物是否真的存在且内容正确（不假装完成）：声明产物、存在性、内容、最小字节。当用户要"验证 agent 真改了文件"时使用。
---

# 产出物校验 技能

> agent 说「我完成了」不算完成。要**真的验产出**。
> 判据：**声明的产物，每个都能查出「存在、内容对、够大」吗？缺失的就是 FAIL，不许说 PASS。**

## 什么时候用

- agent 声明改了文件、建了文档、出了报告
- 要验收一个 agent 的真实交付
- 评审「agent 执行成功」这类声明是否可信

## 什么时候**不**用

- 纯信息性任务（没有可校验的产物）

## 第 1 步：先声明要验证什么（expectArtifacts）

让调用方明确列出「这次应该产出哪些文件」，而不是事后再猜。声明在**调用前**就写清楚：

- 文件路径
- 期望内容的关键片段（如 `team-ok-777`）
- 最小字节数

没有声明的产物不校验——这是显式的「本次不需要产出」。

## 第 2 步：四个校验点（每个都要真检查）

| 校验点 | 检查什么 | 不通过就是 |
|---|---|---|
| **存在** | 文件在不在 | 缺失 → FAIL |
| **内容** | 含期望的关键片段 | 不含 → FAIL |
| **最小字节** | size ≥ 声明下限 | 太小 → FAIL |
| **不假装** | 失败时**不返回 content** | 返回了空 content 也算 FAIL |

## 第 3 步：保守推断，但要给出候选给人确认

如果调用方没声明产物，系统可以**推断**，但：

- 只有「出现写文件的动作 + 文件名」才推断为高置信，否则**不推断**（防误报）
- 推断结果要给出候选列表，交人确认，**不静默当作已验证**

## 反例（写下来防复发）

- ✗ 文件不存在，但返回 state=PASS、content="" —— 在假装成功
- ✗ 声明了 minBytes 但没检查 —— 空文件也能过
- ✗ 只校验「路径存在」不校验「内容」—— 文件对了但内容是空的

## 自检清单

- [ ] 声明的产物：存在 ✓ 内容 ✓ 字节 ✓
- [ ] 缺失产物 → FAIL（不返回 content）
- [ ] 未声明的产物不参与校验
- [ ] 推断产物给了候选供确认

## 参考实现指路

本仓库：`tools/agent/loop.mjs` 的 `expectArtifacts` 参数（声明期望产出）+ `tools/agent/artifacts.mjs` 的 `checkArtifacts`（四校验）+ `tools/agent/infer.mjs` 的 `inferArtifacts`（保守推断）；未产出即 FAIL。`verify-e2e-scripted.mjs` 的 G/H 段是它的可复算反例。

## 实战记录（本仓库真实事件，2026-11-22）

**事件**：我给这个技能写「参考实现指路」时，写成了
「`tools/agent/loop.mjs` 的 `expectArtifacts` / `checkArtifacts` / `inferArtifacts`」。

**实际**：只用 grep 一查就发现——`loop.mjs` 里**只有 `expectArtifacts`**（一个参数）； 
`checkArtifacts` 在 `tools/agent/artifacts.mjs`，`inferArtifacts` 在 `tools/agent/infer.mjs`。

**为什么会错**：三个函数名同时出现在我的记忆里，我把它当成了「同一个文件里的三个函数」——
**"文件在" 不等于 "文件里有那东西"**。

**修法**：把归属拆开写清楚；并新增 `tools/skills/verify-references.mjs` 做「路径存在」检查、
`tmp/audit-claims.mjs` 思路做「标识符真在文件里」检查。

**复算**：`node tools/skills/verify-references.mjs`（285 处引用 0 不存在）。

**教训**：写「参考实现指路」时，**每个函数名都要单独 grep 一次文件**，不能靠「这三个应该在一起」的直觉。
