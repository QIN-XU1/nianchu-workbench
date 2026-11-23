# WeKnora 拆解（v2 可抄实现口径）

> 仓库：`D:\refs\WeKnora\WeKnora-main`（腾讯 WeKnora，知识管理框架）
> 规模：6,249 文件，Go 1.26（`go.mod:1,3`），版本 v0.9.0（`.git` 缺失，star/最近 push 未在本地产物找到）。
> 定位：一句话 —— **"找答案、用知识"的 RAG + 知识管理框架**：文档摄取 → 自适应切块 → 混合检索 → 重排 → 带引用回答，并内置一套**独立的 ReAct agent 引擎 + 长期记忆子系统**（`go.mod:1` module `github.com/Tencent/WeKnora`）。

---

## 0. 先核实 v1 的说法（最重要）

> v1：「RRF 必须归一化 —— 原始 RRF 上限约 0.016」

**核实：成立，代码里有原文。**
- `internal/application/service/knowledgebase_search_fusion.go:157-163` 注释原文：
  `Raw RRF tops out near 0.016, which made hybrid hits lose to any vector-only or keyword-only result … and left rerank's base-score term and MMR's relevance term with nothing to work with.`
- 上限就是 `maxRRF = (vectorWeight+keywordWeight)/(rrfK+1)`：`.../knowledgebase_search_fusion.go:176`；默认 `RRFVectorWeight=0.7, RRFKeywordWeight=0.3, RRFK=60`（`internal/types/retrieval_config.go:28-37`、`:100-107`）→ `1.0/61 = 0.01639`。
- 归一化落地：`.../knowledgebase_search_fusion.go:204` `info.Score = rrfScore / maxRRF`。
- 测试钉死：`.../knowledgebase_search_fusion_test.go:126-158` —— 原始 BM25 `16.1239` 被弃用，单 retriever 第 1 名得 0.7 / 0.3，双榜第 1 得 `1.0`，全部落 `(0,1)`。

一句话：**它的 RRF 是"加权 RRF ÷ 理论最大值"的归一化版本，我们照抄这条公式即可解决"混合检索分数与纯向量分不可比"的问题。**

---

## 1. 定位与规模
- 一句话：见上。证据 `go.mod:1`。
- 文件 6,249；Go 主语言；四子入口：`cmd/`（服务）、`cli/`（命令行）、`client/`（Go SDK）、`frontend/`（Vue3 Web）；`docreader/` 是**独立 Python gRPC 解析服务**（`docreader/main.py:14,25`）。
- 版本 v0.9.0（`VERSION`/`README.md:13`）。
- 说明：本地产物无 `.git`，star/push 日期「未找到」——不臆测。

## 2. 架构骨架
顶层目录职责（均带路径）：
- `internal/types`：领域模型 + 接口（`types/memory.go`、`types/retrieval_config.go`）；`internal/types/interfaces` 定义仓储/服务接口。
- `internal/application/{repository,service}`：仓储与业务服务（`service/knowledgebase_search*.go`、`service/memory/*`、`service/chat_pipeline/*`）。
- `internal/infrastructure/{chunker,docparser}`：切块与解析（`chunker/strategy.go`）。
- `internal/models/*`：模型层（`providers/`、`chat/`、`embedding/`、`rerank/`、`asr/`、`vlm/`）。
- `internal/agent/*`：独立 agent 引擎（`engine.go`、`tools/`、`compaction/`、`skills/`、`collaboration/`、`operations/`、`policy/`、`approval/`、`hitl/`）。
- `internal/mcp`、`internal/mcpserver`：MCP 客户端/服务端；`internal/sandbox`、`internal/localsandbox`：执行沙箱；`internal/im/*`：IM 通道。
- `internal/router`、`internal/handler`、`internal/middleware`：HTTP 层与鉴权。
- **依赖方向**：`types` / `types/interfaces` 为最底层抽象，`application/service` 依赖 `infrastructure` 与 `models`，`agent` 通过 `types/interfaces` 取服务（如 `agent/tools/search_memory.go` 调 `MemoryService`）。核心/扩展边界**不是**强制式（无 arch_test），靠目录约定 —— 与 RAGFlow（有 `arch_test.go` 强制）不同，见 B1。
- 没有"核心/插件"类型级隔离；唯一近似的扩展点是 `service/chat_pipeline` 的 `Plugin` 接口（见 §3）。

## 3. 【A12】插件 / 扩展机制（重中之重）—— **三条并存的"扩展点"**

WeKnora 没有 Go 运行时插件装载，但有**三套成熟的"可扩展"惯用法**，且都很值得抄：

