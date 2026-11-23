---
name: run-tracing
category: 工程
depth: deep
description: 给 agent 一次运行建 trace：traceId、span 树、模型/工具调用耗时与成败、JSONL 落盘、失败 span 不静默。当用户要「审计一次 agent 到底干了什么」时使用。
---

# Agent 运行跟踪 技能

> 出了问题，你需要的不是「日志刷屏」，而是「这一次运行里，每个模型调用、每个工具调用，各花了多久、成没成」。
> 判据：**能按 traceId 把一次运行还原成一棵 span 树吗？失败的调用留下痕迹了吗？**

## 什么时候用

- agent 跑出错误结果，要定位是哪一步
- 要统计「工具调用失败率」「模型延迟分布」
- 评审「审计 / trace / 可观测」这类声明

## 什么时候**不**用

- 单步一次性脚本

## 第 1 步：一次运行 = 一个 traceId

用户发起一个任务，生成一个 traceId，整条链路的 span 都挂在它下面。不要用「时间范围」猜归属。

## 第 2 步：span 树，每次模型/工具调用一个 span

每个 span 至少带：

| 字段 | 含义 |
|---|---|
| spanId | 本 span 唯一 id |
| parentSpanId | 父 span（形成树） |
| kind | model / tool |
| startAt / endAt / durationMs | 时间与耗时 |
| ok | 成没成 |
| error | 失败原因（ok=false 时必填） |
| attributes | 模型名/工具名/参数摘要 |

## 第 3 步：JSONL 落盘 + 可查询

- 追加写 JSONL（一行一个 span），崩溃也不丢已写的
- 提供 `getTrace(traceId)` 还原、`listTraces()` 列表、`traceStats()` 统计
- 收尾写一条汇总 span（四态 + 失败 span 数）

## 反例（写下来防复发）

- ✗ 失败的调用不记 span：只看得到成功的，失败是黑洞
- ✗ span 没有 parentSpanId：还原不出「谁调了谁」
- ✗ 只记总耗时：不知道是模型慢还是工具慢
- ✗ trace 只存在内存：进程一崩全丢

## 自检清单

- [ ] 一次运行的所有 span 同一个 traceId
- [ ] 失败 span 有 ok=false + error（不静默）
- [ ] 能按 traceId 还原成树
- [ ] 落盘是追加式，崩溃不丢已有
- [ ] 有四态汇总

## 参考实现指路

本仓库 `tools/agent/trace.mjs`：traceId + span 树（spanId/parentSpanId/kind/startAt/endAt/durationMs/ok/error/attributes）、JSONL 落盘、getTrace/listTraces/traceStats。loop.mjs 每个模型调用与每次工具调用各记一个 span。

## 实测数据（本仓库，可复算）

```
node tools/agent/verify-trace.mjs      # 16 通过 / 0 失败
```

另用自写测试验证了 span 树（11/11）：

- `beginTrace` 生成 `traceId`；`withSpan` 包成功与抛错都留 span
- 一次运行 = 一个 trace，内部按「模型调用 / 工具调用」记 span
- **父 span 关系**：子 span 带 `parentSpanId`，能还原调用树
- **失败也留痕**：抛错的 span 记 `error`，`getTrace` 能读回来（不是丢了）
- `listTraces` / `traceStats` 给出 traces / spans / failedSpans / byState

**一个真实边界**：「真跑一次模型 → trace 里同时有 model 和 tool span」这段依赖真模型；
网关 401 时脚本会打印「模型未产生工具调用 → 真跑段 UNKNOWN」，**不判 FAIL**。

**教训**：**「能复盘」的判据是「失败的那次也能复盘」**。只给成功路径留 span，等于没有可观测性。
