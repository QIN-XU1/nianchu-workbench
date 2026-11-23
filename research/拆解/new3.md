# 拆解：WeKnora / craft-anything / solo-to-team-skills

> 只读源码分析。所有结论标注 `路径:行号`。读不到原文或只能从文档推断的，标「推测」。
> 分析时间：2026-11-15。三个仓库均为 main 分支快照。

## 实测数据（先摆事实）

| 项 | WeKnora | craft-anything | solo-to-team-skills |
|---|---|---|---|
| 文件数 / 体积 | 6,249 / 169.1 MB | 1,071 / 21.3 MB | 23 / 13.8 MB |
| 主语言 | Go 1.26 | Rust 1.97（edition 2024） | Markdown |
| 代码量 | Go 3,730 文件 / 846,050 行 | Rust 780 文件 / 297,959 行 | 5 个 .md 正文，约 2.4 万行内 |
| 另有 | Python 107 文件 / 20,714 行（docreader）；Vue/TS 893 文件 / 298,143 行 | — | 1 个 14.3 MB PDF（`docs/solo-to-team-value.pdf`） |
| 版本 | v0.9.0 | 0.6.1（early alpha） | 0.0.2-named |
| 许可 | MIT | MIT OR Apache-2.0 | MIT |

> 注：solo-to-team 的 14 MB 里有 14.3 MB 是那个 PDF，正文合计不到 300 KB。**它不是代码项目，是一套可执行的工作流文本。**

---

## 横向对比

| 维度 | WeKnora | craft-anything | solo-to-team |
|---|---|---|---|
| 一句话 | 企业级文档知识库 + RAG + Agent 平台 | 纯 Rust 逆向工程引擎，看懂任何东西再让 AI 仿造一个 | 一人总控多 AI 助手的协作工作流文本包 |
| 形态 | 服务端（Go）+ Web 前端 + Python 解析服务 | 桌面 App（egui）+ CLI + MCP server + WASM | 纯 Markdown 技能包，零代码零自动化 |
| 状态持有 | 租户 + 知识库 + 会话（DB 三层） | 引擎会话 + 项目目录（文件系统） | 一份人写的「派收登记行」 |
| 核心难点 | 混合检索融合与多向量库适配 | 300 个工具的注册表 + 证据账本 | 状态机怎么记才不漏项 |
| AI 用量 | 重（embedding/rerank/VLM/图谱抽取） | 中（只做「建」，检视不靠 AI） | 零 |
| 可复用度 | 高（RAG 参数与融合可直接抄） | 中（工程纪律可抄，领域太垂直） | 极高（文本直接改） |
| 成熟度 | 生产级（29 家模型厂商、10 种向量库） | 早期 alpha（README 自述） | 实验性但诚实 |

---

## WeKnora

### 一句话定位

腾讯开源的**企业级知识管理框架**：一个知识库同时支撑三条腿——RAG 问答、Agent 多步任务、Wiki 结构化整理。官方中文定位见 `README_CN.md:43`：「一款开源的、基于大语言模型（LLM）的知识管理框架，面向企业级文档理解、语义检索与智能推理场景」。

### 实测数据

- Go 3,730 文件 / 846,050 行；Python 107 文件 / 20,714 行；Vue+TS 893 文件 / 298,143 行
- 单文件最大：`internal/application/service/knowledge_process.go` 198 KB、`wiki_ingest.go` 140 KB、`tenant_skill_install.go` 103 KB
- 向量库驱动目录 10 个：`internal/application/repository/retriever/{doris,elasticsearch,milvus,neo4j,opensearch,postgres,qdrant,sqlite,tencentvectordb,weaviate}`
- Docker Compose 起 **22 个服务**（含 5 个可选向量库、neo4j、minio、redis、searxng、langfuse 全家桶 5 个、dex、mcp）：`docker-compose.yml` 的 `services:` 段实测计数

### 底层架构

**技术栈实测**

| 层 | 技术 | 证据 |
|---|---|---|
| HTTP | Gin + CORS + JWT | `go.mod:18-24`（gin-gonic/gin v1.12.0、gin-contrib/cors、golang-jwt/v5） |
| ORM / 迁移 | GORM + golang-migrate，Postgres/SQLite 双支持 | `go.mod:32`（golang-migrate/migrate/v4）、`internal/database/migration.go` |
| 队列 | asynq（Redis 后端） | `go.mod:26`（hibiken/asynq v0.26.0） |
| 前端 | Vue 3 + TDesign + Pinia + Vite | `frontend/package.json`（vue ^3.5.34、tdesign-vue-next ^1.19.2、pinia ^3.0.4） |
| 文档解析 | Python gRPC 微服务 `docreader` | `docreader/pyproject.toml`、`docreader/main.py` |
| RPC | Connect/gRPC | `go.mod:6`（connectrpc.com/connect v1.19.1）、`proto/` |

**目录结构与模块划分**

```
WeKnora-main/
├── cmd/                    程序入口
├── internal/
│   ├── handler/            HTTP 处理器
│   ├── router/             路由（routes_graph.go 等）
│   ├── application/
│   │   ├── service/        业务：knowledgebase_search*.go、knowledge_process.go、chat_pipeline/
│   │   └── repository/     retriever/{10 种向量库}+ opensearch/neo4j
│   ├── infrastructure/
│   │   ├── chunker/        分块（28 文件，核心 splitter.go 29 KB）
│   │   ├── docparser/      解析引擎注册与调度
│   │   ├── web_fetch/, web_search/
│   ├── reranking/          重排（含 MMR、图片重排）
│   ├── models/             chat/embedding/rerank/asr/vlm/providers/catalog（自动生成模型目录）
│   ├── agent/              skills/tools/sandbox/hitl/compaction/policy
│   ├── im/                 8 个 IM 渠道（feishu/slack/telegram/wechat/dingtalk…）
│   ├── sandbox/            admission/allocation/desktopscripts/workspace
│   ├── mcp/, mcpserver/    MCP 双向
│   └── types/              领域模型（retrieval_config.go 是检索参数权威）
├── docreader/              Python 解析服务（parser/ 30 个解析器）
├── frontend/src/           Vue：views 318 文件、components 187、composables 74
├── cli/ client/ miniprogram/ mcp-server/
└── docker/ helm/ deploy/ 部署
```

**数据流：谁持有状态**

三层持有，边界清楚：

1. **租户级**（`tenants` 表 JSONB 列）持 `RetrievalConfig`——检索参数是租户全局的，不是会话级的。原文：「Stored as a JSONB column on the tenants table, managed via the settings UI at `/tenants/kv/retrieval-config`」`internal/types/retrieval_config.go:12-13`
2. **知识库级**（`knowledge_bases` 表）持分块配置 `ChunkingConfig`、`EmbeddingModelID`、`VLMConfig`、`WikiConfig`、`VectorStoreID`——`internal/types/knowledgebase.go:65,87,121,275-306`
3. **会话级**（`ChatManage` 结构在管道插件间传递）持本次查询的临时态。管道是**责任链**：`EventManager.buildHandler` 把插件逆序包成 `next` 链，`chat_pipeline.go:55-73`

关键设计：检索**不持有**状态，`hybridSearchCandidates` 每次重新解析 KB、校验 embedding 模型一致性、再 fan-out（`knowledgebase_search.go:205-350`）。

**外部依赖**

- 主库：Postgres 或 SQLite（迁移脚本双写，`internal/database/`）
- 缓存/队列：Redis（asynq）
- 对象存储：MinIO / S3 / 阿里 OSS / 腾讯 KS3（`go.mod:14-16,37`）
- 向量/关键词库：10 选 1 或多选，逗号分隔 `RETRIEVE_DRIVER`（`.env.example`：`postgres / elasticsearch_v7 / elasticsearch_v8 / opensearch / qdrant / milvus / weaviate / doris / tencent_vectordb`）
- 图库：Neo4j（`NEO4J_ENABLE` 默认 false）
- 模型服务：29 家厂商（README_CN.md:63），内置自动生成目录 `internal/models/catalog/data/seed.json`
- 追踪：Langfuse（`internal/tracing/langfuse`）
- 解析：自建 Python 服务 + MarkItDown + MinerU + PaddleOCR-VL + OpenDataLoader
- 搜索：SearXNG（web search 兜底）

### 执行逻辑

**核心链路（用户输入 → ?）**

管道事件顺序在 `internal/types/chat_manage.go:386-399` 精确列出：

```
LOAD_HISTORY → MEMORY_RECALL → QUERY_UNDERSTAND → CHUNK_SEARCH
   → ENTITY_SEARCH → CHUNK_RERANK → WEB_FETCH → CHUNK_MERGE
   → DATA_ANALYSIS → INTO_CHAT_MESSAGE → CHAT_COMPLETION(_STREAM)
   （FILTER_TOP_K 与 CHUNK_SEARCH_PARALLEL 为分支）
```

对应实现文件 `internal/application/service/chat_pipeline/`：`load_history.go`、`memory_recall.go`、`query_understand.go`（19.6 KB，查询改写）、`search.go`（26 KB）、`search_entity.go`、`rerank.go`、`merge*.go`、`into_chat_message.go`、`chat_completion*.go`。

一步关键的并发设计：KB 检索与 web 检索**并发跑**，`wg.Add(2)` 两个 goroutine 各自 append 到 `allResults`（`search.go:98-122`）。

**检索/RAG 怎么做（重点）**

完整链路：`hybridSearchCandidates` → `retrieveFromStores` → `fuseOrDeduplicate` → rerank → MMR。