### 3a. RAG 流水线 = 链式插件（**这个最该抄**）
- 接口：`internal/application/service/chat_pipeline/chat_pipeline.go:9-21`
  ```go
  type Plugin interface {
      OnEvent(ctx, eventType types.EventType, chatManage *types.ChatManage, next func() *PluginError) *PluginError
      ActivationEvents() []types.EventType
  }
  ```
- 管理器/装配：`chat_pipeline.go:23-78` —— `EventManager` 按 `EventType` 挂监听，`buildHandler`（`:53-68`）把多个插件编成 **Koa/Express 式中间件洋葱链**（`next()` 回调）。
- 每个阶段自己注册：`search_parallel.go:80`、`query_understand.go:47`、`rerank.go:29`、`filter_top_k.go:17`、`merge.go:24`、`memory_recall.go:44`、`wiki_boost.go:32` … 全部 `eventManager.Register(res)`。
- 贡献点：一个"事件"= 用户提问方向（理解/扩写/检索/合并/重排/记忆召回/答案拼装）。
- 怎么发现/装载：**编译期显式 Register**，无清单文件、无热插拔。隔离：同进程、共享 `*ChatManage` 上下文（能拿到全部中间态）。

### 3b. Agent 技能 = SKILL.md 渐进披露（Claude 规范）
- 清单 = `SKILL.md` 的 YAML frontmatter，字段 `name / description / slug`：`internal/agent/skills/skill.go:41-63`；三级披露 Level1 元数据常驻 / Level2 正文按需 / Level3 资源按需（`skill.go:36-40`）。
- 发现 = 扫目录找 `SKILL.md`：`skills/loader.go:28-44`（`DiscoverSkills`→`discoverInDirectory`）。
- 校验 = `namePattern` 单段路径名、保留字 `anthropic/claude`：`skill.go:22-34`；frontmatter 坏了会"修复并告知"`skill.go:58-62`。
- 装载/安装 = 管理员上传 zip 成 tenant 技能包，落 Cube 沙箱镜像：`skills/tenant_source.go:47-55`、`manager.go:94+`；解压配额 512MiB/20000 文件（`tenant_source.go:21-45`）。
- 执行 = 在沙箱里跑脚本，注入 `WEKNORA_SKILL_OUTPUT_DIR` 等环境变量：`manager.go:20-92`。
- 隔离：**强**——脚本在 Cube MicroVM 内，环境变量有黑名单（`manager.go:45-58`）。

### 3c. Agent 操作目录 = Swagger 注解编译成"工具白名单"
- 位置：`internal/agent/operations/catalog.go:1-11`。用 handler 上的 `x-agent` 注解，从 Swagger 文档编译出 agent 可调的 HTTP 操作集；**目录即白名单**，执行走真实 router（鉴权/RBAC/审计与 Web UI 一致），只收窄可达范围。
- 这是"让 agent 操作宿主自身"的漂亮做法（B2 单一真源：OpenAPI 一份）。

**A12 判定：部分** —— 机制丰富（链式插件 + 技能包 + 操作白名单），但**没有**宿主级外部插件清单（贡献 UI 面板/路由）、无运行时安装/卸载/热插拔；Go 编译期 Register。

## 4. 【A13】MCP / 工具接入 —— **有，双向**
- MCP client：`internal/mcp/client.go`（901 行）、`manager.go`（498）、OAuth 全套（`oauth_manager.go`/`oauth_assertion.go`/`oauth_state.go`）。
- 工具适配进 registry：`internal/agent/tools/mcp_tool.go`、`mcp_catalog.go`、`mcp_exposure.go`、`mcp_call_guard.go`。
- **反向**：WeKnora 自己也能当 MCP server：`internal/mcpserver/server.go` + `tools_retrieve.go`/`tools_ingest.go`/`tools_wiki.go`/`tools_ask.go`（把知识库检索/摄取/维基/问答暴露给外部 agent）。
- 工具描述/回填：`tools/registry.go`（`RegisterTool`/`RegisterDeferredTool`，first-wins 防劫持 `registry.go:57-62`）。

## 5. 【A11】调度 / 后台任务 —— **有**
- 定时触发器：`internal/automation/trigger.go:66-117`（cron 五/六字段或 `@daily`，或 once 绝对时间）；最小间隔校验 `CheckInterval` 默认 5 分钟（`:19-20,154-167`）。
- tick 循环 + 抢占：`internal/application/service/automation_scheduler.go:24-45`（`time.NewTicker(s.cfg.Tick)`→`tick`），`:77 claimDue`/`:94 claim`/`:147 overlap`（跳过或排队）/`:73 misfireGrace`。
- 任务执行走 asynq：`knowledge_process.go:38,1440,3816`（`ProcessDocument`/`ProcessSummaryGeneration` 均为 `asynq.Task`）。
- 后台生命周期：`internal/background/{lifecycle.go,run_notices.go,memory_inbox.go}`。
- 四态/重试：asynq 自带重投 + `automation_scheduler` 的 misfire 宽限。

