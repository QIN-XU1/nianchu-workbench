# 附录 D · 官方仓库原始素材地图

> 目标：把 `deepseek-ai/deepseek-harness`（20,665 个文件）里**该读什么**按优先级摊开。
> 这是 `05` §2.2 的展开版。
> 仓库：https://github.com/deepseek-ai/deepseek-harness（274,034 stars，MIT，master @ 2026-11-04）
> 本地快照：`research/repos/harness-official/`（已下载 10 份核心文档 + 若干包 README）、`research/raw/harness-tree.json`（完整文件树）

---

## 0. 仓库规模（实测）

| 顶层 | 文件数 | 说明 |
|---|---|---|
| `packages/` | **11,073** | 39 个包组，`@deepseek-ai/dsh-*` |
| `.agents/` | **4,086** | `notes/` 4037 份 ADR + `skills/` 49 份 agent 技能 |
| `snapshots/` | **1,968** | session 1213 / web 390 / sdk 298 / acp 66 |
| `apps/` | 1,585 | desktop / cli / web |
| `docs/` | **1,053** | 架构、子系统（207）、升级指南（357）、cookbook（39） |
| `scripts/` | 459 | 门禁与生成器 |
| `benchmarks/` | 48 | 用户路径性能门禁 |
| `vendor/` | 82 | Cordis 供应副本（含 upstream SHA） |
| `native/` | 79 | Node addon |
| `python/` | 70 | Python SDK/runtime |
| **合计** | **20,665 blobs / 23,540 节点** | — |

---

## 1. P0 必读（读这几份就够了，能省两周）

| # | 路径 | 大小 | 为什么 |
|---|---|---|---|
| 1 | `docs/architecture.zh.md` | 11 KB / 175 行 | **全仓最值钱的一页**：Cordis 全插件、profile/bundle 叠加、turn/step 流程、事件三域、会话日志、"能力 seam"、**「新行为的归属位置」映射表** |
| 2 | `docs/capability-seams.zh.md` | 62 KB | 每个能力的 Definition/Provider/Consumer 三角色 + **"什么时候不该拆"** 判据 |
| 3 | `docs/agent-lifecycle.zh.md` | 5 KB | 一张 mermaid 时序图，把所有 hook 的位置画清（`agent/inbox/spliced` → `followedup` → `turn/start` → `pre-step` → `request` → `step/start` → …） |
| 4 | `.agents/notes/README.md` | 13 KB | **ADR 制度本身**：双层路径编码 `{lifecycle}/{class}/yyyy-mm-dd-topic.md`、六类 class、格式门禁、archived 冻结规则 |
| 5 | `docs/testing.md` | 11 KB | 七层测试、**"Verify the world, not the self-report"**、**"A guard only guards if the regression fails it"** |
| 6 | `SAFETY.md` | 1.7 KB | 官方承认"**未做安全审计，不应视为安全或生产可用**" |
| 7 | `AGENTS.md`（根） | 19 KB | 纪律总纲：ESM、注册即 effect、**模型可见 ⟺ 已记录**、waterfall 必须 `next()`、无 hardcoded tunables、失败要响 |
| 8 | `packages/README.md` | 8.6 KB | **39 个包组的职责表** —— 找"我要的东西在哪个组" |
| 9 | `docs/glossary.md` | 6.8 KB | 术语的权威定义（seam、turn、step、surface…） |
| 10 | `docs/tool-execution-pipeline.md` | 4.5 KB | 一张流程图：pre-execute → **monotonic guards** → approval → execute → post-execute → result |

**读完这 10 份，就能在不做错方向的前提下开始设计。**

---

## 2. P1 该读（按"我要挂接的点"选读）

### 2.1 子系统契约（`docs/subsystems/`，207 文件）