1. **过检索（over-retrieval）**：`matchCount := max(params.MatchCount*5, 50) * len(searchKBIDs)`，再被 `maxRetrievalPoolSize` 截断。即**每 KB 取 5 倍**，下限 50。`knowledgebase_search.go:266-272`
2. **query embedding 只算一次**，通过 `params.QueryEmbedding` 传递，避免 N 个 store 重复调 API（`knowledgebase_search.go:274-298`）——注释直说：「for N stores that means N API calls of identical input」
3. **分组扇出**：按 `(storeID, owner tenant)` 分组、每组解析绑定引擎、每组构造一次 RetrieveParams（`knowledgebase_search.go:300-305`）
4. **embedding 空间一致性校验**：跨 KB 搜索若 embedding 模型不同直接报错，否则「silently produce meaningless cross-model scores」（`knowledgebase_search.go:250-256`）
5. **向量 + 关键词分别检索**，各自成列表
6. **RRF 融合**（见下）
7. **FAQ 后处理**、Wiki boost（`wiki_boost.go`）、实体检索（`search_entity.go`）
8. **重排**、**MMR 去冗余**、**TopK 截断**

**多路召回怎么融合（这是它最值得抄的部分）**

向量与关键词各出若干列表，用**加权 RRF**：

```
RRF score = vectorWeight/(k+vectorRank) + keywordWeight/(k+keywordRank)
再除以 maxRRF = (vectorWeight+keywordWeight)/(k+1)  归一化到 [0,1]
```

`internal/application/service/knowledgebase_search_fusion.go:157-176`。三处细节值得单独记：

- **为什么要归一化**：注释写明「Raw RRF tops out near 0.016, which made hybrid hits lose to any vector-only or keyword-only result they were ranked against and left rerank's base-score term and MMR's relevance term with nothing to work with」`fusion.go:160-163`。**不归一化的 RRF 分数会低于单路分数，导致混合结果反而排不过单路**——这是个很实际的坑。
- **rank 取「任一列表中的最好名次」**，而不是拼接后的位置。`bestRanks()` 逐列表各自按分排序后取最小值，避免「第二个列表的第一名排到第一个列表所有命中之后」（`fusion.go:165-168, 225-234`）
- **多 store 时先归一化再融合**：`EngineAwareNormalizer`（`internal/application/service/retriever/normalizer.go`），注释说「RRF fusion is rank-based and immune to scale, so keyword scores pass」——但向量分数跨 store 需归一。

参数默认值全部集中在 `internal/types/retrieval_config.go`，可读性极好：

| 参数 | 默认 | 行号 |
|---|---|---|
| EmbeddingTopK | 50 | :15-16, :44 |
| VectorThreshold | 0.15 | :17-18, :61-66 |
| KeywordThreshold | 0.3 | :19-20, :68-74 |
| RerankTopK | 10 | :21-22, :76-82 |
| RerankThreshold | 0.2（范围 -10~10） | :23-24, :84-90 |
| **RRFK** | **60**（建议 30~100） | :28-31, :92-98 |
| **RRFVectorWeight** | **0.7** | :32-35, :100-115 |
| **RRFKeywordWeight** | **0.3** | :36-37 |
| MaxRequestedResults | 200 | :46-50 |

> 注释还解释了 200 上限的由来：「knowledge-search runs one search per scoped document or tag set and reranks every candidate, so an unbounded count multiplied into tens of thousands of billed rerank passages」`retrieval_config.go:47-49`。**这是按钱算出来的参数，不是拍的。**

**文档解析：支持哪些格式、用什么库**

三层解析体系，注册表按引擎名分发（`docreader/parser/registry.py:44-60`）：

| 引擎 | 格式 | 实现/库 |
|---|---|---|
| `builtin` | docx, doc, pdf, md/markdown, xlsx, xls, pptx, ppt, epub, html/htm, mhtml, xmind, jpg/jpeg/png/gif/bmp/tiff/webp | `Docx2Parser`(python-docx)、`DocParser`、`PDFParser`(pypdf/pypdfium2/opendataloader)、`MarkdownParser`、`ExcelParser`(openpyxl/xlrd/pandas)、`MarkitdownParser`、`EPUBParser`(ebooklib)、`HTMLParser`(trafilatura/bs4/lxml)、`MHTMLParser`、`XMindParser`、`ImageParser` |
| `markitdown` | md, pdf, docx, doc, pptx, ppt, xlsx, xls, csv | 微软 MarkItDown（`docreader/pyproject.toml:11`） |
| `opendataloader` | pdf | OpenDataLoader（版面分析，需 Java 11+）`registry.py:214-222` |
| `anydoc`（Go 侧） | doc, docx, docm, odt, rtf, ppt, pptx, pptm, odp, xls, xlsx, xlsm, ods, epub, csv, pdf | **在 Go 进程内解析**，CGO 绑定，`internal/infrastructure/docparser/anydoc/anydoc.go` 的 `supportedExtensions` |
| `MinerU` / `MinerU cloud` | PDF（版面/公式/表格） | `mineru_converter.go`(20.7 KB)、`mineru_v1_client.go`(19.5 KB) |
| `PaddleOCR-VL` | 扫描件 OCR | `paddleocr_vl_converter.go`、`paddleocr_vl_cloud_converter.go` |

解析器规模不小：`pdf_parser.py` 93.6 KB、`docx_parser.py` 62 KB、`markdown_parser.py` 20.7 KB。PDF 有专门的版面/图片解析，`image_resolver.go` 66.8 KB 处理文档内图片（含相对路径、远程下载、SSRF 防护测试）。

**图片/多模态**：VLM 生成图片描述并入索引（`internal/types/knowledgebase.go:708-733` 的 `VLMConfig`：`Enabled`/`ModelID`/`DescriptionLanguage`/`CustomInstructions`）；图片另行做原图向量，图片召回是**opt-in**，且「关闭开关停止图片向量召回，不自动删除已有向量」（`website-docs/03-features/05-retrieval-engines.md:26`）。

**分块策略（具体参数）**

两套配置，默认值明确：

| 参数 | 默认 | 证据 |
|---|---|---|
| ChunkSize（字符） | **512** | `config/config.yaml:45` |
| ChunkOverlap（字符） | **50** | `config/config.yaml:46`（约 10%） |
| 分隔符顺序 | `\n\n`, `\n`, `。` | `config/config.yaml:47`、`chunker/strategy.go:350` |
| ParentChunkSize | **4096** | `types/knowledgebase.go:291-293` |
| ChildChunkSize | **384** | `types/knowledgebase.go:294-296` |
| Strategy | auto / heading / heuristic / recursive / legacy | `chunker/strategy.go:19-23` |

几处工程细节：

- **overlap 上限硬保护**：`if ChunkOverlap > ChunkSize/2 → ChunkOverlap = ChunkSize/2`。注释：「if Overlap exceeds half of ChunkSize, almost every chunk is duplicate content… Cap it at ChunkSize/2 so Overlap stays a useful smoothing band rather than a near-clone of the previous chunk」`chunker/strategy.go:357-363`
- **自适应分块（tier 链）**：`Split()` 不是单一算法，而是按文档画像（`DocProfile`）选一条 tier 链，逐层尝试 + 校验，失败就下一层，最后一层是 legacy。（`chunker/strategy.go:39-72`）
- **校验器**：每层产出后用 `ValidateChunks` 检查，不 OK 就换下一层，拒绝原因记进 `TierRejection` 供调试 UI 展示（`strategy.go:44-70`）
- **标题感知**：`heading_splitter.go`(10.5 KB) + `heading_hierarchy.go` + `header_tracker.go`(9.1 KB) 维护标题层级
- **protected_spans**：保护代码块、公式等不被切断（有 `fenced_code.go`、`protected_spans_test.go`）
- **token 预算**：`tokens.go`/`budget.go` 支持按 token 而非字符限制（`TokenLimit` 字段，0 表示按字符）
- **父块/子块**：`EnableParentChild` 默认关闭；开启后小子块（384）用于 embedding 匹配，命中后返回大父块（4096）给 LLM——典型 small-to-big

**向量化与召回**

- embedding 走 `internal/models/embedding/`：有 `batch.go`、`concurrency_wrapper.go`（并发包装）、`protocol.go`、`transport.go`，支持 OpenAI/阿里/Ollama 等；模型目录里标注固定维度（如 `seed.json:572` "text-embedding-v2 (fixed 1536 dimensions)"）
- 索引抽象：`RetrieveEngineRepository` 接口，方法包括 `EngineType/Support/Save/BatchSave/Retrieve/DeleteBy*/CopyIndices/BatchUpdateChunkEnabledStatus/EstimateStorageSize`（`website-docs/03-features/05-retrieval-engines.md:68`）
- 三层包装：Repository → `KVHybridRetrieveEngine`（负责按检索类型算 embedding 写入）→ `CompositeRetrieveEngine`（**读按类型路由、写广播到全部**，见 :70-72）→ `RetrieveEngineRegistry`（双索引：byEngineType + byStoreID）
- 按需重建：某向量库启动时没起来就不进注册表，之后 `GetOrLoadByStoreID` 现场重建，带 10s 超时、singleflight 合并、30s 失败冷却、`storeGen` 代际防竞态（`05-retrieval-engines.md:74-83`）——这块是很务实的生产化处理

**重排（rerank）有没有**

**有，而且是独立可复用包** `internal/reranking/`（4 个非测试文件：`rerank.go` 14.3 KB、`passage.go` 9.7 KB、`mmr.go` 3.8 KB、`image.go` 6.9 KB）。包注释说明它是「the single rerank stage shared by the chat pipeline, the agent search_knowledge tool and the retrieval APIs」（`reranking/rerank.go:1-4`）——三个入口共用一套，避免三份实现漂移。

关键机制：

