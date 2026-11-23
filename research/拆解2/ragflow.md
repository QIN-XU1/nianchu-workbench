# ragflow 拆解（v2 · 可抄实现视角）

> 目标：细拆 `D:\refs\ragflow`，只回答「我们能抄哪个文件、抄哪几行、解决我们哪个问题」。
> 纪律：每条结论带 `文件:行号`；没找到就写「未找到」，不猜。

---

## 1. 定位与规模（1 段）

**一句话**：一个 RAG 引擎服务端——文档解析/切块 → 向量+全文混合检索 → 知识库问答 / agentic RAG（带工具的检索 agent）→ agent 画布运行，外层还有多 IM 通道与多存储引擎适配。

- 证据（身份）：`README.md:5` 指向 `infiniflow/ragflow` 的 logo；`git remote = https://gh-proxy.com/https://github.com/infiniflow/ragflow.git`，HEAD `44127398`，提交日期 `2026-11-17`。
- 证据（工程）：`go.mod:1` `module ragflow`、`go.mod:3` `go 1.27`；`web/package.json` 是 Vite 前端。
- 规模：任务给 6,168 文件；实测 `*.go` 3,252 / `*.tsx` 1,003 / `*.ts` 688，主语言是 **Go**（不是 Python——任务描述里的「Python + TS」与这份 Go 重写不符，以代码为准）。
- star：**未找到**（本机为离线 Git 仓库，无 star 字段；`web_search` 因 API 余额不足不可用，未编造）。

## 2. 架构骨架

顶层目录 → 职责：
- `cmd/`：进程入口。`cmd/ragflow_server.go:24-45` 装配 DB/engine/kvrocks/storage，`cmd/ragflow_server.go:50-57` 按 `ServerType` 分离 deepdoc 推理服/ingestor/syncer。
- `internal/parser/`：纯解析与切块算子（PDF/DOCX/XLSX/Markdown/HTML/音频… + `chunk/` 切块）。
- `internal/ingestion/`：生产级解析流水线（parser dispatch → chunker → embedding → 写索引），按「组件」编排。
- `internal/service/`：业务服务（检索 `nlp/`、切片 `chunk/`、数据集/文档、memory、mcp…）。
- `internal/dao/` + `internal/engine/`：持久层（MySQL/GORM）与检索引擎适配（ES / Infinity / OceanBase / Vastbase / ClickHouse）。
- `internal/agent/`：agent 画布组件、工具、DSL、sandbox、retrievalbridge（agent 侧检索桥）。
- `internal/agentic_rag/`：agentic RAG（带工具、决策、编译知识、引用的检索 agent）。
- `internal/harness/`：一个独立、通用的 agent 运行时内核（ReAct/图/检查点/中间件），近似 eino/langgraph 的自研实现。
- `web/`：React + Vite 前端。

**依赖方向与强制**：
- 存在**单向约束的自动化守卫**：`internal/ingestion/arch_test.go:38-47` 定义 `forbiddenPackages`（`dao.DB`、`engine.Get*`、`kvrocks.Get`），`arch_test.go:55-77` 是白名单（每条需 reviewer 签字），`arch_test.go:79-84` 的 `scanRoots` 用 Go AST 扫描 `internal/ingestion`、`internal/service`；编排层不得直接摸进程级单例，必须从 `cmd/server` 装配点显式注入。该测试由 `lefthook.yml` 的 pre-commit/CI 钩子执行。
- 单一事实源：`internal/agent/runtime/registry.go:17-24` 注释明确 `DefaultRegistry` 是唯一注册表（旧的双 map 已删，因为会导致 `RegisteredNames()` 返回残缺集合）。

**核心/插件边界**：没有「插件」这一层（见第 3 段），扩展靠**编译期注册表** + **import 期 init() 注册**；边界靠上面的 AST 架构测试与包分层（parser→ingestion→service→dao/engine）强制。

## 3. 【A12】插件 / 扩展机制（重点）

**结论：这份 Go 版没有运行时插件发现/装载器；所谓「插件」退化成编译期组件注册表 + 一张静态表。**