## 6. 【C1/C2】agent 循环与停止条件 —— **有，10+ 独立刹车**
- 主循环：`internal/agent/engine.go:772-816` —— `for e.withinIterationBudget(state.CurrentRound) || e.allowSteerOverrun { … runReActIteration … switch outcome }`。
- 一轮定义（think→act→observe）：`engine.go:853-867 runReActIteration`；模型调用 `:970 callLLMWithRetry`，工具结果回填/步骤记录见 `:1103-1116`。
- 预算：`engine.go:544-554 withinIterationBudget`（`MaxIterations<0` 无限），默认 20（`agent/const.go:26-27`）。
- **停止条件族**（可独立判定，正是我们缺的）：
  1. 达到 max iterations（`:773`）
  2. 模型给出最终答案（`iterOutcomeBreak`，`:811-812`）
  3. 上下文取消/用户停止（`:776-787`，会 salvage 已有工具结果）
  4. 连续多轮 `length` 截断（`:1030-1064`，`maxConsecutiveLengthRounds`）
  5. 卡死循环：连续同内容无工具（`:1069-1096`，`maxRepeatedResponseRounds`）
  6. 工具失败连击（`guards.resetFailedToolCallStreak`）
  7. 轮次耗尽后**强行综合答案**：`finalize.go:248+ handleMaxIterations`
  8. steer 超限（`engine.go:109 maxSteerOverruns`、`:1248-1252`）
  9. 协作子任务失败即中断（`:1060,1091,828`）
- 持久化：引擎**跨轮无状态**，历史每轮从 DB 重建（`engine.go:33-39` 注释 + `checkpointSink`/`ContextCheckpointSink` `:75-77`）。

## 7. 【A6/A7】记忆 —— **有，且是我们最该抄的整块**
存储：`internal/application/service/memory/`（service.go 1344 / extract.go 1071 / consolidate.go 519 / vector.go 308 / search.go 140 / recall_trace.go 301）。DB 表 + 向量列（`types.MemoryItemEmbedding`，`vector.go:110-117`）。
- 分类：5 类 `profile/preference/fact/task/interest`（`types/memory.go:24-35`），常驻块 vs 按需召回（`:108-127`）。
- 状态：`active/superseded/archived/pending`（`types/memory.go:44-56`）——**矛盾不删，改 superseded 并留时间戳**。
- **溯源**：`Origin`（explicit/extracted/manual，`:38-42`）+ `SourceSessionID/SourceMessageID` + `ValidFrom/InvalidAt`（`consolidate.go:286-296`）。
- **检索**：词法 + 向量 **RRF 融合** `vector.go:233-257 fuseRankings`（`1/(rrfK+rank)`，`rrfK=60`），召回链路 `recall_trace.go:233-301`（`vectorFanout = maxItems*4`，最少 20）。
- **语义门槛**：`minCosine=0.5`（`vector.go:31-39`）——低于门槛不进榜，避免"全召回"。
- **老化/容量**：每日 `consolidateInterval=24h`（`consolidate.go:16-20`）→ `ExpireOverdue` 归档过期任务（`:129-137`）、`demoteStaleTasks` 45 天没提的任务降权（`:54-57,200-224`）、`mergeRedundant` 用 LLM 合并近似重复并 supersede（`:231-303,453-461`），上限 200/2000（`types/memory.go:103-105,457-461`）。
- 跨会话召回：`SearchMemory` 主动查询（`search.go:39-140`，硬上限 5 条/600 rune）+ 每轮 `Recall` 注入。

## 8. 【D1–D5】界面
- D1 技术栈：**Vue3 + Vite**（`frontend/package.json:3-5,13-14` `vue-tsc`），axios / xterm / @novnc / docx-preview。（注意：不是 React）
- D2 布局：SPA 多视图 `frontend/src/views/{chat,knowledge,agent,automation,platform,organization,artifacts,integrations}`（`frontend/src/views`）。
- D3 状态可见性：**强** —— agent 中间步骤树 `types.AgentStep`（`engine.go:1103-1116`）+ 事件流 `internal/event` + 记忆召回 trace（`recall_trace.go:13-25` 结构体含 lexical/vector/outside_pool/mode）+ langfuse span（`memory/search.go:60-67`）。
- D4 多工作区：多租户/多知识库/多 agent/组织平台页（`views/organization,platform`），但无"可停靠多工作区画布" → **部分**。
- D5 主题：`frontend/src/assets/theme/theme.css` + `useTheme.ts` + `chat-hljs-dark.less` / `chat-timeline-theme.less`，有明暗主题与密度。