- **阈值 + 降级**：默认阈值 0.2；若阈值「高于 degradeFloor(0.3) 且把所有候选都拒了」，则按 `degradeFactor=0.7` 重试一次，但不低于 degradeFloor（`rerank.go:26-30`）
- **全拒兜底**：`DefaultFallbackMinScore = 0.15`——「Below it, returning nothing beats forcing an irrelevant result on the caller」。**但显式 scope（按 tag/文档集搜索）时兜底为 -Inf**，保留最佳候选，避免全局阈值把权威范围整个擦掉（`rerank.go:31-52`）
- **候选上限**：`DefaultMaxCandidates = 200`，理由同样是钱与延迟（`rerank.go:34-38`）
- **复合分 + MMR**：`SelectMMR` 用 `lambda*score - (1-lambda)*maxRedundancy`，`DefaultMMRLambda = 0.7`（`mmr.go:13`），冗余用 Jaccard token 重叠算，还做了 postings 倒排优化只更新有交集的候选（`mmr.go:33-56`）
- **图片感知重排**：`ImageKeepScore`——「A text reranker cannot judge what a caption leaves out; the vector can」，文本重排器拒掉的图片若向量分够高则保留，最多 `maxKeptImages` 张（`rerank.go:63-72`）
- **多供应商协议适配**：`protocol_reranker` 统一处理「超单请求上限的候选集拆分」和「把各家分数放到同一尺度」，默认批并发 4（`models/rerank/protocol.go:13-29`）
- 支持 provider：openai / aliyun / zhipu / siliconflow / jina / cohere / voyage / volcengine / lkeap / nvidia 等（`models/rerank/reranker.go:120` provider 列表 + 各专文件）

**有没有图谱/结构化知识**

**有，两条独立的线：**

1. **知识图谱**（Neo4j）：`NEO4J_ENABLE` 默认 false（`.env.example`）；`internal/application/service/graph.go`(32.9 KB) 做抽取，`graph_search.go`(7.7 KB) 做查询，`internal/agent/tools/query_knowledge_graph.go`(34.3 KB) 给 Agent 用作工具；repository 实现在 `repository/retriever/neo4j/graph_search.go`。
   抽取算法有明确权重设计：`PMIWeight = 0.6`（PMI 占比）、`StrengthWeight = 0.4`（关系强度占比）、`IndirectRelationWeightDecay = 0.5`（间接关系衰减）、权重归一化到 1-10（`graph.go:23-47`）。实体/关系抽取各限并发 4（`MaxConcurrentEntityExtractions`/`MaxConcurrentRelationExtractions`），关系抽取要求至少 2 个实体、批大小 5。
   数据结构：`GraphNode{Name, Chunks, Attributes}`、`GraphRelation{Node1, Node2, Type}`（`types/extract_graph.go`）。

2. **Wiki 类型知识库**：KB 有 3 种类型 `document | faq | wiki`（`types/knowledgebase.go:32-35`）。Wiki 不是图谱，是把文档**自动组织成页面**，有版本历史与回滚（`wiki_ingest.go` 140 KB、`wiki_ingest_batch.go` 96 KB、`wiki_page.go` 77.7 KB）。README_CN.md:53 概括为「Wiki：把文档整理成 Wiki，自动组织、知识图谱、版本回滚」。

此外还有 **FAQ 型知识库**（`FAQScoreBoost` 在重排里给 FAQ 加权，`rerank.go:56-62`）。

### 功能选取

**关键能力清单**

- 混合检索（向量+关键词）统一 RRF 融合，10 种向量/关键词后端可换
- 自适应分块（5 种策略、tier 链回退、标题感知、代码块保护、token 预算）
- 父块/子块（small-to-big）
- 重排 + MMR 去冗余 + 图片感知重排 + 阈值降级
- 多模态：VLM 图片描述、图片原图向量召回、扫描件 OCR（PaddleOCR-VL）
- 文档解析引擎可插拔（builtin / markitdown / opendataloader / anydoc / MinerU / PaddleOCR-VL），按文件类型路由（`ParserEngineRules`）
- 知识图谱（Neo4j，PMI 加权）
- Wiki 自动整理 + 版本回滚
- FAQ 知识库 + 加权
- Agent：技能安装（ClawHub/SkillHub/Git/ZIP）、沙箱（Docker/E2B/Cube）、BrowserSkill 操控本机 Chrome、MCP 双向、长期记忆（`service/memory/` 48.9 KB + `extract.go` 43.9 KB）
- 数据源同步：飞书/Confluence/GitLab/Notion/语雀/钉钉/Seafile/RSS/腾讯 IMA（`internal/datasource/connector/`）
- IM 渠道 8 个（`internal/im/`）
- 多租户 RBAC（四级角色、组织级 KB 共享、审计日志）
- Langfuse 全链路追踪
- 每个 KB 可绑定独立向量库实例（不含全局 env store）
- 站点嵌入 Widget（`frontend/embed.html`）、小程序、Chrome 插件、DSH 插件（`packages/dsh-weknora`）

**刻意没做的（从代码结构反推）**

- **没有自研向量索引算法**：全部委托给后端（pgvector/sqlite-vec/ES/Qdrant/Milvus…），自己只做「适配 + 融合」。这是清醒的取舍。
- **没有内置模型训练/微调**：只做模型目录与路由。
- **没有自研 OCR/版面模型**：接 MinerU/PaddleOCR-VL/OpenDataLoader。
- **前端不做重型可视化编辑器**：知识图谱截图（`docs/images/graph1.png`）看是只读的力导向/树状浏览，不是可拖拽编辑的图谱 IDE（此判断基于截图与 `views/knowledge` 文件清单，未见图谱编辑器组件，标**推测**）。

### 界面

**有完整前端**，`frontend/` 是 Vue 3 + TDesign。

- 规模：`frontend/src` 下 views 318 文件、utils 265、components 187、composables 74、stores 45、api 49
- 15 个视图分区：`agent/ artifacts/ auth/ automation/ chat/ creatChat/ dev/ embed/ integrations/ knowledge/ organization/ platform/ settings/ system/ toolbox/`
- 布局（据 `docs/images/knowledgebases.png` 与 `qa.png` 实看）：左侧导航栏（新对话/知识库/智能体/共享空间）+ 主工作区；知识库页是卡片网格，每张卡显示类型图标（问答/文档/图片）、条目数、更新时间；对话页是经典三段——左会话列表、中消息流、下输入框，回答里有「检索完成·引用了1篇文档」「已完成问题理解」「检索知识库」这类**过程折叠块**，正文下方有 `01-产品_中.md` 形式的**行内引用标记**，底部左下角显示模型（DeepSeek-v3.2）与租户（demo@`weknora.local`）
- 其他界面证据：`kb-chunk-edit.png`（分块可编辑）、`wiki-browser.png`/`wiki-graph.png`/`wiki-revision-history.png`（Wiki 与版本）、`rbac-*.png` 4 张、`skill-catalog.png`/`skill-sandbox-chat.png`、`langfuse.png`、`pipeline.png`
- 另有独立前端产物：`miniprogram/`（微信小程序）、`frontend/embed.html`（嵌入式 Widget）、`packages/dsh-weknora`（DSH 插件）

**界面评价（据截图）**：偏「企业后台 + 文档工具」气质，克制、留白多、信息密度不高；检索过程透明（能看到问题理解、检索、引用的分步状态）是明显优点；设计语言不新潮但清晰。

### 优势

1. **检索参数是完全可解释的工程值，不是魔法**：RRFK=60、权重 0.7/0.3、阈值 0.15/0.3/0.2、over-retrieval 5 倍、候选 200、chunk 512/overlap 50、parent 4096/child 384——全部集中且带注释说明「为什么是这个数」，可直接对照调参（`types/retrieval_config.go` 全文件、`chunker/strategy.go:357-363`）。这在开源 RAG 项目里罕见。
2. **RRF 归一化踩过坑并写进注释**：明确记录「原始 RRF 上限约 0.016，会让混合命中输给单路结果」，这个坑很多项目没意识到（`fusion.go:157-163`）。
3. **多向量库适配做得极扎实**：10 种后端 + 双索引注册表 + 按需重建 + singleflight + 代际防竞态 + 失败冷却（`05-retrieval-engines.md:66-83`）。换库不用改业务代码。
4. **重排是独立共享包**，管道/Agent 工具/API 三个入口共用；有阈值降级、全拒兜底、显式 scope 例外、MMR、图片保留（`reranking/` 全包）。
5. **财务意识贯穿设计**：MaxCandidates=200、MaxRequestedResults=200、rerank 批并发 4、query embedding 只算一次——注释里反复出现 "billed passage"/"latency"，说明是真跑过规模的。
6. **解析引擎可插拔且按类型路由**，Office 走 Go 内 anydoc（省一次 RPC），重格式走专用引擎，扫描件走 OCR。
7. **工程纪律**：大量 `*_test.go`（chunker 目录 28 文件里 15 个是测试；`splitter_test.go` 44 KB）；迁移有 SQLite/Postgres 双套测试；SSRF 有专门测试（`mineru_converter_ssrf_test.go`）。

### 缺点