| 我要做的事 | 读这个 |
|---|---|
| Ticket 状态要进模型 | `subsystems/session.md`（**80 KB，最厚**）：`SessionEventMap` 扩展纪律、`@messageProjection`、`registerMessageProjection()`、`contentGeneration` |
| 权限/审批 | `subsystems/approval.md`：`ApprovalOutcome` 是 **closed + fail-closed**（`allowed-once`/`rejected`/`cancelled`/`unavailable`；缺失 answerer → `unavailable` 而非放行）；`ApprovalPolicy = 'ask' \| 'never'`；**`approval/asked` + `approval/decided` 审计对** |
| 工具拦截 | `subsystems/tools.md`（51 KB）：`ToolRestriction`（全局 + 每条祖先 scope，取交集，own 注册豁免）、`ctx.tools.guard()`（**monotonic denial**）、pre-execute 可 deny/ask、**参数不可改写**（"history, audit, UI, and execution must agree"） |
| 长内容外置 | `subsystems/spill.md`：`saveText` 是**唯一操作**；返回 opaque locator + backend 提供的 retrieval hint + 精确字节数；`SpillOwner = {sessionId}`；fork 继承 locator 但不复制不重owned |
| 上下文装配 | `subsystems/system-prompt.md` |
| 子 agent | `subsystems/subagent.md` |
| 团队任务板 | `subsystems/agent-team.md`：`TeamTaskSnapshot` 有 `revision`（CAS）、`blockedBy`（**必须无环**）、`writeScopes`（**咨询式前缀，不是锁**） |
| 目标 | `subsystems/goal.md`：每 session 只有一个当前 goal；**goal 只记完成状态，不调度工作**；自动续跑需单独开 `goal-round-driver` |
| 计划模式 | `subsystems/plan.md` |
| 运行时自修改 | `subsystems/extensions.md`（17 KB）：`ctx.cordisInspect` + `ctx.dynamicCordisRunner` |
| 人类反馈 | `subsystems/feedback.md`：**"Neither kind of feedback reaches the model"** |

### 2.2 包组 README（`packages/<group>/README.md`）

39 组里与本项目相关的 14 组：

| 组 | 一句话 | 我们要不要用 |
|---|---|---|
| `core/` | 产品 API 脊柱：sessions/prompts/tools/agent 服务/concrete loop | ✅ 依赖 |
| `preset/` | **Per-session agent composition from preset `cordis.yml`** | ✅ **场景的第一落点** |
| `bundle/` | Installable `dsh --profile` patch layers | ✅ |
| `team/` | 共享任务板（DAG） | ✅ 复用，不自造 |
| `goal/` | durable objective + round driver | ✅ |
| `feedback/` | 人类信号（**不进模型**） | ✅ 进化的观察源 |
| `deliverables/` | `present` + `workspace-changes`（证据） | ✅ DoneSpec 的 evidence 来源 |
| `guard/` | `repeat-tool-reminder`（3/5/8）+ `timeout-policy` | ✅ 复用 |
| `extensions/` | **运行时自修改（沙箱化）** | ✅ 进化的应用层 |
| `spill/` | 外置存储 seam | ✅ |
| `compaction/` | 压缩 seam | ✅ |
| `context/` | 模型可见请求上下文（workspace 指令/时间/引用） | ✅ |
| `session/` | 持久会话数据面（persistence seam + projection seam） | ✅ |
| `session-query/` | 检索族（**lineage**、语义过滤、SQLite FTS） | ✅ 召回 |

### 2.3 关键 ADR（`.agents/notes/implemented/architecture/`，215 份里挑 12）

| 日期 | 标题 | 为什么 |
|---|---|---|
| 2026-06-11 | `event-sourced-sessions` | 为什么会话是事件溯源（决定了我们状态怎么存） |
| 2026-06-13 | `capability-seams` | 三角色纪律 + "不该拆"判据 |
| 2026-06-18 | `session-surface` | surface 与投影机制 |
| 2026-07-05 | `reconstructable-requests` | **"模型可见 ⟺ 已记录"的来源** |
| 2026-07-06 | `timeout-deadline-library` | 计时/终止分离（`timeout-policy` 的基础） |
| 2026-07-08 | `tool-output-spill-files` | spill 的设计 |
| 2026-07-24 | `separate-context-injection-from-turn-execution` | **`agent.inject()` 的设计**（不唤醒只注入） |
| 2026-07-30 | `credential-boundaries-and-atomic-registration` | 凭据边界 |
| 2026-07-31 | `goal-owned-durable-events` | goal 事件 |
| 2026-08-15 | `client-shells-and-dynamic-packages` | 动态插件包 |
| 2026-08-31 | `released-session-format-migrations` | **已提交 generation 绝不删改** |
| 2026-09-06 | `agent-request-freeze-evidence` | 请求冻结的证据与测量 |

### 2.4 被拒绝的 8 份（`.agents/notes/rejected/`）

| 日期 | 标题 | 学到什么 |
|---|---|---|
| 2026-06-16 | `typed-event-schemas` | 为什么不用"类型化事件 schema" |
| **2026-06-20** | **`drop-durable-step-boundaries`** | **`step/end` 不是仪式，是崩溃修复的证据**（原文："What we give up: 日志不再把'请求已开始但进程死掉前没产出'记为一个持久事实"） |
| 2026-06-20 | `fold-session-persistence-interface` | |
| 2026-06-20 | `truncate-interrupted-turns` | |
| 2026-07-12 | `prune-unused-skill-registry-api` | |
| 2026-07-19 | `fold-compaction-package-split` | |
| 2026-07-26 | `builtin-timer-promises-for-hand-rolled-sleeps` | **不要手写 sleep**（我们方案里的"自报心跳"要先看这条） |
| 2026-07-26 | `dependency-swaps-rejected-by-nih-audit` | |