- 明确证据：`internal/service/plugin.go:19-24` 直接写「Python 版从 `agent/plugin/embedded_plugins/llm_tools` 用 pluginlib 动态发现；**Go server 没有 runtime Python loader，embedded 集合被镜像成静态表**；要加插件就往 `embeddedLLMTools` 追加」。`plugin.go:78` `ListLLMTools()` 只读这个静态表。
- 扩展点=注册表：`internal/agent/runtime/registry.go:68-76` 定义 `Registry` 接口（`Register/Lookup/NamesByCategory/Names`），`104-121` `Register` 拒绝空名、拒绝空 metadata、拒绝重名；`125-134` `Lookup` 大小写不敏感懒查。
- **怎么发现**：没有扫描。靠各组件包 `init()` 调 `Register`——`internal/agent/component/registry.go:48-71`「Intended to be called from init() in each component's <name>.go file」；`internal/agent/component/registry.go:69-71` 把 legacy `Factory` 适配成 `runtime.ComponentFactory`。工具侧是硬编码 map：`internal/agent/tool/registry.go:36` `var registry = map[string]Factory{...}`（该文件 1,160 行，几乎全是手工 build 函数）。
- **怎么校验**：`runtime/registry.go:109-113` 三选一判空（Version/Inputs/Outputs 全空则拒），`116-118` 重名拒；metadata 结构 `registry.go:55-59`（Version/Inputs/Outputs）用于 API 出「组件目录」而不实例化。工具参数校验在各自 build 函数里手写（如 `agent/tool/registry.go:306` 起逐字段）。
- **怎么装载**：同进程、直接 Go 调用，无动态 import、无子进程、无沙箱（仅 `code_exec` 工具有 sandbox，见第 4/8 段）。`runtime/registry.go:171-176` `DefaultRegistry` 是进程级单例，`init()` 竞态先注册者胜。
- **贡献点**：能往宿主加 ①agent 组件（画布节点，`CategoryAgent`）、②ingestion 组件（`CategoryIngestion`，`runtime/registry.go:37-41`）、③agent 工具（`tool/registry.go`）、④LLM 工具元数据（`plugin.go` 静态表）。
- **隔离**：没有隔离。插件代码与宿主同进程同内存，拿得到 `gorm.DB`（架构测试只禁止编排层直取单例，不禁止组件持 db 句柄）。
- **热插拔**：**没有**。无安装/卸载/启用/禁用 API，无状态存储；增删组件=改 Go 代码重新编译。`plugin.go:24` 甚至要求「append to embeddedLLMTools」即改源码。

→ 与「Everything is a Plugin」的成熟形态差得远；对我们 A12 的价值是**反面教材**：静态表 + init 注册无法支撑插件生态。

## 4. 【A13】MCP / 工具接入

- **MCP client**：`internal/mcp/client/mcp_client.go`（869 行）。支持两种传输：`18-30` 注释 + `51-52` 常量 `TransportStreamableHTTP="streamable-http"`（spec 2025-03-26）与 `TransportSSE="sse"`（legacy）。发现流程 `FetchTools` `89-131` → `fetchToolsStreamableHTTP` `266-301`（`initialize` → `notifications/initialized` → `tools/list`），SSE 分支 `124-125`。带 SSRF/DNS 固定：`101` `AssertMCPURLSafe`。
- **MCP server**（反向，把 ragflow 暴露给外部）：`internal/mcp/server.go`（113 行）+ `internal/mcp/http.go`（140 行）+ `internal/mcp/tools.json`。
- **工具暴露给模型**：`internal/agent/tool/mcp.go:39-120` 把单个 MCP tool 包成 eino `InvokableTool`；`mcp.go:110-119` 注释说明 `inputSchema` 原样透传给 eino 的 JSON Schema 通道（不丢 enum/default/oneOf）。`InvokableRun` 回路由 `mcpclient.CallTool`。
- **UI 管理（增删改/启用禁用）**：有完整 CRUD 服务 `internal/service/mcp.go`：`CreateMCPServer:110`、`UpdateMCPServer:401`、`DeleteMCPServer:637`、`ListMCPServers:551`、`ImportServers:736`、`TestServer:884`、`ExportMCPServer:392`；handler 在 `internal/handler/mcp.go`。
- **结果回填**：MCP 工具返回字符串，进入 ReAct 循环当 tool message（见第 6 段 `react_loop.go:162-169`）。

→ A13 是这份仓库里**少数完整成熟**的能力，值得抄「MCP 管理 CRUD + tools/list 发现 + SSRF 防护」。

## 5. 【A11】调度 / 后台任务