1. **体量失控，可维护性风险实在**：单文件 `knowledge_process.go` 198 KB、`wiki_ingest.go` 140 KB；Go 84.6 万行 + Vue 29.8 万行 + Python 2 万行。`internal/application/service/` 一个目录塞了 200+ 文件。想改一处 RAG 行为得跨 5-6 个文件（types → service → fusion → reranking → rerank model）。这是**企业级完整度的代价**，对想「读懂并改写」的人是负担。
2. **耦合在「服务层即业务层」**：`knowledgebase_search.go` 26 KB 里混了鉴权、embedding 一致性校验、分组、扇出、超时、langfuse span、FAQ 后处理。想单独复用「混合检索」这一段，抽不出来——它依赖 `types.ChatManage`、`TenantInfoFromContext`、`access.HasKBGrant` 等。
3. **默认开启的东西偏多**：Docker Compose 起 22 个服务，`image_processing.enable_multimodal: true` 默认（`config.yaml:50`）。只想跑一个最小 RAG demo 的人会被基础设施淹没。
4. **图谱默认关闭且依赖 Neo4j**：`NEO4J_ENABLE` 默认 false，图谱检索是「独立于向量引擎体系」的另一套（`.env.example`），意味着不开 Neo4j 就拿不到图谱价值；开了又多一个数据库。
5. **Python 解析服务是第二个运行时**：Go 主服务 + gRPC + Python 3.10+ + textract + Java 11+（opendataloader）——部署面变宽。虽然后来用 anydoc（Go 内）分担了 Office 解析，但 PDF/OCR 仍依赖 Python。
6. **无自研索引算法**：好处是灵活，坏处是「检索质量上限由后端与融合策略决定」，没有针对中文/特定语料的索引级优化。
7. **产品定位略飘**：同时是 RAG 框架、Agent 平台、Wiki 工具、IM 机器人、MCP server、小程序、Chrome 插件。功能取舍上不是「刻意不做」，更像「都在做」。

---

## craft-anything

### 一句话定位

**纯 Rust 的逆向工程引擎 + AI 仿造工作台**：把任意目标（网站/桌面应用/手游/游戏/文件）拆开看懂，然后让编码 Agent 造一个自己的版本，再用工具对比原版、逐轮修正直到接近。README 自述（`README.md:21-23`）：「See how any website, app or game works, then have AI build your own version; an open-source, clean-room engine in pure Rust.」

**它做什么**（四步，`README.md:96-105`）：Study（检视原版：各宽度下的页面、代码、文件、运行方式）→ Build（编码 Agent 建新项目）→ Check（与原版对比，列出不符处）→ Ready（打开/玩/预览，或要求继续改）。

### 实测数据

- Rust 780 文件 / 297,959 行；14 个 crate + 3 个 app
- 引擎工具数：**303 个**，17 个 toolset（`docs/tools.md` 开头「**303 engine tools** in 17 toolsets」）；README 说「320 tools (300 in the engine, the rest from the AI and setup layers)」（`README.md:190`）
- 最大单文件：`ui-egui/src/project.rs` 133.8 KB、`ui-egui/src/lib.rs` 105 KB、`formats/src/sqlite.rs` 117.5 KB、`ai/src/agent.rs` 119.6 KB、`engine/src/tools/game_archive_tools.rs` 132 KB
- 版本 0.6.1，状态 early alpha；`STATUS.md` 记录基线 923 个测试通过

### 底层架构

**技术栈实测**

| 层 | 技术 | 证据 |
|---|---|---|
| 语言/工具链 | Rust 1.97，edition 2024，resolver 3 | `Cargo.toml:1-8` |
| GUI | eframe/egui 0.36（自绘即时模式） | `Cargo.toml`（eframe、egui、egui_extras 0.36） |
| JS 解析 | oxc 全家桶（parser/semantic/codegen，纯 Rust） | `Cargo.toml` oxc_* 0.153 |
| 二进制解析 | object 0.36（read） | `Cargo.toml` |
| 压缩 | miniz_oxide | 同上 |
| 并发 | rayon | 同上 |
| 剪贴板图片 | arboard | 同上 |
| 测试 | proptest、egui_kittest | 同上 |

**目录结构与模块划分**

```
crates/                          职责（取自各 crate 的 Cargo.toml description）
├── formats/    (299 rs)       纯独立文件格式解析器（无 workspace 依赖）：elf, pe, macho, csharp, java_class,
│                              plist, sqlite, pcap, firmware, zip, axml, pyc, sourcemap, bptc, swift_demangle…
├── engine/     (107 rs)       会话、项目、工具注册表（一切表面都从这里分发）、设置、任务
│   └── src/tools/             67 个工具模块，按领域：browser(119KB) game_archive(132KB) website(92KB)
│                              android(81KB) apple(86KB) adb(65KB) compare(43KB) interaction(86KB)…
├── ai/         (72 rs)        AI 后端、agent loop、crews；rebuild/ 是「仿造」核心（30 文件）
├── analysis/   (33 rs)        分析器：把解析结果转成证据
├── disasm/     (14 rs)        自研反汇编/反编译：解码、函数、控制流、引用、伪 C
├── engines/    (22 rs)        可选外部引擎适配（Ghidra、adb、Chromium、Frida、JADX…）
├── js/         (27 rs)        JavaScript / Electron / web-bundle 分析
├── evidence/   (4 rs)         证据记录、规范 id、置信度、未知项、错误契约
├── platform/   (18 rs)        进程持有、capture、sandbox、engine store
├── ui-egui/    (48 rs)        egui 界面（Beginner 与 Experienced 双模式）
├── setup/      (14 rs)        连编码 Agent：检测/计划/合并/备份/回滚/doctor
├── mcp/        (3 rs)         MCP server
└── testkit/    (18 rs)        测试辅助与合成样本构造
apps/
├── craft-anything/            桌面 App（5 rs，薄壳）
├── craft-anything-cli/        CLI（12 rs）
└── craft-anything-web/        WASM 浏览器版（4 rs）
xtask/                         构建/工具表生成（cargo xtask tools）
vendor/  packaging/               依赖与打包
```

**Rust 用在哪（这是它最核心的答案）**

不是「用 Rust 写个 App」，而是**把逆向工程的全套能力用纯 Rust 重写**，一个外部程序都不依赖：

1. **自研格式解析器**：ELF、PE、Mach-O、.NET/C#、Java class、Plist、SQLite、PCAP、固件、ZIP、AXML、PYC、SourceMap、Swift 符号还原——`crates/formats/` 299 文件，`docs/*.md` 里的 `file-formats.md` 是清单
2. **自研反汇编 + 反编译**：`crates/disasm/`，description 写明「Craft Anything's own native engine: decoding, functions, control flow, references, pseudo-C」。`ui-egui` 截图里那栏 Pseudo-C 就是它出来的
3. **自研 JS/Electron 分析**：用 oxc 解析（纯 Rust），不调 Node
4. **自研游戏资源解析**：`game_archive_tools.rs` 132 KB，覆盖多种游戏包格式
5. **WASM 化**：`apps/craft-anything-web` + 构建里提到 `craft-fonts` 交叉编译到 `wasm32-unknown-unknown`
6. **全平台打包**：AppImage/Flatpak/deb/rpm/tar.gz（x86_64/aarch64/riscv64）、FreeBSD、macOS、Windows

选择 Rust 的收益：单二进制、无运行时依赖、可 WASM、内存受限场景能跑（`STATUS.md` 里大量「under a 128 MiB address-space limit」的测试证明他们把这个当硬指标）。

**数据流：谁持有状态**

**文件系统持有状态，引擎持有会话**。项目目录结构（`README.md:225-228`）：

```
<project>/
├── craft.json          请求、目标、状态、历史（唯一权威）
├── capture/            从目标录到的内容
├── app/                生成的项目
├── checks/             每次与原版的对比
├── investigation.cany/ 证据
└── inbox/              待回答的问题
```

引擎侧 `Session` 持打开的目标（`core_session_show`、`core_targets_list`、`core_target_select` 这组工具就是会话操作）。证据有独立账本：`evidence/` crate 有 `canonical.rs`（规范 id）、`unknown.rs`（未知项）、`error.rs`（错误契约）。

**这个「证据 + 未知项」双账本是很值得抄的设计**：不是只记「我发现了什么」，还显式记「我还不知道什么」（`core_unknown_add`/`core_unknown_edit`/`core_unknown_verify`），并且工具返回值带 confidence、coverage、limitations（`README.md:184-185`：「Results are evidence records with their confidence, coverage and limitations」）。

**外部依赖**

- 可选外部引擎（`crates/engines`）：Ghidra、adb、Chromium、Frida、JADX——**有则用，无则用自己的实现**
- 编码 Agent（外部程序，非库依赖）：Claude Code 首选、Codex（未验证）、GitHub Copilot CLI（ACP）、Grok Build（ACP）、以及任何说 ACP 的（Gemini CLI/Qwen Code/opencode/goose/Hermes/Maki/Devin）
- 模型 API：Anthropic、OpenAI、OpenRouter、xAI、本地 OpenAI 兼容服务（`README.md:170-171`）

### 执行逻辑

**核心链路（用户输入 → ?）**

```
用户在 Make 页选目标类型（网站/App/游戏/从零）
  → 填地址 + 选 Clean room / Deep + 写「你要什么」
  → Start
  ├── brief.rs(38KB)      把自然语言请求变成建什么
  ├── study.rs(25KB)      调用检视工具研究原版（不靠 AI，工具就是引擎）
  ├── stacks.rs(16KB)     选技术栈
  ├── Agent loop          交给外部编码 Agent 真的写代码（ai/src/agent.rs 119KB）
  ├── check.rs(32KB)      与原版对比
  ├── screenshot.rs(27KB) 三档屏幕宽度截图对比
  ├── self_check/self_test 游戏自测、App 跑一遍
  ├── question.rs(29KB)   需要人决策时弹问题卡
  └── activity.rs/notes/feed 进度与人类可读的状态
```

`crates/ai/src/rebuild/` 是这个链路的实现（30 个非测试文件）：`mod.rs` 87 KB、`tools.rs` 51.6 KB、`website.rs` 46.6 KB、`check.rs` 31.6 KB、`runs.rs` 30.2 KB、`question.rs` 29.1 KB。

**两档模式是它的关键产品决策**（`README.md:132-150`）：

- **Clean room（默认）**：**不读原版内部**——不读代码、文件、页面源码。只用「访客能看到的东西」：截图、可见文本、量出的布局/颜色/字体/间距、展开的菜单。**会看内部的工具直接拒绝，并告诉你怎么开 Deep**。
- **Deep**：全部工具放开，读代码读文件，Ghidra 可选。

