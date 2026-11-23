---
name: four-state-verdict
category: 审查
depth: deep
description: 用四态判定代替二元真假：PASS/WARN/FAIL/UNKNOWN，退出码 0/1/2/3，拿不到证据就 UNKNOWN。当用户要"结论别只有对错"时使用。
---

# 四态判定 技能

> 「通过 / 不通过」两态会逼人说谎：环境不可验时，只能说「通过」或「不通过」，于是把「不知道」硬塞进其中一边。
> 判据：**每个结论都落在 PASS/WARN/FAIL/UNKNOWN 之一吗？UNKNOWN 有没有被当成 FAIL 或 PASS？**

## 什么时候用

- 设计验收/检查脚本
- 要评审「结论是否可信」
- 环境不可控（无网络、无模型、无服务）

## 什么时候**不**用

- 纯断言（`assert x === 1` 这种）

## 第 1 步：四态定义

| 态 | 含义 | 退出码 |
|---|---|---|
| PASS | 真验证通过 | 0 |
| WARN | 通过但有需注意项 | 3 |
| FAIL | 真验证失败 | 1 |
| UNKNOWN | 无法验证（环境/缺证） | 2 |

## 第 2 步：UNKNOWN 不是 FAIL，也不是 PASS

- 拿不到证据（无模型/无服务/无源码）→ **UNKNOWN**，不要伪 FAIL（甩锅给代码）也不要伪 PASS（假装成功）
- UNKNOWN 必须**写明原因**（如「网关 401」「服务未起」）

## 第 3 步：退出码要能机器读

脚本用 `process.exitCode = 0/1/2/3`，让上层工具能按码归类，而不是靠解析文字。

## 反例（写下来防复发）

- ✗ 环境不可验就判 FAIL → 把环境问题甩给代码
- ✗ 环境不可验就判 PASS → 假绿
- ✗ UNKNOWN 不写原因 → 无法判断该不该重试
- ✗ 退出码全是 0/1 → 上层分不清「失败」和「没验」

## 自检清单

- [ ] 每个结论落在四态之一
- [ ] UNKNOWN 带原因
- [ ] 退出码 0/1/2/3 对应 PASS/FAIL/UNKNOWN/WARN
- [ ] 报告区分 通过/失败/跳过/UNKNOWN

## 参考实现指路

本仓库各 verify 脚本统一用四态 + `process.exitCode`；`tools/verify-all.mjs` 按 0/1/2/3 归类（0 PASS / 1 FAIL / 2 UNKNOWN / 3 WARN）；`tools/agent/_model-probe.mjs` 专门把「模型不可用」判成 UNKNOWN 而非 FAIL。

## 实战记录（本仓库真实事件，2026-11-22）

**事件**：`tools/verify-all.mjs` 最初的归类逻辑是「输出里没有『四态:』行 → 默认 UNKNOWN」。
结果 `verify-changeset-rpc` / `verify-streaming` / `verify-evidence-completeness` 三个脚本
明明 `exit 1`/`3`，却被报成 UNKNOWN——**连续几轮的「0 失败」其实是错的**。

**根因**：把「没写四态」当成了「无法验证」，而不是「没按约定写四态」。

**修法**：改成按项目自己的退出码约定归类——`0 → PASS / 1 → FAIL / 2 → UNKNOWN / 3 → WARN`。
修完立刻暴露 4 个真失败（含 3 个被掩盖的）。

**复算**：`node tools/verify-all.mjs`（修前 UNKNOWN 13，修后 UNKNOWN 3）。

**教训**：UNKNOWN 是一个**需要证据**的判定，不是「不知道就填它」。默认值会把不确定性伪装成结论。