- **定时/常驻**：
  - `internal/syncer/scheduler.go:74-104` `Run` 起 NATS 监听；`128-160` `publishStartupTasks` 启动时扫 DB 做对账（分页 4096，`scheduler.go:31`）；`162-199` 用 `time.Timer` 做延迟调度 + `startHandleHeartbeat` 心跳（`106-119`）。
  - `internal/ingestion/knowledge_compile/scheduler.go:104-129` 分布式 claim/lease：`TryClaim/Claim/TouchClaim/Ack`，MySQL 事务里把 backlog→inflight（move 非 copy），`ErrClaimTokenMismatch:39` 防止被接管的旧 worker 覆写状态。
  - `internal/service/memory_extractor.go:131-164` 记忆抽取走「durable MemoryTask」：NATS 只是唤醒，状态从 `memory_task` 行读；`memory_extractor.go:62` 租约 `memoryTaskLeaseTTL = 2 * time.Minute`，`145` `Claim`，每 30s 续租（`290-306`）。
- **失败重试 / 四态**：记忆任务状态机 `memory_extractor.go:152-160`（Pending/Extracted/Stored/Completed/Failed，未知态报错）；未 settle 的投递 `MemoryTaskLeaveUnsettled` 由后续恢复（`108-109`）。
- **常驻进程**：无 systemd；进程内 loop + NATS + timer，多 server 进程（instance/ingestor/syncer）由 `cmd/ragflow_server.go:50-57` 按 `ServerType` 分工。

→ A11 「有」，且是分布式 lease 模型，超出我们目前能力。

## 6. 【C1/C2】agent 循环与停止条件

- **主循环**：`internal/harness/core/react_loop.go:115-175`，`buildReActRunFunc`（`12`）：
  - 一轮 = `model.Generate(modelMsgs)`（`144`）→ `extractToolCalls(resp)`（`155`）→ `tn.Execute(...)` 执行工具（`162`）→ 工具结果 append 回 `state.Messages`（`167-169`）。
- **停止条件（3 类）**：
  1. 无工具调用即完成：`react_loop.go:156-158` `if len(toolCalls)==0 || tn==nil { completed=true; break }`。
  2. 工具要求直接返回：`react_loop.go:171-174` `if action != nil && action.Exit { completed=true; break }`（`ReturnDirectly`，`75-81` 合并）。
  3. 迭代上限：`react_loop.go:19-22` 默认 `maxIter=10`；`177-178` 耗尽时报 `exceeded max iterations`。
  - agentic RAG 侧上限更高：`internal/agentic_rag/agent.go:125-139` `defaultMaxIterations = 120`，可由 `RAGFLOW_AGENTIC_MAX_ITERATIONS` 覆盖，最低钳到 1。
- **可续跑**：`react_loop.go:25-29` 传入 `p.interruptState` 直接从断点状态重建；`41-60` 对恢复历史做 `historyModifier`。配合 `internal/harness/graph/checkpoint/` 与 `internal/harness/core/agent_loop_checkpoint.go` 做检查点持久化。

→ C1「有」、C2「有」（三类刹车 + 状态续跑）。但注意：整体是「ReAct + 可选 Exit 工具 + maxIter」，还没到成熟实现那种 10+ 种独立刹车。

## 7. 【A6/A7】记忆 / 检索（本段最长）

### 7.1 存储形态
- 记忆不是本地向量文件，而是**塞进文档引擎索引**：`internal/service/memory.go:1182-1184` 用 `MemoryIndexName(tenant)` 做 update；写入在 `internal/service/memory_message_service.go:394-452` `embedAndSaveMessages` → `docEngine.InsertChunks(..., mem.ID, "")`（`451-452`）。
- 记忆元数据（大小/策略）落 MySQL：`internal/entity/memory.go:34-35` `memory_size default 5242880`、`forgetting_policy default FIFO`；DAO `internal/dao/memory.go:267,358`。
- 文档切片另走 `internal/service/chunk/`（向量列见 `internal/service/chunk/vector.go:50-117`）。

### 7.2 文档怎么切块（chunk 策略 + 行号）
有两条独立链路：