代码上这不是 UI 开关而是工具级准入：工具被拒绝时说「how to turn on Deep mode」，说明有个 policy 层在 `engine` 里拦。`README.md:143-147` 同时诚实说明：**Clean room 是「提供什么/拒绝什么」的规则，不是操作系统沙箱**，它不隔离你的机器；你跑的编码 Agent 仍以你的身份行事。

**检索/RAG 怎么做**

**没有 RAG，没有向量库，没有 embedding。** 这是三家里唯一完全不含 RAG 的项目。

它的「检索」是**结构化工具查询**：303 个工具，每个是「给我看 X」——函数列表、字符串、交叉引用、调用图、HAR 记录、数据库表、包清单。AI 的角色是**调度这些工具并读结果**，不是语义召回。README 说得很直白：「No AI is needed to inspect」（`README.md:89`，指检视本身是纯工具）。

这个取舍值得注意：**当「检索」的答案是确定性的（某个函数在哪、某字符串被谁引用），用工具比用向量检索更准**。向量检索适合「语料里关于 X 说了什么」这类模糊问题。

**文档解析（支持哪些格式，用什么库）**

不是「文档解析」，是**文件格式解析**，而且是自研的（`crates/formats/`）：

- 可执行：ELF(51 KB)、PE(50.9 KB)、Mach-O(38.2 KB)、Swift 符号还原(91.3 KB)、Go 二进制(58.7 KB)
- 托管：C#/.NET(68.8 KB)、Java class(43.2 KB)、PYC(44.3 KB)
- 打包：ZIP(40 KB，含 ZIP64 边界处理)、tar/cpio(38.7 KB)、SQLite(117.5 KB)、AXML(45.8 KB)、plist(43.5 KB)、PCAP(87.3 KB)、固件(76.1 KB)、SourceMap(41.9 KB)、BPTC 纹理(41 KB)
- 校验：`verify.rs` 74.7 KB

无 LibreOffice、无 textract、无 Python——纯 Rust。

**分块策略 / 向量化 / 召回 / 重排**

**全部不适用**（无 RAG）。唯一沾边的是「大结果分页」：大结果先回摘要，再用 `core_evidence_browse` 翻页（`README.md:184-185`）——这是**上下文预算管理**，不是分块索引。`DefaultMaxCandidates` 这种概念在这里不存在。

### 功能选取

**关键能力清单**

- 303 个工具（17 toolset），每个同时是 **MCP 工具 + CLI 子命令 + Agent 可调工具**（三面一源）
- Clean room / Deep 双模式，工具级准入
- 自研反汇编 + 伪 C 反编译（不依赖 Ghidra，Ghidra 是可选增强）
- 目标覆盖面：原生程序、.NET、Java、Android、Apple、Electron/JS、网站、固件、抓包、数据库、游戏资源（`README.md:190-192`）
- 证据账本 + 未知项账本 + 置信度/覆盖率/局限三元组
- 四步闭环：Study → Build → Check → Ready，带逐轮修正（`--rounds`）
- 对比检查：页面三档宽度截图、游戏自测、App 跑一遍
- 人工介入：问题卡 + 审批卡（批准规则外的命令）
- 双界面：Simple（四个步骤的极简流）vs Advanced（完整工作台：函数/字符串/伪C/反汇编/hex/调用图/证据/未知项/任务/日志/Agent 控制台）
- 多 Agent 后端（Claude Code 首选 + ACP 适配多家）
- WASM 浏览器版（文件不出本地）
- `doctor` 自检安装/Agent/引擎

**刻意没做的**

- **不做向量检索**：明确不用 RAG 做检视（见上，这是设计选择而非缺失）
- **不内置 AI 模型**：不托管、不代理模型账号。Claude Code 用你自己的登录，且「Craft Anything never sees or handles your account」（`README.md:161-163`）
- **不自建操作系统沙箱**：Clean room 只是工具准入规则，明确不隔离机器（`README.md:143-147`）。这是**主动承认边界**，不是遗漏
- **不内嵌 Ghidra/Frida/adb**：作为可选外部引擎适配（`crates/engines`），有则用无则退化到自研实现
- **不做成 SaaS**：全本地，项目落 `Documents/Craft Anything`

### 界面

**有，egui 即时模式桌面 GUI**，明确双模式。

**Simple 模式**（据 `docs/images/make.png` 实看）：左侧项目列表（example.com 标 Interrupted、Snake 绿点、Notes 标 Needs you），主区一张卡三步走——①「What do you want to recreate?」四个大按钮（A website / An app / A game / Nothing—start fresh）+ 地址输入 + Clean room vs Deep 两栏对比选择；②「Say what you want」大输入框（预填 "Recreate this website"）；底部「Built by: Automatic (Claude Code)」下拉 + Start 按钮 + 保存位置提示。整体深色、圆角、留白大，像一个给非程序员用的生成器。

**Advanced 模式**（据 `docs/images/workbench.png` 实看）：典型逆向工作台三栏——左「Functions 16」可搜函数树带地址与 size（`operator_key_pressed` 高亮、`percent_key_pressed` 选中）；中上标签页 Pseudo-C / Disassembly / Hex / Graph / Source / Network / Result，正文是带行号的伪 C 代码（能看到 `double v = v / 100.0; // the whole trick` 这种注释）；右侧栏「Inspector / Evidence / Unknowns」三个 tab，Evidence ledger 显示 3 条，每条带「Worked it out / Seen it」状态徽章；下方是 Agent 面板（Agent/Jobs/Log 三 tab）+ 对话记录 + "Ask the agent..." 输入框。顶栏显示 Deep 模式徽章、AI 后端（AI · Claude）、Simple/Advanced 切换。

**界面评价**：Beginner/Advanced 双模式做得比多数工具彻底——不是同一界面藏按钮，而是两套信息架构（一个三步骤向导，一个三栏工作台）。E**evidence 作为一等公民放右栏**，是很好的设计（结论永远连着出处）。深色主题 + 等宽代码，视觉上偏工程化、不花哨。

### 优势

1. **「每个工具 = MCP 工具 = CLI 命令 = Agent 工具」三面一源**：`README.md:175-182`、`docs/tools.md` 生成表。这一条就把「GUI 能用、脚本能用、Agent 能用」统一了，避免三套实现漂移。它的架构规则第 3 条明写「Headless first; flows are tools」（`docs/ROADMAP.md`）。
2. **能力自持、可选增强**：自研解析/反汇编/反编译，Ghidra/Frida/adb/Chromium 都只是「可选外部引擎」（`crates/engines` description：「Adapters for optional external engines…」）。没有外部程序也能工作。
3. **证据账本 + 未知项账本**（`crates/evidence/`）：不只记「已知」，还结构化管理「未知」，工具返回必带 confidence/coverage/limitations。这是**给 AI 的输出加可审计性**，比「模型说它看懂了」强得多。
4. **Clean room / Deep 是产品级取舍，且诚实**：默认不给看内部，且明说这不是沙箱、不隔离机器。很多工具会含糊其辞，它没有。
5. **架构规则写得很硬**（`docs/ROADMAP.md` Architecture rules）：「Traits plus a registry, not enums」「Data over code for catalogues」（栈/构建配方/模型 id 与价格放 TOML，用 `include_str!` 嵌入，不写进 `match` 或 prompt）——**目录数据与代码分离**，这是可 fork 性的关键。
6. **测试与资源上限当硬指标**：`STATUS.md` 里大量「under a 128 MiB address-space limit」「output cap」「byte budget」的测试记录，说明它对不可信输入的资源耗竭做了防御，并有回归用例。
7. **诚实的状态记录**：`docs/pitfalls.md` 公开记录自己踩的坑（合并了没跑 CI 的 commit、PR 只合了 claim 等），`STATUS.md` 逐条写「What works, and how it was checked」+ 明写「未验证」的部分。这种自曝在开源项目里少见。
8. **可 WASM**：浏览器版让「文件不出本地」成立。

### 缺点

1. **早期 alpha，覆盖面宽但深度未经真实用户验证**：`STATUS.md` 2026-11-09 版反复出现「Windows and real Go GUI capture have not been run」「only the macOS path verified」「has not been verified on a real install」（指 Codex）。**大量功能只有 macOS 上验过**，Windows/Linux 路径存疑。
2. **交付强依赖外部编码 Agent**：没有 Claude Code 等就「building needs a coding agent signed in on your computer」。它不是自足的——**核心的 Build 那一步不归它管**。这也意味着结果质量很大程度取决于那个 Agent。
3. **体量与复杂度惊人**：298 K 行 Rust、14 crate、303 工具、单文件 133 KB。要贡献得先读懂 `engine` 的工具注册表与 `evidence` 契约。`docs/ROADMAP.md` 里那套 claim/owner/status 流程，本身就是为了驯服这个复杂度——侧面证明它确实难。
4. **Clean room 的保证是「承诺」而非「机制」**：它自己在 `README.md:143-147` 承认不是 OS 沙箱、不隔离机器、Agent 仍以你的身份行事，且「Which of an agent's own tools Craft Anything can refuse differs by agent」。所以 clean room 的实际强度取决于你用的 Agent。**这是法律/合规意义上的模糊地带**（它服务的是「仿造」场景）。
5. **无 RAG 意味着「模糊问题」答不好**：问「这个项目整体在讲什么」这类需要语义汇聚的问题，工具式检视不如向量检索。它的定位是「看代码怎么工作」，不是「读文档找答案」。
6. **UI 自绘（egui）的代价**：无障碍支持、系统级交互一致性、复杂文本排版都比原生/Web 弱（此判断基于 egui 的通用特性，非实测截图缺陷，标**推测**）。
7. **对「仿造」的伦理/法律边界没有工程化约束**：它给了 Clean room 作为默认，但没有许可证检测、没有「目标是否允许仿造」的检查。这在 README 里也没讨论。