---

## 9. ⭐ 最值得抄的 3 条机制

### ① 归一化加权 RRF（混合检索融合）
```
机制：weighted RRF 后用理论最大值归一化到 [0,1]，让混合分与纯向量分/纯 BM25 分在同一把尺子上可比
位置：internal/application/service/knowledgebase_search_fusion.go:157-221（公式 :176,:199-204）；
      单路归一化 knowledgebase_search_fusion.go:62-80,115-155；配置 types/retrieval_config.go:28-37,100-107
为什么好：原始 RRF 上限≈0.016，会让混合命中永远输给单路结果，且把 rerank 基础分/MMR 相关项饿死；
         归一化后"双榜第一=1.0、单榜第一=权重"，下游 rerank/MMR 才有可用的分差
我们抄到哪：A6/A7 记忆检索融合层（我们的记忆元 12 场景/31 边接入 top-k 融合处）
```

### ② 记忆"supersede 而非 delete" + 老化闭环
```
机制：矛盾/合并产生新条目时旧条目标 superseded 并留 valid_from/invalid_at；每日 consolidate 做过期归档+降权+LLM 去重
位置：internal/application/service/memory/consolidate.go:129-137（过期）、:200-224（45天降权）、:231-303（LLM 合并 supersede）；
      types/memory.go:44-56（状态机）、:103-105（容量上限）；vector.go:31-39（minCosine 门槛）
为什么好：我们判 A6/A7「无/部分」正缺这个——有溯源、有冲突消解、有 TTL/老化，且旧记忆可解释"何时被什么取代"
我们抄到哪：A7 记忆老化器 + A6 溯源字段（给 31 条边加 origin/valid_from/invalid_at/superseded_by）
```

### ③ RAG 流水线 = 链式 Plugin + 自适应切块 tier 回退
```
机制：每个检索/重排阶段实现 Plugin 接口按事件挂到 EventManager 洋葱链；切块按文档画像选 heading/heuristic/recursive/legacy tier，tier 被 validator 拒就自动降级
位置：chat_pipeline/chat_pipeline.go:9-78（Plugin/EventManager）；各阶段 Register 如 search_parallel.go:80；
      chunker/strategy.go:17-62（tier 链 + 每 tier ValidateChunks 回退）；chunker/profiler.go:12-70（DocProfile 选 tier）
为什么好：RAG 阶段可插拔、可单测、可加不加；切块不赌单一算法，坏文档自动退到能过的 tier（我们知识库/文档处理的直接模板）
我们抄到哪：知识库摄取管线（切块器）+ 检索编排（若我们把检索阶段化）
```

## 10. 我们不该抄的
- **Cube MicroVM 沙箱 + e2b 兼容层**（`internal/sandbox/*`）体量极大，绑定腾讯云 Cube/SDK（`go.mod:64`），我们形态不匹配，只借鉴"技能脚本在隔离环境跑 + 输出目录约定"这一点。
- **38 个模型 provider + 向量库矩阵**（`internal/models/providers/*`、`application/repository/retriever/{qdrant,weaviate,opensearch,milvus,...}`）是对多租户商业化的过度覆盖，我们不需要。
- **4,986 行的 `knowledge_process.go`** 与 `knowledge_faq_import.go` 2,499 行——巨型文件，别照抄结构；只抄其中"切块→嵌入→索引→(可选)摘要/问题生成"的阶段划分。
- **agent/operations/catalog 的 Swagger 编译白名单**很聪明，但依赖完整 OpenAPI/审计/RBAC 体系，我们暂无同等 HTTP 面，抄不动。
- 它的 `chat_pipeline` 插件是**同进程、共享中间态**的，无隔离；若我们要"可卸载第三方插件"，不能以此为准，需另找（dify/nocobase 型）。

---

### 附：维度速判（详见 `_cells/WeKnora.json`）
A1有 A2有 A3有 A4有 A5有 A6有 A7有 A8有 A9部分 A10有 A11有 A12部分 A13有 A14有 A15有 A16有
B1部分 B2部分 B3有 B4部分 B5有；C1有 C2有 C3有 C4有 C5有；D1有 D2有 D3有 D4部分 D5有。