**(a) 通用切块算子 `internal/parser/chunk/`（可复用的小工具）**
- 策略分派：`split.go:96-107` `sentence / char / paragraph / length`。
- 句子切：`split.go:130` `sentenceBoundaries = {"。","！","？",".","!","?",";","\n"}`，`split.go:133-185` 按 boundary 切并给每块打 `language` 元数据。
- 定长窗口+重叠：`split.go:210-247`，默认 `chunkSize=256` 字符（`split.go:36`），`overlap=chunkSize-step`，rune 计长（CJK 友好），`split.go:220` `step = chunkSize - overlap`。
- 后处理合并：`postprocess.go:128-206` `mergeChunks` 贪心把小片合并到 `target_size`（默认 500 字符，`postprocess.go:52,131`），rune 计长（`postprocess.go:137-141` 注释解释为何不能用 `buf.Len()` 字节）；`postprocess.go:212-235` 过滤空/最小长度/精确重复。
- 流水线：`execute.go:23-93` `Run = preprocess → split → postprocess`（`33-77` 组装）。

**(b) 生产切块组件 `internal/ingestion/component/chunker/`（真正入库用的）**
- TokenChunker 主入口：`token.go:471-580` `mergeByTokenSize`——先按 `delimiters` 切段再按 `chunk_token_size` 合并；`token.go:503-553` 决定按分隔符切段（保留分隔符，lossless）还是整段做「超长再按句切」。
- 合并核心：`token.go:1101-1213` `mergeUnits`：`1107-1110` 先 `expandOversizedUnits` 把超长单元切到 ≤target（硬上限），`1112` `threshold = target*(100-overlapPct)/100` 为重叠预留空间，`1148-1161` 合并前对**实际拼接文本**再验 token 是否超 target（`joinSep` 可能额外增加 token），`1165-1194` 起新块时无条件带上前一块尾部重叠并按上限裁剪。
- 辅助：`common.go:119` `splitByDelim`（正则分隔、可保留分隔符）、`common.go:273` `tokenizeStr`（`tokenizer.NumTokensFromString`）。
- 其它切法：`chunker/title.go`（按标题层级/父子）、`chunker/qa.go`（问答对成块）、`chunker/one.go`（整篇一块）、`chunker/general.go`（通用）、`chunker/token.go:17-70` 顶部长注释写清「超预算单元不拆，交给 embedding/rerank 截断」的契约。
- 解析层多模态：`internal/parser/parser/audio_parser.go`、`image_media.go`、`pdf_parser_paddleocr.go`、`tableutil/table_html.go`（表格转 HTML）。

### 7.3 向量 / 关键词混合检索——**没有 RRF，是加权求和**
- 融合公式（核心）：`internal/service/nlp/retrieval.go:488` `// sim = tkWeight*tsim + vtWeight*vsim`；实现在 `reranker.go:304-308`：
  `sim[i] = tkWeight*tsim[i] + vtWeight*vsim[i]`，`tkWeight = 1 - vectorSimilarityWeight`（`retrieval.go:489-490`）。
- 权重默认：`internal/service/dataset/search.go:59-67` 默认 `similarity_threshold=0.2`、`vectorSimilarityWeight=0.3`（即关键词 0.7）、`knnTopK=1024`；`retrieval.go:128-136` 无权重时默认 0.3（纯向量才置 1.0）。
- 引擎侧融合表达式：Infinity 用 `weighted_sum`——`retrieval.go:653-667` `buildInfinityFusionExpr`，权重串 `"term,vector"`（`664`）；非 Infinity 给固定 `esFusionWeights = "0.001,1"`（`retrieval.go:679-691`），先向量召回，再由 `RerankWithKNN` 施加用户权重（`retrieval.go:674-678` 注释）。
- 关键词侧相似度：`reranker.go:329-357` `tokensToDict`——单词权重 `*0.4`，相邻二元组取 `max(c,_c)*0.6`（`345`、`353` 行）；`reranker.go:359-399` `tokenDictSimilarity` 用 **L1 归一化** `s/q`（`397` `result := s/q`，`391-395` 累加 query 权重做分母）。
- 向量侧：`reranker.go:284-286` 余弦相似度。
- 神经重排 + 归一化：`reranker.go:42-148` `RerankByModel`，`125-133` 说明不同 reranker 分数尺度不一，`168-209` `NormalizeRerankScores` 做 min-max 到 [0,1]（零方差时逐元素 clamp）。
- **RRF：全仓未找到**。对 `*.go` 搜 `RRF|reciprocal rank|rank_fusion` 0 命中；只有 `weighted_sum`。→ 明确回答：**不做 RRF，用的是 tkWeight*tsim + vtWeight*vsim 的加权和**。
- 记忆检索同样用 weighted_sum：`memory.go:1325-1332`，`memoryFusionWeights` 在 `memory.go:1546-1552`（`textWeight=keywordsSimilarityWeight`，`vectorWeight=1-that`）；默认关键词 0.7（`memory.go:1287`）。