---

## solo-to-team-skills

### 一句话定位

**一套「一个人总控多个 AI 助手」的协作工作流文本包**：4 个技能 + 1 个模板 + 1 个示例，解决四个真实痛点——派出去的活没人收、说做好了其实没核过、写给新手的步骤只有自己看得懂、同一个坑踩两遍（`README.md:262` 原话）。

关键认知：**它不是软件，没有一行代码，没有任何自动化**。它自己反复声明这点——「本包只有技能文字和模板，没有任何自动化」（`skills/ops-case-notes/SKILL.md:60`）、「**不要**把派工、叫醒、回执写成已有自动化；本包不提供、也不暗示这类自动化」（`README.md:242`）。

### 实测数据

- 23 文件 / 13.8 MB，其中 `docs/solo-to-team-value.pdf` 一个文件就 14.3 MB（所以正文不到 300 KB）
- 4 个技能，每个只有一个 `SKILL.md`（10-12.5 KB）；其中 1 个额外带 `templates/登记行模板.md`
- 正文规模：`ops-case-notes` 168 行、`beginner-ops-writing` 175 行、`evidence-before-done` 155 行、`dispatch-accept-verify` 139 行，模板 86 行
- 版本 0.0.2-named，MIT

### 底层架构

**目录层级（这就是「单人→团队」的载体）**

```
solo-to-team-skills-main/
├── plugin.json                     通用插件清单（agent-plugins.org schema 1.0.0）
├── .claude-plugin/                 Claude Code 插件结构（marketplace.json + plugin.json）
├── .codex-plugin/plugin.json       Codex 插件结构
├── .agents/plugins/marketplace.json
├── skills/                         ← 核心：4 个平行技能目录
│   ├── dispatch-accept-verify/     派→收→验（协作底座）
│   │   ├── SKILL.md
│   │   └── templates/登记行模板.md   ← 唯一有子目录的技能
│   ├── evidence-before-done/SKILL.md    交活前证据（核）
│   ├── beginner-ops-writing/SKILL.md    新手操作说明写法（表达）
│   └── ops-case-notes/SKILL.md          脱敏运营记录（案例）
├── templates/task-register-line.md 包级模板（与技能内模板同结构）
├── examples/walkthrough-meeting-notes/  完整跟做示例
│   ├── input.md / output-ok.md / output-missing.md / register-lines.md / README.md
└── docs/solo-to-team-value.pdf     14.3 MB（体积几乎全在这）
```

**关键观察：4 个技能是「按流程阶段切」而不是「按领域切」**。

| 技能 | 管流程哪一段 |
|---|---|
| `dispatch-accept-verify` | 分工 + 交接（派出去怎么登记、到点怎么查、怎么收） |
| `evidence-before-done` | 核对（说「做好了」之前要什么证据） |
| `beginner-ops-writing` | 表达（须人做的步骤怎么写） |
| `ops-case-notes` | 参照（真实弯路与仍未证明的部分） |

三支可串联成一条流水线（`beginner-ops-writing/SKILL.md:161` 明写）：「先写清步骤（本技能）→ 派人跟做并收回来（`dispatch-accept-verify`）→ 交活前核过再宣称完成（`evidence-before-done`）」。

**单个 skill 的内部结构（统一的 7 段式，这是可复制性的核心）**

四个 SKILL.md 全部遵循**同一个骨架**：

```markdown
---
name: <kebab-case 技能名>
description: >-
  <触发条件：什么时候用> + <不用于什么：显式排除> + <与同仓其他技能的分工>
---
# <中文标题（一句口语）>

属于开源包 Solo to Team · 一人成队（solo-to-team-skills）。   ← 归属声明

## 含什么        ← 这个技能包了什么（3-5 条）
## 适合谁        ← 目标用户画像（3 条）
## 怎么用        ← 编号步骤（1-2-3-4-5）
## 依赖          ← 需要什么；哪些可选；手动复制注意什么
## 示例          ← 指向具体文件/章节
## 验证到哪      ← ★ 这个技能被验证到什么程度、什么没证明

---
一句话：**<核心口诀，加粗中文>**

## 0./1./2. …（正文各节，带编号）
## 反面案例（泛化）   ← 常见错误的长相
---
## 来源与许可 / 借鉴说明  ← ★ 改写自哪里、什么许可、改了哪些
```

**两个最值得抄的结构设计**：

1. **`description` 里写「不用于什么」+「与邻居的分工」**。比如 `evidence-before-done` 的 description 结尾：「不用于：第三方独立复核清单（另用审核类技能）；动手前讲方案（另用方案确认类技能）。与同仓 ../dispatch-accept-verify/ 分工：那支管收回来，本支管核过再宣称完成。」（`evidence-before-done/SKILL.md:9-10`）。这是**防技能误触发**——多数技能只写「何时用」，不写「何时不用」，导致边界模糊、技能互相抢活。
2. **`## 验证到哪` 是必填段落，且必须写「没证明什么」**。例：「公开包承诺的是**可照做的做法**；是否减少漏接、是否少催，见运营记录『仍未证明』栏，本技能正文不下效果结论。」（`dispatch-accept-verify/SKILL.md:45`）。**每个技能都主动声明效果未经证明**——这在技能市场里是逆人性的坦诚，但正是它最值钱的地方。

**数据流：谁持有状态**

**一份人或 AI 都会写的人类可读记录**。没有数据库、没有状态机代码，核心状态就是一行文本，格式固定为：

```
待收｜任务标识：________｜什么活：________｜谁在干：________｜谁来收：________｜
预计交时：____-__-__ __:__｜到点谁查：________｜若不在线：授权接替人________／
下次可查时间__:__｜结果放哪：________｜做到什么算完：________｜建议下一棒技能：（可空）
```

`templates/task-register-line.md:27`。**只追加不改写**（`task-register-line.md:3`）——状态变了就追加一行，原行字段原样保留。这是 event-sourcing 的极简版：**用 append-only 的人类可读日志做状态机**。

状态机一共 5 个状态 + 3 个过程行（`task-register-line.md:7-15`）：

| 状态 | 意思 | 还在未完清单里？ |
|---|---|---|
| `待收` | 派出了，没人确认接下 | 在 |
| `已接单` | 执行人确认接下，成果没到 | 在 |
| `已收到成果` | 交付物到了，**还没核** | 在（待核） |
| `已验收` | 核过，可交下一棒或关闭 | **不在** |
| `已取消` | 有权的人说不做了 | **不在** |
| `续期`/`升级`/`退回` | 过程行 | 仍不在退出条件内 |

**这是整个包最精巧的设计**：把笼统的「已接」拆成三个状态。原因写在 `dispatch-accept-verify/SKILL.md:101`：「一个笼统的『已接』容易同时指『接下了活』和『收到了成果』，扫描时一排除，没做完的活就漏出清单」。

**外部依赖**

- 无代码依赖。「任意能让助手读写共享记录（文档、议题、聊天置顶、仓库文件）的协作环境即可」（`dispatch-accept-verify/SKILL.md:33`）
- **但不是零依赖**：依赖宿主平台的「定时检查/跨助手发消息/叫醒/群聊/共享文件读写」——它明确列了能力对照表（`ops-case-notes/SKILL.md:135-141`）：宿主有则自动，没有则**改用人工**（登记行写检查人，检查人每次醒来第一件事查所有未完项）
- 名称级验证覆盖 8 个宿主（Codex/WorkBuddy/DeepSeek Harness/Cursor/CodeBuddy/Kimi Work/千问办公/Grok Bot），Claude Code「结构已备，走通待补」（`ops-case-notes/SKILL.md:147-150`）

### 执行逻辑

**核心链路（用户输入 → ?）**

没有代码链路，是**人的操作链路**（`dispatch-accept-verify/SKILL.md:25-29`）：

```
1. 安装技能目录（与同仓其他技能并列）
2. 每次派出「平台不会主动通知完成」的活 → 开跑当下按模板登记一行「待收」
3. 到点（预计时间+5 分钟，按任务时限调整）
   → 登记里写明的检查人查【所有未完项】（不只查没人接的）
   → 按状态处理（没人接/接了没交/交了没核）
   → 检查人不在线 → 按登记的接替人或下次可查时间查
4. 执行人确认接下 → 追加「已接单」
   成果到了约定位置 → 追加「已收到成果」
   按 evidence-before-done 核过 → 追加「已验收」→ 才往下交或关闭
5. 授权/放行一出 → 派活人【当场】叫下一棒开工
   → 收到「已接单」或开工证据才算接住
```

**检索/RAG：不适用。** 没有任何检索机制。

**最核心的机制：三个状态分离 + 五条铁规**

1. **等待结束 ≠ 成果回来**（`task-register-line.md:18`）：后台命令停了、对方说「好了」，都要**去结果该在的地方看**；看见了才写「已收到成果」。
2. **到点查所有未完项**，不只查「过点没人接」的（`task-register-line.md:19`）——因为漏项往往发生在「接了没交」「交了没核」这两段。
3. **新预计 ≠ 正式改期**（`task-register-line.md:21`）：执行人报的新时间只是新预计，原承诺保留、按原承诺算逾期；有权的人确认后才能追加「正式改期：已由某某确认」。
4. **到点谁查要写具体的人**，且写明「他不在线时谁接替 / 下次可查时间」。实际查晚了照实记，**不写「已兜住」**（`task-register-line.md:20`）。
5. **只有「已验收」或「已取消」才退出未完清单**（`dispatch-accept-verify/SKILL.md:109`）。

**`evidence-before-done` 的核心：一条铁规 + 五步 + 一张对照表**