> **[推断]** 第 7 条 `builtin-timer-promises-for-hand-rolled-sleeps` 对我方案是一次直接质疑：我设计的"模型自报心跳 `[[NextHeartbeat::N]]`"本质是**让模型决定何时再被叫醒**，而官方似乎倾向于"用内置 timer 而不是手写 sleep"。→ 应纳入 P0 证伪（`07` F-4）。

---

## 3. P2 验收相关（要证明结果对，必须读）

| 路径 | 内容 |
|---|---|
| `benchmarks/AGENTS.md` | 基准规则：按**被测用户路径**组织、**合成输入来自受评审常量**、**绝不用录制 Session 或网络服务**、**环境变量不得覆盖预算** |
| `benchmarks/agent-continuation/README.md` | **R-1 的官方答案**：100 轮 / 800 次真实文件读取冷续跑，hosted 预算 5,500ms + 1.25× = 7,000ms |
| `benchmarks/agent-continuation/workload.ts` | 合成维度 |
| `snapshots/AGENTS.md` | 快照的所有权规则 |
| `docs/testing.md` | 七层测试 + 反例证明 |
| `vitest.config.ts` / `vitest.snapshot.config.ts` / `vitest.bench.config.ts`（8 套） | 各层配置 |
| `scripts/verify-*.ts` | 门禁到底查什么（`verify-agent-note-format`、`verify-doc-budgets`、`verify-translation-pairing`、`verify-application-entrypoints`、`verify-cordis-config`、`verify-export-jsdoc`…） |

---

## 4. P3 反面教材（`docs/postmortem/`，15 份）

`docs/testing.md` 明确引用了一份：

> smoke tests 能抓出"绿色单元测试、坏产品"这一类，mock 抓不到 ——
> 见 `postmortem/0001-acp-default-export-drops-inject.md`

**读官方自己承认的事故，比读别人的事故清单更有用**（因为它的修复方式就在仓库里）。

---

## 5. 一条"怎么读"的建议

1. **先读 `docs/architecture.zh.md` 的「新行为的归属位置」表**（第 148–173 行），把需求映射到扩展点
2. **再读对应 `docs/subsystems/*.md` 的 type-equiv 块**（那些是**从源码抽出的真实契约**，不是散文）
3. **然后用 `packages/<group>/README.md` 确认包在哪**
4. **写设计时用 `.agents/notes/README.md` 的格式**（含 `## Problem` 必须脱离方案独立成立、`## Alternatives considered`、`## What we give up`）
5. **验收时只看 `docs/testing.md` 的门禁表**

---

## 6. 本地已下载清单

`research/repos/harness-official/`：

| 文件 | 大小 |
|---|---|
| `docs__architecture.md` / `.zh.md` | 19 KB / 11 KB |
| `docs__agent-lifecycle.md` / `.zh.md` | 5.8 KB / 5.0 KB |
| `docs__capability-seams.md` / `.zh.md` | 71 KB / 62 KB |
| `docs__testing.md` | 11 KB |
| `docs__tool-execution-pipeline.md` | 4.5 KB |
| `docs__event-producer-consumer.md` | 30 KB |
| `docs__defensive-patterns__README.md` | 2.4 KB |
| `docs__glossary.md` | 6.8 KB |
| `docs__subsystems__{core,tools,session,approval,spill,extensions,agent-team}.md` | 60/51/80/9/7/17/10 KB |
| `packages__README.md` | 8.6 KB |
| `packages__{extensions,guard,deliverables,feedback,preset,interaction}__README.md` | 2.6/2.3/2.5/2.4/1.4/2.9 KB |
| `benchmarks__AGENTS.md`、`benchmarks__agent-continuation__README.md` | 3.7 / 2.4 KB |
| `.agents__notes__README.md`、`.agents__notes__AGENTS.md` | 13 / 0.8 KB |
| `.agents__notes__rejected__*`（4 份） | — |
| `.agents__notes__implemented__architecture__2026-06-13-capability-seams.md` | 4.6 KB |
| `SAFETY.md` / `SAFETY.zh.md` / `AGENTS.md` / `BENCHMARK.md` / `CONTRIBUTING.md` | — |
| `docs__cookbook__extension-cookbook.md` | 11 KB |

**尚未下载（`06` §3 的必读清单）**：`docs/capability-seams.zh.md` 细读、215 份 architecture ADR、15 份 postmortem、48 个 benchmark 文件、所有 `verify-*.ts`。