### 7.4 有没有记忆老化 / TTL / 冲突消解（A7）——**部分（这是关键判定的修正）**
逐条查证：

1. **老化策略字段：有，但只定义/校验/持久化，未落地执行。**
   - `memory.go:84-95` 定义 `ForgettingPolicy`（仅 `FIFO`）与 `validForgettingPolicies`；`memory.go:739-744` 更新时校验；`entity/memory.go:35` 落库。
   - 但对全仓 `*.go` 搜 `forgetting_policy|FIFO|evict|memory_size`：除定义与校验外，**没有任何按 FIFO/size 真正淘汰记忆条目的代码**（命中的 evict 都是 deepdoc session pool / nats cache，与记忆无关）。→ FIFO 是「声明未落地」。
2. **容量上限：仅校验，无按大小回收。** `memory.go:50-51` `MemorySizeLimit=5242880`（5MB），`731-736` 只校验 (0,5MB]。
3. **软删除（forget_at）：有。** `memory.go:997-1034` `ForgetMessage` 置 `forget_at`（及 `forget_at_flt`）；检索默认排除：`memory.go:1263-1273` `memoryMessageNotForgottenCondition` 用 `must_not exists forget_at`，在 `1312-1316` 注入。
4. **TTL：没有「记忆条目」TTL。** 只有任务租约 `memory_extractor.go:62` `memoryTaskLeaseTTL=2*time.Minute`（这是处理任务租约，不是记忆过期）。全仓无记忆条目过期时间字段。
5. **时间有效性（冲突消解的半成品）：有。**
   - 抽取 prompt 强制每条形如 `content/valid_at/invalid_at`：`memory.go:112-125`（`SYSTEM_BASE_TEMPLATE`），`140-165` 按 semantic/episodic/procedural 分别定义 `valid_at`/`invalid_at` 语义。
   - 结构体：`memory_extractor.go:114-129` `extractedMemory{ValidAt,InvalidAt}`；落地：`memory_extractor.go:547-560` `materializeMemoryExtraction`（`invalid_at` 非法归一为空=仍有效）。
   - 但**检索只按 `valid_at` 降序**：`memory.go:1342` `OrderBy(...).Desc("valid_at")`；`memory.go:1305-1307` 只加 `status=1`；**没有对 `invalid_at` 过期做过滤，也没有 supersede/冲突裁决**（对全仓搜 `invalid_at` 仅命中 schema/字段/prompt，无过滤逻辑）。
6. **去重/衰减/向量冲突：未找到。** 无 content 级 dedup、无基于相似度的冲突合并、无时间衰减打分。

→ **A7 判定 = 部分**：有「时间窗（valid_at/invalid_at）+ 软删除（forget_at）+ 老化策略字段（FIFO/memory_size）」，但缺「自动 TTL/衰减淘汰」与「显式冲突裁决」。这比我们原先判的「无」更细：可直接抄它的**时间有效性数据模型 + 抽取 prompt**，但淘汰与裁决要我们补。

### 7.5 检索结果怎么进 prompt
- 普通知识库问答：`internal/service/kb_prompt.go:62-120` `KbPrompt(chunks, maxTokens)`：
  - token 预算 `limit = maxTokens*0.97`（`66-67`），逐 chunk 累加 `tokenizer.NumTokensFromString(entry)`，超预算就 `break`（`71-79`）。
  - 每条渲染成树形块（`97-120`）：`ID: <index>` → `├── Title:` → `├── URL:` → 元数据 → `└── Content:` + 正文；`index` 是返回引用列表里的 0 基下标，供引用 marker 使用（`93-96`）。