铁规：「没有对得上当前版本的有效证据，就不说『做好了』」`SKILL.md:59`。

「有效证据」定义（`SKILL.md:61-65`）：亲手拿到的、且核的版本/范围/环境与要说的这句话对得上。**可复用**（上次核过、之后没改没失败环境没换）；**要补核**（有改动/失败/换环境，只补核受影响部分）；**不算证据**（别人说好了的、「应该没问题」的）。

最有价值的是那张「想说什么 → 要什么证据 → 不够的」对照表（`SKILL.md:85-97`），覆盖 11 种交付物：

| 想说 | 要的证据 | 不够的 |
|---|---|---|
| 文档做好了 | 用对应软件打开，或转图片逐页看过：字、表格、页码、中文字体 | 「生成成功」提示；文件存在 |
| 视频做好了 | 从头播过，至少抽看开头/中间/结尾；分辨率码率比过 | 导出进度 100% |
| 图片做好了 | 按原尺寸打开看过 | 只看了缩略图 |
| 数字算对了 | 换一种办法重算，总数和分项对得上 | 算过一次 |
| 链接能用 | 点开过，内容就是要的那篇 | 搜索结果里看见过 |
| 电脑问题修好了 | 按原出问题的步骤再走一遍；会被自动更新改写的要写明下次改写时间 | 改了设置；「理论上应该好了」 |
| 东西放到某处了 | 去那个位置看见了，文件名、大小、份数都对 | 复制时没报错 |
| 已放行的发送成功了 | 在收件或目标那一端看得到 | 工具返回「成功」 |
| 别的助手说做完了 | 自己去看改动和成品 | 对方的报告 |
| 委托方的要求全做到了 | 重读原始要求和修改记录，逐条打勾 | 「主要部分做完了」 |

**这张表是三家所有材料里最可直接搬走的东西**——它把「幻觉式完成」的每一种形态都堵了一遍。

**文档解析/分块/向量化/召回/重排：全部不适用。**

### 功能选取

**关键能力清单**

- 派收登记行模板：10 种行的可复制格式（待收/已接单/已收到成果/已验收/退回/已取消/续期/升级/叫开工/点名完）
- 5 状态 + 3 过程行状态机，append-only
- 三状态分离（接单/收到成果/验收）防漏项
- 「新预计 vs 正式改期」区分
- 到点查所有未完项（含接替人、下次可查时间）
- 开工/收工点名（扫自己派出且未完结的全部）
- 「不自建定时任务」的克制条款（`dispatch-accept-verify/SKILL.md:119-121`：到点靠登记加醒来先查，不为「快好了」建定时任务、闹钟或后台循环脚本；负责人亲口要求才建，建了写明到期自删）
- 交活证据对照表（11 类交付物）
- 「核对本身不能变成危险动作」（`evidence-before-done/SKILL.md:126-130`：只用只读、本地可逆的办法；不为了「试试能不能发出去」真发一条，不为测试下单，不为核对删东西）
- 新手操作说明写法 7 原则 + 自检清单
- 虚构示例 + 不合格写法对照（`beginner-ops-writing/SKILL.md:104-151`）
- 脱敏运营案例（3 个真实漏项 + 每个都写「仍未解决」）
- 平台依赖能力对照表（有则自动 / 无则人工）
- 8 宿主安装与调用验证记录

**刻意没做的（这是它最强的地方）**

- **不做自动化**：反复三次声明没有自动派工/叫醒/回执（`README.md:242`、`ops-case-notes/SKILL.md:60,152`）
- **不承诺效果**：每个技能都有「验证到哪」写明「尚未证明错误率下降或催办减少」；`ops-case-notes/SKILL.md:92-95` 明列「没有对照组，没有同口径的前后发生率统计」；`README.md:248` 再重复一次
- **不编造数据**：`README.md:250` 原话「不编造本仓库 star 数或本包使用人数」
- **不把教学示例当实测**：`README.md:238` 「主示例 walkthrough 是作者写好的教学样例，不算实测」
- **不越界**：`beginner-ops-writing` 明说不管派活、不管核证据；`evidence-before-done` 明说不管独立审核、不管方案确认
- **不给效果注水**：C3 案例（内部评分高但成品观感漏了）明写「这条漏项被记进复盘，作为『末端验收仍会漏』的例子保留，**没有被包装成已解决**」（`ops-case-notes/SKILL.md:121`）

### 界面

**无界面**（纯 Markdown，无前端）。它的「界面」是那份 append-only 的登记行文本 + 8 个宿主的原生技能面板。

### 优势

1. **状态机设计精准**：把「已接」拆成接单/收到成果/验收三态，直接针对「漏项发生在哪」这个真实问题。设计动机写在正文里（`dispatch-accept-verify/SKILL.md:101`），不是拍脑袋。
2. **append-only 的人类可读日志**：零工具依赖、零数据库，任何宿主都能用，换平台方法带得走（`ops-case-notes/SKILL.md:168`「方法换平台可以带走，平台的自动化带不走」）。这是**最低技术依赖的协作协议**。
3. **「验证到哪」段落的诚实度罕见**：四支技能每支都写明自己没证明什么；运营记录里 3 个漏项都附「仍未解决」；README 专门分「已知的/还没证明的」两栏。**在一个满是「提升 300%」的赛道里，这种克制本身就是差异化。**
4. **description 写「不用于什么」+ 邻居分工**：解决技能互相抢活/误触发的通病，可直接抄进我们的技能规范。
5. **对照表式知识**：11 类交付物 × 3 列（想说/要的证据/不够的）——表格比散文可执行得多，且能被直接检查。
6. **示例带「不合格写法对照」**：不只给正例，给反例并解释为什么错（`beginner-ops-writing/SKILL.md:126-151`），教学效果远好于只给正例。
7. **诚实的来源标注**：`evidence-before-done` 末尾完整保留 MIT 原文版权声明并写明改写自 obra/superpowers 哪个提交（`SKILL.md:144-146`）。合规做法可参考。
8. **明确区分「自建定时任务」的边界**：不为「快好了」建闹钟（`dispatch-accept-verify/SKILL.md:119-121`）——这条克制条款避免了很多「AI 助手自己建一堆定时任务把自己淹了」的问题。

### 缺点

1. **纯人工，规模化上限低**：所有状态靠人和 AI 记得去写、记得去查。「到点靠登记加醒来先查」——**如果没人记得查，整套机制失效**。它自己承认这点（`ops-case-notes/SKILL.md:106`「交的一方会不会每次自己先核，还靠习惯，没有强制手段」）。
2. **效果完全没有量化**：两周余、3 次复盘、无对照组、无前后发生率。它诚实地说明了，但这意味着**你无法预先判断它对你会不会有效**。
3. **登记行的书写成本不低**：一行有 10 个字段（`task-register-line.md:27`）。高频派活时，「开跑当下就登记」很可能变成负担，然后被跳过——**机制的自律成本是它最脆弱的地方**。
4. **正文有重复**：同一观点在「含什么/怎么用/正文/模板」里出现 4-5 次（如「只追加不改写」「等待结束≠成果回来」）。对 AI 读取是冗余 token，对人类阅读是啰嗦。
5. **14.3 MB PDF 占体积 96%**：`docs/solo-to-team-value.pdf` 与正文无关，纯营销物料混在仓库里，克隆成本高（对 23 文件的项目显得不成比例）。
6. **8 宿主「验证」深度不均**：README 自述「部分宿主经受阻重跑或退回修订后才通过」「部分宿主未保留技能加载的原始轨迹」「不表示每家四个技能都逐一被调用」（`README.md:238`）。所以「支持 8 家」这个说法偏乐观。
7. **清单文件字段极简**：5 个清单（`plugin.json`、`.claude-plugin/{plugin,marketplace}.json`、`.codex-plugin/plugin.json`、`.agents/plugins/marketplace.json`）只有 name/version/description/author/license/keywords/skills 这几个字段，没有触发条件、没有能力声明、没有依赖版本约束。技能的市场可发现性全靠 `description` 文本。
   （注：审计过程中一度以为清单中文乱码，经 `read` 工具复核——文件本身是正确的 UTF-8（`plugin.json:5`：「Skills for human-led AI teams. 一个人统筹 AI 团队的协作技能包。」），乱码来自 PowerShell 控制台编码，**非文件缺陷**。）

---

## 值得抄的

按「可直接落地」排序：

### 1. RRF 归一化 + rank 取「各列表最好名次」（WeKnora）

`knowledgebase_search_fusion.go:157-176, 225-234`。两条都有非显然的理由：

- 原始 RRF 上限约 `(0.7+0.3)/(60+1) ≈ 0.016`，**低于单路归一化分数**，导致混合命中在跨路比较时输给单路命中，且让后续 rerank 的 base_score 项和 MMR 的相关性项「没有东西可用」（注释原话）。解法：除以 `maxRRF = (vW+kW)/(k+1)` 归一到 [0,1]。
- rank 不能取「拼接列表里的位置」，要取**该 chunk 在任一单列表中的最好名次**，否则第二个列表的第一名会排到第一个列表所有命中之后。

**默认参数可直接用**：k=60、vector 0.7 / keyword 0.3。

### 2. 检索参数集中 + 每个数字带「为什么」

`internal/types/retrieval_config.go` 一个文件 132 行声明全部检索默认值，每条注释解释取值理由与量纲（阈值 0-1、rerank 分 -10~10、RRFK 建议 30-100）。对照我们常见的「参数散落在 20 个文件、没人知道默认值是多少」，这是基础设施级的好习惯。

### 3. 阈值降级 + 全拒兜底 + 显式 scope 例外（WeKnora rerank）

`reranking/rerank.go:26-52`：阈值 0.2；若「阈值 > 0.3 且把所有候选都拒了」→ 按 0.7 倍降级重试但不下 0.3 地板；若仍全拒 → 最佳候选需 ≥0.15 才保留（**宁可返回空也不强塞不相关结果**）；**但显式 scope（按 tag/文档集）时兜底为 -Inf**，避免全局阈值把权威范围整个擦掉。

这个「三重保护」直接解决「用户明明圈定了范围却搜不出东西」这个高频体验灾难。

### 4. 「已接」拆三态 + append-only 登记行（solo-to-team）

`dispatch-accept-verify/SKILL.md:99-109` + `templates/task-register-line.md`。**任何多 Agent 编排系统都该抄**：

- `待收 / 已接单 / 已收到成果 / 已验收 / 已取消` 五态，只有后两态退出未完清单
- 追加不改写，原承诺字段永久保留
- 「新预计 ≠ 正式改期」，逾期按原承诺算，确认后才改期
- 到点查**所有**未完项，不只查「没人接」的

对应到我们的实现：任务板应有独立的 `dispatched / accepted / delivered / verified / cancelled` 状态，且 `delivered`（收到东西）与 `verified`（核过）**必须分开**——当前很多编排系统把这两个合并成「完成」，正是漏项的根源。

### 5. 「想说什么 → 要什么证据 → 不够的」三列对照表（solo-to-team）

`evidence-before-done/SKILL.md:85-97`，11 类交付物。**这是我们做 Agent 自检/交付确认最缺的一块**：把「完成」的定义按交付物类型具体化，而不是笼统一句「已确认」。

尤其这几条对 AI 极有针对性：「只看了缩略图」「导出进度到了 100%」「工具返回成功」「搜索结果里看见过」「对方的报告」「代码检查通过」——每一条都是 AI 最典型的自我欺骗方式。

### 6. 「验证到哪」作为技能的必填段落（solo-to-team）

每个 SKILL.md 必须有 `## 验证到哪`，写明「公开包保证什么」+「没证明什么」+「见哪节仍未证明」。**建议直接写进我们的技能规范（skill spec）作为 lint 规则**：没有该段落 = 技能不合规。

### 7. description 里写「不用于什么」+ 邻居分工（solo-to-team）

`evidence-before-done/SKILL.md:9-10`。技能描述的三段式：**何时用 + 何时不用 + 与谁分工**。直接解决技能误触发与职责重叠。

### 8. 证据账本 + 未知项账本（craft-anything）

`crates/evidence/`（canonical.rs / unknown.rs / error.rs）+ 工具返回必带 confidence/coverage/limitations。**「我还不知道什么」是结构化数据，不是丢失的信息**——这点对 Agent 自我认知极重要，值得作为我们工具返回值的强制字段。

### 9. 「每个工具 = CLI = MCP = Agent 工具」三面一源（craft-anything）

`docs/tools.md` 由 `cargo xtask tools` 生成。一套注册表分发到四个表面。避免「GUI 一套、脚本一套、Agent 又一套」的漂移。

### 10. 目录数据与代码分离（craft-anything）

`docs/ROADMAP.md` Architecture rules 第 2 条：栈、构建配方、模型 id 与价格放 TOML，用 `include_str!` 嵌入，**不写进 `match` 或 prompt**。可 fork 性的关键。

### 11. 自适应分块 tier 链 + 校验回退（WeKnora）

`chunker/strategy.go:39-72`：按文档画像选策略链（heading → heuristic → recursive → legacy），每层产出后校验，不过就下一层，拒绝原因留档供调试。比「一个 splitter 打天下」稳。

### 12. overlap 上限 ChunkSize/2（WeKnora）

`chunker/strategy.go:357-363`。一句话防住「overlap 配置成 chunk 一半以上导致几乎全文重复」。这是参数校验里最容易漏、后果最隐蔽的一条。

---

## 我们要超过的（怎么验证）

每条给出**可验证的验收标准**，不是口号。

### 1. 超过 WeKnora 的「可维护性」

**它的短板**：Go 84.6 万行，单文件 198 KB，`application/service/` 一个目录 200+ 文件，改一处 RAG 行为要跨 5-6 个文件。

**我们要做到**：RAG 全链路（解析→分块→向量→融合→重排）每一环是**独立可替换的接口 + 独立可测的包**，且「换掉融合策略」不需要改任何其他文件。

**怎么验证**：
- 取一个具体需求「把 RRF 换成 Weighted Rerank 融合」，记录改动文件数。**目标：≤ 2 个文件（实现 + 注册）**
- 单包单测覆盖率门槛（如 chunker、fusion、rerank 各自 ≥ 80%），CI 卡住
- 最大单文件 ≤ 2000 行，CI lint 卡住

### 2. 超过 craft-anything 的「跨平台真实性」

**它的短板**：`STATUS.md` 反复出现「Windows … have not been run」「only macOS verified」。298 K 行 Rust 大量功能只在 macOS 验过。

**我们要做到**：核心功能在 Windows 上有真实回归（因为这正是我们的主场）。

**怎么验证**：
- 每个核心能力的验收记录必须写明**在哪个平台、跑出什么输出**，不接受「实现完成」作为验收
- CI 三平台矩阵（Windows/macOS/Linux）跑核心路径，Windows 为必须绿
- 功能清单里每一行有「已验证平台」列，未验证的显式标注

### 3. 超过 solo-to-team 的「执行力」

**它的短板**：全部靠人或 AI 自觉登记、自觉到点查，无强制手段（自认 `ops-case-notes/SKILL.md:106`）。效果完全没量化。

**我们要做到**：**它的状态机 + 我们的强制执行**。三态分离（接单/收到成果/验收）保留，但状态转移由系统保证，不靠人记得写。

**怎么验证**（这是最容易做量化对比的一条）：
- 构造 N=20 个「派出去但故意不通知完成」的任务，跑我们的系统，统计**漏收率**（未进入 verified/cancelled 就消失的任务比例）。目标：0，且系统能主动报出「还有 3 件未完，最早 14:30 到点」
- 构造 10 个「执行方声称完成但交付物不符」的任务，统计**假完成拦截率**（`delivered` 被 verified 阶段打回的比例）。目标：10/10 全部打回并说明缺什么
- 对照组：同一批任务用纯文本登记行 + 人工执行，比较漏收率与恢复时间。**这就是它缺的那个「同口径前后发生率」**
- 断点恢复：杀掉进程后重启，未完清单必须完整恢复（append-only 日志天然支持，但要实测）

### 4. 超过三家的「诚实度」——把它变成机制而非文风

**它们的共同优点**：solo-to-team 每支技能写「验证到哪」；craft-anything 有 `Unknowns` 账本和 `STATUS.md` 逐条「怎么验的」。

**但它们都是「作者愿意写」**，不是系统强制。

**我们要做到**：**证据与未知项是数据结构的必填字段，不是文档里的自愿段落**。

**怎么验证**：
- 任何「完成」声明若缺少 `evidence` 字段（含：怎么核的、核的哪个版本、核的人/工具）→ 系统拒绝该声明
- 任何工具返回若缺少 `confidence` / `coverage` / `limitations` → schema 校验失败
- 抽查 20 条任务的历史记录，**100% 能回答**「当时凭什么叫它完成了」（回溯测试）
- 反向测试：故意提交一个「没核就报完成」的声明，系统必须拦下并指出缺什么证据

### 5. 超过 WeKnora 的「部署成本」

**它的短板**：Docker Compose 22 个服务；Python 解析服务 + Java 11+ 是额外运行时。

**我们要做到**：单二进制起服务，最小可用配置零外部依赖（嵌入式存储），需要时再逐级升级后端。

**怎么验证**：
- 冷启动到可问答的**步骤数 ≤ 2 步**、**耗时 ≤ 5 分钟**、**外部服务 0 个**
- 提供三档配置并在 CI 各跑一遍：Lite（全嵌入）/ Standard（+Postgres）/ Full（+外部向量库）
- 记录每档的实际内存占用与首次查询延迟

### 6. 超过 craft-anything 的「上下文预算管理」

**它的做法**：大结果先回摘要，再用 `core_evidence_browse` 翻页；有 output cap、byte budget。

**我们要做到 + 超过**：不只是「分页」，而是**主动告诉模型「你还没看到什么」**。

**怎么验证**：
- 构造一个超大结果集（如 10 万行），验证返回的是摘要 + 明确的「已省略 N 行，可用 X 翻页」而不是静默截断
- 统计「因为上下文被截断而导致的错误结论」次数。目标：0（靠显式的截断告知，而不是靠模型猜）

### 7. 单一来源的工具定义（超过三家的共同短板）

**他们的做法**：craft-anything 做到了（`cargo xtask tools` 生成）；WeKnora 的 MCP/CLI/HTTP 是三套（`mcp-server/`、`cli/`、`handler/` 分开）；solo-to-team 无代码不涉及。

**我们要做到**：工具定义单一来源，自动生成各表面。

**怎么验证**：
- 新增一个工具，**只改一个文件**即可在 CLI / MCP / HTTP / Agent 四个表面都可用
- 有 CI 检查：工具清单文档与代码注册表一致性（不一致则失败）

---

## 附：三句话总结

- **WeKnora 抄参数与融合**：RRF 归一化、7 个检索默认值、阈值三重保护、parent-child 4096/384 + chunk 512/50。但别抄它的体量。
- **craft-anything 抄纪律**：三面一源、证据+未知项双账本、目录数据与代码分离、Clean room 这种「产品级取舍 + 诚实说明边界」。但别抄它的平台覆盖乐观度。
- **solo-to-team 抄状态机**：五态 + append-only + 「已接」拆三态 + 「新预计≠正式改期」+「验证到哪」必填段。但要把它的人工自觉换成系统强制——**这就是我们超过它的地方，而且可以用漏收率/假完成拦截率两个数字验证**。