- 检索结果结构（带三路分数）：`kb_prompt.go:30-54` `ChunksFormat` 输出 `similarity/vector_similarity/term_similarity/document_metadata/positions` 等。
- 引用：`internal/rag/prompts/citation_prompt.md`（128 行）；agentic RAG 用行内 `[ID:n]` 句柄，由管线转成编号 marker（`conf/agentic_rag.yaml:48`）。
- **agentic RAG 的三段检索角色**（这是「agent 与检索结合」的核心）：`conf/agentic_rag.yaml:26-44` ——`grep_chunks`（POSIX 正则模式匹配，常驻）、`search_bm25_chunks`（纯词法 BM25）、`search_semantic_chunks`（纯向量语义）、`list_chunks`（深读，带前后邻居）、`navigate_tree/navigate_structure`（编译结构路由+claim 下钻）；工具实现在 `internal/agentic_rag/tool_search_bm25_chunks.go`、`tool_search_semantic_chunks.go`、`tool_grep_chunks.go`、`tool_list_chunks.go`、`grep_service.go`、`bm25_service.go`。

### 7.6 跨会话召回
- 记忆按 `memory_id` + 可选 `agent_id/session_id/user_id` 过滤（`memory.go:1299-1304`），即跨会话靠同一个 memory 作用域（agent/session/user）召回，而非全局个人记忆。
- agent 侧桥接：`internal/agent/retrievalbridge/memory.go:70-145` 把 `MemoryService.SearchMessage` 适配成 `RetrievalChunk` 供 agent 工具调用（默认关键词权重 0.7，`115-118`）。
- 对话历史：`internal/dao/conversation_history.go`；消息适配 token 预算 `internal/tokenizer/message_fit.go`。
- **注意接线是半成品**：`internal/agent/component/memory_save.go:17-46` 明确写 Go 侧记忆持久化组件仍是 stub（`ErrMemoryServiceMissing`），需要 `SetMemorySaver` 接真实现；service 层（`memory_message_service.go`）已实现 queue/embed/save，但组件层尚未接满。

## 8. 【D1–D5】界面

- 技术栈：React + Vite。`web/package.json:4` "migrated to Vite"；依赖含 `@antv/x6 ^3.1.7`、`@antv/g6 ^5.1.0`（画布/图）、`@tanstack/react-query/table/virtual`、`zustand ^4.5.2`、Radix、Ant Design icons、Lexical、Monaco。
- 布局范式：多页 + 导航分组 + 设置页。`web/src/layouts/` 有 `root-layout.tsx`、`nav-group-layout.tsx`、`settings-page-layout.tsx`。
- 页面（对应后端能力）：`web/src/pages/` 含 `dataset/ datasets/ chunk/ document-viewer/ memories/ memory/ agent/ agents/ next-chats/ next-searches/ skills/ builtin-pipeline/ dataflow-result/`。分栏式（列表+详情）为主，agent/画布用 X6/G6。
- 状态可见性：有运行态与进度——`internal/agent/canvas/run_tracker.go:54-60`（run/session 活跃键）、`internal/ingestion/service/progress_tracker.go:34-42`（`runProgress`）、`internal/observability/ingestion_log.go:18-24`（摄取事件）、`internal/service/langfuse.go:38-45`（LLM trace）、中间件 `internal/harness/core/middlewares/telemetry/telemetry.go`。前端可经 SSE/轮询看到「进行中/失败/进度%」。
- 主题/密度：`web/src/theme`、`web/src/less`、`tailwind.config.js`、Radix 组件 → 有主题与密度体系。
- 多工作区：有用户/租户/多 dataset/多 agent 概念，但「多工作区切换」更接近账号内多资源而非多 workspace 画布（`web/src/layouts/nav-group-layout.tsx`）。

## 9. ⭐ 最值得抄的 3 条机制

**① 混合检索的「加权和 + token L1 归一化」**
- 位置：`internal/service/nlp/retrieval.go:488-528`、`653-691`；`internal/service/nlp/reranker.go:273-311`（`sim=tkWeight*tsim+vtWeight*vsim`）、`329-399`（term 权重 0.4/二元 0.6 + L1 归一化）、`168-209`（rerank 分数 min-max 归一化）。
- 为什么好：我们没有真正的混合检索打分，只有稀疏「记忆元/边」。这套公式简单可控、可直接调权重（`vector_similarity_weight` 默认 0.3）、跨引擎一致（Infinity `weighted_sum`、其它引擎固定权重 + 本地重排），且**不用 RRF 也能稳定**。
- 我们抄到哪：新建/改我们的记忆检索器（对应我们 A6 的记忆打分模块），把 `tkWeight*tsim+vtWeight*vsim` 与 L1 归一化整段移植，RRF 先不上。

**② 记忆的「时间有效性模型 + 抽取契约」**
- 位置：数据模型 `internal/service/memory_extractor.go:114-129`、`547-560`；抽取 prompt `internal/service/memory.go:112-174`；检索过滤/排序 `internal/service/memory.go:1263-1273`（forget_at）、`1305-1307`（status）、`1342`（valid_at desc）。
- 为什么好：直接补我们 A7 的空白——用 `valid_at/invalid_at` 给每条记忆一个有效期，`forget_at` 软删除、`status` 生效位，让「旧事实」可被时间窗自然压下去；这是**最小成本的冲突消解雏形**（我们缺的正是这个数据模型）。
- 我们抄到哪：我们的「记忆元」schema（A6/A7）加 `valid_at/invalid_at/forget_at/status` 四字段 + 检索默认过滤 `forget_at/status`、按 `valid_at` 降序；淘汰（FIFO/size）与 invalid_at 过滤由我们自己补（它没实现）。

**③ 检索结果→prompt 的「树形条目 + token 预算 + 引用下标」**
- 位置：`internal/service/kb_prompt.go:62-120`（`KbPrompt` 0.97 预算、`formatChunkEntry` 树形块、ID 与引用下标对齐）；引用模板 `internal/rag/prompts/citation_prompt.md`。
- 为什么好：正对我们 A5「上下文压缩的邻居」——把检索片段以稳定结构（ID/Title/URL/meta/Content）注入、按 tokenizer 精确截断到预算、并让每条片段自带可解析的引用下标；既控长度又可溯源。
- 我们抄到哪：我们的上下文装配器（prompt builder），照搬 `formatChunkEntry` 结构与 `0.97*maxTokens` 截断，引用下标复用其「0 基 position」约定。

## 10. 我们不该抄的

- **编译期组件注册表冒充「插件系统」**：`runtime/registry.go` + `plugin.go:19-24` 静态表 + `tool/registry.go` 1,160 行手工 map。我们已有自己的 plugin loader，别退化成 init 注册 + 改源码加插件。
- **Python 逐位对齐的 golden/parity 负担**：全仓大量 `*_parity_test.go`、`testdata/*.golden.json`、`internal/deepdoc/parser/pdf/tool/` 对比工具——这是它为了「Go 重写与 Python 一致」付出的巨额维护成本，与我们产品形态无关。
- **多存储引擎抽象的重力**：ES/Infinity/OceanBase/Vastbase/ClickHouse 五套适配（`internal/engine/*`）导致 retrieval 里到处 `useInfinity/useOceanBase/useVastbase` 分支（`retrieval.go:492-545`）。我们单引擎就够，别复制这层复杂度。
- **记忆任务的 durable lease + NATS 全套**：`memory_extractor.go` 的 claim/续租/状态机对我们是过度设计；我们先用 DB 四态足矣。
- **超长巨型文件**：`service/chat_pipeline.go` 180KB、`engine/infinity/chunk.go` 122KB、`service/agent.go` 119KB、`cli/user_command.go` 116KB、`service/memory.go` 2,234 行——可读性差，不要照搬「大文件堆逻辑」。

---

### 附：关键证据索引（便于复核）
- 切块：`internal/parser/chunk/split.go:96-247`、`postprocess.go:128-235`、`execute.go:23-93`；`internal/ingestion/component/chunker/token.go:471-580,1101-1213`、`common.go:119,273`。
- 混合检索：`internal/service/nlp/retrieval.go:488-528,653-691`、`reranker.go:273-399,168-209`、`dataset/search.go:59-67`。
- 记忆：`internal/service/memory.go:50-51,84-95,112-174,997-1034,1263-1342,1546-1552`、`memory_extractor.go:62,114-129,547-560`、`entity/memory.go:34-35`。
- prompt：`internal/service/kb_prompt.go:30-120`、`conf/agentic_rag.yaml:26-48`。
- 循环：`internal/harness/core/react_loop.go:115-178`、`internal/agentic_rag/agent.go:125-139`。
- MCP：`internal/mcp/client/mcp_client.go:18-131`、`internal/agent/tool/mcp.go:39-120`、`internal/service/mcp.go:110-973`。
