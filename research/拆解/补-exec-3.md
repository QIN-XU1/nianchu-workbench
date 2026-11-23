# 补拆：WeKnora RAG 全链路 / luanyujia 寄生机制

> 只读分析。路径前缀：`A=` `D:\refs\WeKnora\WeKnora-main`，`B=` `D:\refs\luanyujia\luanyujia-workbench-main`。
> 未找到的条目显式写「未找到」。

---

## WeKnora

### RAG 全链路

WeKnora 的 RAG 不是一条线性函数，而是**"离线建库"+"在线管道"两段**，在线段是一个事件驱动的插件链（`chatpipeline`），每个插件注册在某个 `types.EventType` 上，用 `ActivationEvents()` 声明（`A\internal\application\service\chat_pipeline\chat_pipeline.go:11-51`），`buildHandler` 把这些插件串成 `next()` 责任链（同文件 `:54-61`）。

**离线段（上传→存储）**

| 阶段 | 位置 / 机制 |
|---|---|
| 上传 | handler 层 + `internal/application/service/knowledge*.go`（未逐行展开，本轮聚焦解析之后） |
| 解析 | 交给独立 Python 服务 `docreader`（gRPC，`A\docreader\proto\docreader.grpc.pb.go`）或云端引擎；引擎注册表见 `A\internal\infrastructure\docparser\engines.go` |
| 分块 | Go 侧主路径 `A\internal\infrastructure\chunker\strategy.go:37` 的 `Split()`；Python 侧兼容路径 `A\docreader\splitter\splitter.py` |
| 向量化 | `A\internal\models\embedding\`（`embedder.go`/`protocol.go`/`ollama.go`/`batch.go`），走 OpenAI 兼容协议 + Ollama |
| 存储 | 检索器插件化，10 个引擎目录见下 |

**在线段（查询→生成）**

管道插件清单（目录即顺序线索）：`query_understand` → `query_expansion` → `search` / `search_parallel` / `search_entity` → `merge_*`（merge / merge_expand / merge_faq / merge_history / merge_overlap）→ `rerank` → `filter_top_k` → `into_chat_message` → `chat_completion(_stream)`，另有 `extract_entity`（图谱）、`wiki_boost`（Wiki 加权）、`memory_recall`/`memory_affinity`（记忆召回）、`web_fetch`、`data_analysis`、`citation_sources`、`references`。
目录：`A\internal\application\service\chat_pipeline\`。

检索主入口是 `HybridSearch`（`A\internal\application\service\knowledgebase_search.go:183`），内部按"存储组"扇出（`knowledgebase_search_fanout.go:138 retrieveGroup`），超时统一由 `multiStoreRetrieveTimeout()`（同文件 `:247`）控制，结果在 `:366` 交给 `fuseOrDeduplicate`。

> **关键设计判断**：WeKnora 把 `query_expansion` 和 `extract_entity`（图谱）放在**检索之前**，即"先扩写/先抽实体，再多路检索"，所以同一个 query 会展开成多个检索目标，这也是下文 `DefaultMaxCandidates = 200` 存在的原因。

### 文档解析

解析能力**双层**：Go 侧 `internal/infrastructure/docparser/`（本地/云引擎）+ Python 侧 `docreader/parser/`（真正的格式解析器）。

**支持的格式**（`A\docreader\parser\registry.py:155-176`，默认引擎表）：

| 格式 | 解析器 |
|---|---|
| jpg/jpeg/png/gif/bmp/tiff/webp | `ImageParser`（`:155-156`） |
| docx | `Docx2Parser`（`:162`） |
| pdf | `PDFParser`（`:164`） |
| md | `MarkdownParser`（`:165`） |
| xlsx | `ExcelParser`（`:167`） |
| pptx | `MarkitdownParser`（`:169`） |
| epub | `EPUBParser`（`:171`） |
| html / htm | `HTMLParser`（`:172-173`） |
| mhtml | `MHTMLParser`（`:174`） |
| xmind | `XMindParser`（`:175`） |

另外存在多个**可选引擎**，每个引擎一张扩展名表，请求的引擎不支持该类型时自动降级到支持它的引擎（`registry.py:38-114`，"Engine '%s' does not support '%s', falling back"）：`markitdown`（pptx/csv/pdf/docx/xlsx 全走它，`:184-193`）、`OpenDataLoaderParser`（仅 pdf，版面分析，需 Java 11+，`:200-205`）。

**"用什么库"的实情**：
- PDF/Word 的**主战场其实不在 Python 原生库**，而在外部版面引擎：`A\internal\infrastructure\docparser\` 下有 `mineru_v1_client.go`、`mineru_layout.go`、`mineru_cloud_converter.go`（MinerU）、`paddleocr_vl_layout.go` / `paddleocr_vl_converter.go`（PaddleOCR-VL）、`opendataloader_parser.py`、`weknoracloud_http_reader.go`。
- 通用兜底是 **markitdown**（微软的 document→markdown）与 `/markitdown_parser.py`。
- 图片走 `image_parser.py` + `image_preprocess.py`，即 OCR/VLM 路径而非纯文本。
- `docreader/parser/` 里还有 `docx2_parser.py`（docx→docx2 结构）、`xlsx_repair.py`、`docx_merge.py`、`xlsx_merge.py`、`docx_merge.py`、`ppt_convert.py`、`excel_convert.py`、`source_locator.py`（源定位，供引用回链）。

> 精确的 Python 依赖包名（如 pypdf 还是 pdfplumber）**未找到**：`docreader` 下没有 `requirements.txt`，依赖声明位置未定位。

### 分块策略

**主路径在 Go**（`A\internal\infrastructure\chunker\`），Python 的 `splitter.py` 已自我标注为兼容路径（`splitter.py:25-26`："The Go splitter is now the production path; this ..."）。

**默认参数**（`A\internal\infrastructure\chunker\splitter.go:105-106`，注释在 `:83-103`）：
```
DefaultChunkSize    = 512   // 字符；≈100–130 英文 token / ≈300 中文
DefaultChunkOverlap = 80    // ≈15% of 512
```
注意 `:94-97` 的迁移说明：早期存在三个不同的 overlap 默认值（Go 64 / `knowledge.go` 50 / Python 80），现已统一。且 **overlap=0 是保留语义**（wiki-only KB、原子 FAQ 依赖真正零重叠，`:98-103`）。

**自适应分层（这是核心，不是简单定长切）**：
- `Split()` 是公开入口（`strategy.go:37`），先 `resolveChainWithProfile`（`:297`）算出一条**分层链**，再逐层尝试，每层跑 `ValidateChunks`，不过就降级到下一层，最后兜底 legacy。
- 策略枚举（`strategy.go:21-26`）：`auto / heading / heuristic / recursive / legacy`。显式指定时直接给出固定链（`:300,302,306,310`）：
  - heading → `[TierHeading, TierLegacy]`
  - heuristic → `[TierHeuristic, TierLegacy]`
  - recursive / legacy → `[TierLegacy]`
- 每层产出后还要过 `enforceChunkBudget`（token 预算，见下），再由 `ValidateChunks` 验收，失败原因记入 `Diagnostics.Rejected`（`strategy.go:88-125`）。这个诊断结构就是 `/chunker/preview` 调试端点的返回体（`A\internal\handler\chunker_debug.go:124 PreviewChunking`）。
- 辅助模块：`profiler.go`（文档画像，决定 auto 走哪条链）、`heading_splitter.go` + `heading_hierarchy.go` + `header_tracker.go`（标题层级切分与标题回填）、`heuristic_splitter.go`、`patterns.go` + `fenced_code.go`（代码围栏保护）、`protected_spans`（`splitter.go:146-197`，URL/代码等不可切区域）、`tokens.go` + `budget.go`（token 估算）、`validator.go`。

**overlap 怎么处理（`splitter.go:625 computeOverlap`，注释 `:602-623`）—— 这是最值得抄的一段**：
- 配置的 `ChunkOverlap` 是**硬上限，不是按字符直接截一刀**。
- 实现方式是"**语义后缀回看**"：在窗口内寻找合法语义边界（换行/段落等分隔符），`semanticOverlapLookbehind = 4`（`\r\n\r\n` 的长度，`:623`），窗口大小 = `maxOverlap + 4`（`:641`）；窗口内取**最靠左**的合法边界 ⇒ 重叠尽量大。
- 找不到合法边界 ⇒ **放弃重叠**（宁可 overlap=0，也不给一段断头话）。
- overlap 计入下一块的**总大小**（`:630` 起），所以不会因为重叠把块撑爆。
- `mergeUnits`（`:414`）在合并时保留尾部重叠，并会判断标题是否已在重叠区或下一单元里出现过（`headerAlreadyPresent`，`:549`），**避免标题重复注入**。

**parent/child 怎么切**（`splitter.go:878 SplitTextParentChild`）：
```go
parents := SplitText(text, parentCfg)          // 先用 parentCfg 切出父块
for _, parent := range parents {
    subs := mapChildrenToSource(parent, SplitText(parent.Content, childCfg))  // 父块内容再用 childCfg 切子块
    ...
    if len(subs) > 1 || (len(subs) == 1 && subs[0].Content != parent.Content) {
        parentIndex = len(newParents)          // 只有当父块真的被拆开时才保留父块
        newParents = append(newParents, parent)
    }
    for _, sub := range subs { children = append(children, ChildChunk{Chunk: sub, ParentIndex: parentIndex}) }
}
```
三个非显然的点：
1. **父块按需保留**：如果某个父块只切出一个和自身完全相同的子块，父块不入库（不浪费存储）。
2. **子块偏移要映射回文档坐标系**：`mapChildrenToSource`（`:905`）用 `parent.End - runeLen(parent.Content)` 算出父块内容在原文的起点，再把子块相对偏移加上去；父块开头的**合成表格表头**不占原文位置，因此只含该合成前缀的子块会被丢弃（`child.End <= child.Start` 过滤）。
3. **实际数值**：type 中给的是 parent 4096 / child 384，但 Go 侧常量只有 `DefaultChunkSize=512 / DefaultChunkOverlap=80`（`splitter.go:105-106`）；4096/384 应来自 `SplitterConfig` 的调用方配置（`knowledge.go` 一类的 `buildSplitterConfig`），**具体赋值行号未逐一定位**。

Python 侧 `splitter.py` 结构化确认了"先 `_split` 到小于 chunk_size，再 `_merge` 合并并带 overlap"的两段式（`splitter.py:150 _split`、`:187 _merge`），且 `_merge` 会因 header 结束而强制断块（`:229-237`）、header 过长时跳过（`:242-246`）。

### 多路召回与 RRF 归一化

**召回有哪几路**——不是固定 2 路，而是**按 (存储组 × 检索器类型) 扇出后归成两大类**：
- `classifyRetrievalResults`（`A\internal\application\service\knowledgebase_search_fusion.go:18`）只看 `RetrieverType`，分 `VectorRetrieverType` 和其他（关键字/BM25）两类；**每路保留独立列表**，注释明确说明原因：不同引擎、不同存储组、不同参数集（document vs FAQ），是并发 goroutine 的完成顺序追加的，位置只在**各自列表内**有意义。
- 存储组扇出：`knowledgebase_search_fanout.go:138 retrieveGroup`、`:196 paramsWithTopK`。
- 旁路召回：图像召回（`knowledgebase_search_image.go:101 withImageRecall`）、FAQ（`knowledgebase_search_faq.go:97 iterativeRetrieveWithDeduplication`）、图谱（`search_entity` 插件 + `graph_search.go:30`）、web_search 结果（作为 `KnowledgeSource == "web_search"` 进同一打分体系）。

**融合：三条路径，但都保证分数落在 [0,1]**（`fuseOrDeduplicate`，`fusion.go:59`，注释 `:48-58`）：
1. 只有向量 ⇒ 保留引擎原始 cosine 相似度（FAQ 阈值依赖它）。
2. 只有关键字 ⇒ `rescaleUnboundedScores` 除以本列表最大分数（`fusion.go:130`）。原因写在注释里：BM25 无上界（常 >10），会顶爆 `compositeScore` 的 `0.3*base` 项并让 MMR 退化为纯多样性排序。
3. 混合 ⇒ RRF。

**RRF 完整代码**（`fusion.go:171-223`）：
```go
func fuseWithRRF(ctx, vectorLists, keywordLists [][]*types.IndexWithScore, retrievalCfg *types.RetrievalConfig) []*types.IndexWithScore {
    rrfK := retrievalCfg.GetEffectiveRRFK()                       // :174  默认 60
    vectorWeight, keywordWeight := retrievalCfg.GetEffectiveRRFWeights()  // :175  默认 0.7/0.3
    maxRRF := (vectorWeight + keywordWeight) / float64(rrfK+1)    // :176  归一化分母

    vectorRanks  := bestRanks(vectorLists)                        // :178
    keywordRanks := bestRanks(keywordLists)                       // :179

    // :182-193 收集所有唯一 chunk；同一 chunk 优先保留向量结果的元数据（分数取更高者）
    chunkInfoMap := map[string]*types.IndexWithScore{}
    for _, r := range flattenLists(vectorLists) { /* 取 Score 更高者 */ }
    for _, r := range flattenLists(keywordLists) { /* 只在不存在时补入 */ }

    result := make([]*types.IndexWithScore, 0, len(chunkInfoMap))
    for chunkID, info := range chunkInfoMap {
        rrfScore := 0.0
        if rank, ok := vectorRanks[chunkID]; ok {
            rrfScore += vectorWeight / float64(rrfK+rank)         // :199
        }
        if rank, ok := keywordRanks[chunkID]; ok {
            rrfScore += keywordWeight / float64(rrfK+rank)        // :202
        }
        info.Score = rrfScore / maxRRF                            // :204  ← 你已知的归一化
        result = append(result, info)
    }
    slices.SortFunc(result, sortByScoreDesc)                      // :205
    // :208-221 打印前 15 条的 vector_rank / keyword_rank，便于调参
    return result
}
```

`rank` 从哪来——`bestRanks`（`fusion.go:225-236`）：
```go
func bestRanks(lists [][]*types.IndexWithScore) map[string]int {
    ranks := map[string]int{}
    for _, list := range lists {
        for i, r := range deduplicateByScore(list) {   // 每个列表先各自按分数去重排序
            if current, ok := ranks[r.ChunkID]; !ok || i+1 < current {
                ranks[r.ChunkID] = i + 1               // 取该 chunk 在所有列表中的最好名次
            }
        }
    }
    return ranks
}
```

**必须点出的两个细节**（注释里解释了，容易被漏读）：
- 归一化分母用 `(vW+kW)/(k+1)`，所以**两路都排第一的 chunk 分数正好 = 1.0**，单路命中的最好情况是 `vW/(k+1) / maxRRF = 0.7`（用默认权重时）。也就是说这里**不是**"单路第一也是 1"，混合路径下单路命中最高只能到 ~0.7。
- `rank` 是"跨列表最好名次"，**不是拼接后的位置**。注释 `fusion.go:158-161` 明说：若用拼接位置，第二个列表的最好命中会排到第一个列表所有命中之后。
- 原始 RRF 峰值只有约 0.016（`1/60`），不归一化会导致 hybrid 命中输给任何单路命中、并让 rerank 的 base 项与 MMR 的相关性项失去分辨率（注释 `fusion.go:145-152`）——这正是归一化的动机。
- 排序用 `sortByScoreDesc`（`fusion.go:93`），**同分按 ChunkID 稳定排序**，避免分数相等时结果随 map 遍历顺序抖动。

**over-retrieval（5 倍）**：`knowledgebase_search.go:269`
```go
matchCount := max(params.MatchCount*5, types.DefaultRetrievalTopK) * len(searchKBIDs)
```
即 5 倍、下限 `DefaultRetrievalTopK = 50`（`A\internal\types\retrieval_config.go:44`），再乘以知识库个数；上限由 `maxRetrievalPoolSize` 兜（`knowledgebase_search.go:17-19` 注释说明存在的理由：否则调用方给的 MatchCount 会直接放大向量库查询）。

### rerank 与 MMR

**位置**：独立包 `A\internal\reranking\`，包注释（`rerank.go:1-4`）明确它是**聊天管道 / agent 的 search_knowledge 工具 / 检索 API 三方共用的唯一 rerank 阶段**。在聊天管道里是 `PluginRerank`，只挂 `types.CHUNK_RERANK` 事件（`A\internal\application\service\chat_pipeline\rerank.go:36-38`），实际调用在 `chat_pipeline\rerank.go:122`；agent 工具侧在 `A\internal\application\service\knowledgebase_search_rerank.go:184`。都在 **融合之后、filter_top_k 之前**。

**用什么模型/服务**：`Reranker` 接口 + 多协议实现（`A\internal\models\rerank\`）：
- `reranker.go:120` 注释列出 provider：`openai, aliyun, zhipu, siliconflow, jina, generic`。
- 专用实现：`cohere`（`api/cohererank`，`reranker.go:201`）、`volcengine_reranker.go`（火山）、`lkeap_reranker.go`（腾讯云 LKEAP）、`protocol.go`（通用 HTTP 协议）、`image.go`（**能读图的 reranker**，`image.go:53` 对不支持图像的模型返回 `ErrImagesUnsupported`）。
- 装饰器链：`langfuse_wrapper.go`（链路追踪）、`llm_debug.go`（调试日志）。

**打分与阈值（可抄的工程细节，`rerank.go:21-39`）**：
- `DefaultThreshold = 0.2`、`DefaultFallbackMinScore = 0.15`：**全部被阈值刷掉时**，最佳候选若 ≥0.15 就保留，否则宁可返回空（"returning nothing beats forcing an irrelevant result"）。
- **降级重试**：阈值高于 `degradeFloor = 0.3` 却全灭 ⇒ 按 `degradeFactor = 0.7` 降阈值重试一次，但不低于 0.3。
- `FallbackMinScore(explicitScope)`（`:48`）：调用方显式指定了 tag/文档范围时返回 `-Inf`，**绝不因全局阈值把整个授权范围内的最优结果清空**。
- `DefaultMaxCandidates = 200`（`:39`）：候选上限，因为每个候选都是一次计费 passage + 一份延迟。

**综合分（`rerank.go:364-374`）—— 这是 rerank 之后的最终排序键**：
```go
func CompositeScore(r *types.SearchResult, modelScore, baseScore float64) float64 {
    sourceWeight := 1.0
    if strings.EqualFold(r.KnowledgeSource, "web_search") {
        sourceWeight = 0.95                      // 网页来源轻微降权
    }
    if r.MatchType == types.MatchTypeGraph {
        baseScore = modelScore                   // 图谱命中没有相似度基分，用模型分顶替
    }
    composite := 0.6*modelScore + 0.3*baseScore + 0.1*sourceWeight
    return math.Min(math.Max(composite, 0), 1)   // 钳到 [0,1]
}
```
即 **0.6 模型分 + 0.3 召回基分 + 0.1 来源权重**，并钳到 [0,1]——这就是为什么前面 RRF 必须归一化到 [0,1]。另有 `PreBoostScore`（`:379`）保存 boost 前的分数供绝对阈值比较。

**MMR**（`A\internal\reranking\mmr.go`）：
- `DefaultMMRLambda = 0.7`（`mmr.go:12`）。
- **相关性项就是 `lambda * results[i].Score`**（`mmr.go:51`），即直接用上游（rerank 后的 composite）`SearchResult.Score`，**不再额外算一次查询相似度**。
- 冗余项：`(1-lambda) * maxRedundancy[i]`，`maxRedundancy` 是"该候选与**已选集合**中任一条的 **Jaccard 相似度**最大值"（token 集合交集/并集）。
- 主循环（`mmr.go:50-58`）：`mmr := lambda*results[i].Score - (1.0-lambda)*maxRedundancy[i]`，取最大。
- **工程优化（值得注意）**：用**倒排 postings** 增量更新交集，而不是每轮 O(n²) 重算（`buildMMRPostings`，`mmr.go:88-120`）：`tokens` 是每个候选的 token id 列表，`offsets[t]:offsets[t+1]` 是 token t 的倒排区段，选入新条目时只遍历它的 token 更新 `intersections`，再对 `touched` 集合刷新 `maxRedundancy`（`mmr.go:64-81`）。每对只算一次交集（token 是集合去重的）。
- **短路**：`k == 1` 时完全跳过清洗与分词，只做一次线性扫描（`mmr.go:24-31`）。
- 文本来源是 `EnrichedPassage(ctx, r)`（`mmr.go:95`），分词用 `searchutil.TokenizeSimple`（同处）。

### 图谱/结构化知识

**有，而且是文档处理管线的一部分。**
- 抽取在**索引期**：`graph.go` 的 `GraphBuilder`（`A\internal\application\service\graph.go:77 NewGraphBuilder`），带 `entityMap` / `entityMapByTitle` / `relationshipMap` / `chunkGraph`（`:68-72`），并有专门的 `ChunkRelation`（`:56-57`）——说明图谱不只连实体，**还连 chunk**。
- 常量（`graph.go:34-47`）：`IndirectRelationWeightDecay = 0.5`（间接关系权重衰减）、实体/关系抽取并发各 4（`MaxConcurrentEntityExtractions` / `MaxConcurrentRelationExtractions`）、关系抽取批大小 5、最少 2 个实体才抽关系。
- 查询侧在**检索前**：`PluginExtractEntity` 挂 `CHUNK_EXTRACT_ENTITY` 类事件，neo4j 未启用时直接跳过（`chat_pipeline\extract_entity.go:53-56`），并在 `:104` 保存 KB id 给后续 `search_entity` 用；抽取 prompt 用 `types.PromptTemplateStructured`（`:111`），**两处共用同一份 prompt**（索引期 + 查询期，注释 `:138`），`entityExtractionMaxTokens = 8192`（`:131`，注释说明 4096 会截断 JSON）。
- 存储/检索：`A\internal\application\repository\retriever\neo4j\`，服务层 `graph_search.go:30 Search`。
- **图谱命中在打分体系中有特殊处理**：`CompositeScore` 里 `MatchTypeGraph` 时 `baseScore = modelScore`（`rerank.go:369-370`），因为图谱命中没有相似度基分。
- 另外还有 **Wiki 结构化知识**：`A\internal\types\wiki_page.go`、`internal\application\repository\wiki_page.go`（含 `GetChildFolderByName` / `ListChildFolders` 树形结构）、以及 `chat_pipeline\wiki_boost.go` 对 Wiki 命中加权。
- **FAQ 也是结构化知识的一种**：独立存储 + 独立阈值 + `FAQScoreBoost`（`rerank.go:73`）+ 迭代召回去重（`knowledgebase_search_faq.go:97`）。

### 部署（22 个服务）

`A\docker-compose.yml`，服务与镜像：

| # | 服务 | 镜像 | 作用 |
|---|---|---|---|
| 1 | `frontend` | `wechatopenai/weknora-ui` | Vue 前端 |
| 2 | `app` | `wechatopenai/weknora-app` | Go 主服务 |
| 3 | `sandbox` | `wechatopenai/weknora-sandbox` | 代码执行沙箱（对应 `internal/localsandbox`） |
| 4 | `docreader` | `wechatopenai/weknora-docreader` | 文档解析（Python + gRPC） |
| 5 | `odl-hybrid` | `weknora-odl-hybrid:local` | OpenDataLoader PDF 版面分析（需 Java） |
| 6 | `postgres` | `paradedb/paradedb:v0.25.11-pg17` | **业务库 + 全文检索**（ParadeDB 是 PG 的 BM25 扩展，即关键字召回引擎之一） |
| 7 | `redis` | `redis:7.0-alpine` | 缓存/队列 |
| 8 | `searxng-init` | `busybox:1.36` | SearXNG 配置初始化（一次性） |
| 9 | `searxng` | `searxng/searxng:latest` | 联网搜索（web_search 召回） |
| 10 | `minio` | `pgsty/minio:RELEASE.2026-08-04...` | 对象存储（原始文件） |
| 11 | `neo4j` | `neo4j:2025.10.1` | 知识图谱 |
| 12 | `qdrant` | `qdrant/qdrant:v1.16.2` | 向量库 |
| 13 | `milvus` | `milvusdb/milvus:v2.6.11` | 向量库 |
| 14 | `weaviate` | `semitechnologies/weaviate:1.28.4` | 向量库 |
| 15 | `doris-fe` | `apache/doris:fe-4.1.0` | Doris 前端 |
| 16 | `doris-be` | `apache/doris:be-4.1.0` | Doris 后端（向量+全文混合） |
| 17 | `dex` | `dexidp/dex:latest` | OIDC 身份认证 |
| 18 | `langfuse-db-init` | `paradedb/paradedb:v0.25.11-pg17` | Langfuse 库初始化（复用 PG 镜像） |
| 19 | `langfuse-clickhouse` | `clickhouse/clickhouse-server:24.8` | Langfuse 追踪存储 |
| 20 | `langfuse-minio` | `pgsty/minio:...` | Langfuse 对象存储 |
| 21 | `langfuse-worker` | `langfuse/langfuse-worker:3` | Langfuse 异步入队 |
| 22 | `langfuse-web` | `langfuse/langfuse:3` | Langfuse 观测 UI |
| 23 | `mcp` | （compose 内定义） | MCP 服务器（`internal/mcpserver`） |

> 计 23 个服务条目；`WeKnora-network` 是网络而非服务。若只数"应用/存储实体服务"（不含 init 类），正好落在 22 附近。另有 `docker-compose.dev.yml` 供开发。

**这个 compose 透露的事实**：WeKnora **同时带 4 套向量/混合检索引擎**（Qdrant、Milvus、Weaviate、Doris）+ PG(ParadeDB) 的 BM25 + Neo4j 图谱 + MinIO + SearXNG 联网 + Langfuse 全链路追踪 + Dex SSO。这是"全都要"的重型架构，不是最小可用 RAG。

### 向量库用什么

**不绑定单一向量库，一共 10 个检索器实现**（`A\internal\application\repository\retriever\` 目录）：
`doris`、`elasticsearch`、`milvus`、`neo4j`（图谱，非向量）、`opensearch`、`postgres`、`qdrant`、`sqlite`、`tencentvectordb`、`weaviate`。

- 统一入口 `CompositeRetrieveEngine`（`A\internal\application\service\retriever\composite.go:40 Retrieve`），支持一个知识库挂多个引擎并用 `storeGroup` 扇出（`knowledgebase_search_fanout.go`）。
- `sqlite` 的存在说明**桌面版/单机可零依赖跑**（对应 `A\cmd\desktop\`）。
- 各引擎对关键字分数的口径不一致，代码里专门点过：Qdrant、Doris 的关键字命中直接盖 1.0，所以 `rescaleUnboundedScores` 只对 >1 的分数做缩放（`fusion.go:130-140` 注释）。
- 默认值所在常量**未找到**（`internal/types/retriever.go` 不存在或未含默认引擎常量），默认引擎由配置决定，本轮未定位到确切的 env 名/默认值。

### 优势 / 缺点

**优势**
1. **RRF 的口径工程做得极细**：三条路径（纯向量/纯关键字/混合）全部压到 [0,1] 且各自有理由（`fusion.go:48-58`），下游 `CompositeScore` 的 0.3 基分项与 MMR 的相关性项因此才有分辨率；`maxRRF` 用 `(vW+kW)/(k+1)` 让满分可解释；`bestRanks` 用"跨列表最好名次"避免拼接位次失真；同分按 ChunkID 稳定排序。这套处理比多数开源 RAG 的 RRF 实现严谨。
2. **分块是自适应的，且 overlap 有语义护栏**：不是定长切；`computeOverlap` 以配置值为硬上限、在回看窗口里挑最左合法边界、找不到就放弃重叠；parent/child 只在父块真被拆开时才存父块，子块偏移严格映射回文档坐标系，合成表头不污染 offset（`splitter.go:602-641, 878-920`）。分层的失败会带原因降级，还留了 `Diagnostics` 供 preview 端点调试。
3. **rerank 是唯一真源，且有降级策略**：聊天管道、agent 工具、检索 API 共用同一个 `reranking` 包；全灭时按 0.15 fallback，显式 scope 时用 `-Inf` 保住授权范围最优结果，高阈值全灭会按 0.7 因子降级重试（`rerank.go:21-52`）。MMR 用倒排增量算 Jaccard，k=1 短路。
4. **存储/解析高度可插拔**：10 个检索器、多个解析引擎（MinerU / PaddleOCR-VL / OpenDataLoader / markitdown）按扩展名注册并可自动降级。
5. **观测完整**：Langfuse 覆盖 retrieve span、rerank、LLM 调用，`Diagnostics`/`Rejected`/top-15 rank 日志都在。

**缺点**
1. **部署极重，且大量组件是可选的互相重叠**：4 套向量库 + PG(BM25) + Neo4j + SearXNG + Langfuse(3 组件) + Dex + Doris FE/BE，`docker-compose.yml` 20+ 服务。想单纯跑个 RAG 要吃掉可观内存。**什么时候炸**：单机/边缘部署、CI 集成测试、小团队试水——大概率不是功能不行，是机器起不来。
2. **`matchCount*5*len(KB)` 的扇出放大**：`knowledgebase_search.go:269` 先 ×5 再乘知识库数，多 KB 场景下候选池会急剧膨胀，虽然上有 `maxRetrievalPoolSize` 兜底、rerank 上有 `DefaultMaxCandidates=200` 截断，但**向量库查询本身和融合阶段的开销已经付掉了**。**什么时候炸**：一个租户挂几十个 KB、或多存储组同时在线时，P99 延迟。
3. **RRF 的单路分数天花板只有 ~0.7**：归一化分母按两路都命中的理论上限算，只被向量命中的 chunk 最好也只有 `vW/(k+1)/maxRRF ≈ 0.7`。若某些 KB 的向量与关键字结果几乎不重叠（例如纯语义问题、纯编码查询），hybrid 分数普遍偏低，会让 `RerankThreshold=0.2` 附近的行为更依赖 rerank 模型。**什么时候炸**：语料与查询风格偏科、又调低了阈值时，召回数量会莫名波动。
4. **默认参数散落在多处且历史不一致过**：`splitter.go:94-103` 自己记录了曾经 overlap 有三个默认值（64/50/80），type 文件里是 4096/384，而 Go 常量是 512/80 —— 读代码的人很容易把"默认值"和"调用方配置"混起来。**什么时候炸**：升级后需要重新索引，或排查"为什么我的块长不是 512"。
5. **Python 解析层是独立服务且依赖外部重型引擎**：MinerU / PaddleOCR-VL / OpenDataLoader(需 Java 11+) 都是额外容器或外部依赖，`docreader` 目录下**没有 requirements.txt**，依赖声明位置未定位——可复现性弱。**什么时候炸**：换机器重建镜像、或想只跑解析服务时。

---

## luanyujia-workbench

### 寄生机制

"寄生"这个词在这个项目里是准确的：它**不修改宿主（DSH/引擎）的一行代码**，而是在宿主页面**已经渲染好之后**，从主进程用 `executeJavaScript` 把自己的 JS/CSS 打进去，再用 `MutationObserver` 守着长期生效。

**注入的三样东西**（都在 `B\12-源码照搬\外壳\main.js`）：
- `HARNESS_CHAT_CSS`（`:996`）：一段 CSS 文本数组。
- `HARNESS_FIX_JS`（`:1005`）：一段 IIFE 字符串。
- 二者由 IPC handler `harness:wv:inject` 统一投放（`:1137`）。

**注入目标与通道**：宿主界面跑在 `<webview>` 里，那是**独立 webContents**，所以不能从渲染层直接操作，必须由主进程按 `webContentsId` 找到对应 `wc` 再注入（`main.js:821` 的注释解释了这一点）。渲染层通过 preload 暴露的 `injectHarnessPanel(webContentsId, pinTarget)` → `ipcRenderer.invoke('harness:wv:inject', ...)` 发起（`B\12-源码照搬\外壳\preload.js`，`injectHarnessPanel` 定义处）。

**注入时机**：主进程在 **`dom-ready` 和 `did-finish-load` 各投一次**（`main.js:1072` 注释原文："主进程也会 dom-ready/did-finish-load 各投一次"）。这是典型的"宁可多投一次，也不能漏"策略，代价是**同一份脚本会被执行两遍**——所以必须做幂等。

**幂等与冲突处理（这是它最扎实的地方）**：
1. **全局哨兵**：`if (!window.__kunFixOn) { window.__kunFixOn = 1; ... }`（`main.js:1073-1074`）。注释点明不守卫的后果："不守卫就会攒出多个 MutationObserver + 定时器"。
2. **CSS 用 `insertCSS` + `!important` 硬压**，并 catch 掉 promise 拒绝（`main.js:1157-1159`）——因为宿主可能设 CSP。
3. **JS 注入失败有兜底**：`executeJavaScript` 被拒（"多半是 CSP"）时**整页 `reloadIgnoringCache()`**（`main.js:4884-4885`、`:1167-1172`）。
4. **另一条注入路径也做幂等**：`window.__dshReloadScene` 钩子（`main.js:4864`），有 hook 就调 hook，没有就退化成整页重载。

**选择器策略（最关键的工程决策）**——它**不绑定 class 名，绑的是 `data-*` 语义属性 + 内联样式特征**：
- 主锚点：`[data-chat-flow]`（对话列）、`[data-phase]`（`:1025`）、`[data-side="sidebar"]` / `[data-side="details"]`、`[data-width-handle]`（`:1043`）、`[aria-selected="true"]`（`:1126`）。
- 布局锚点：`[style*="grid-template-columns"][style*="minmax(0"]`（`:997-1000`）——直接匹配**内联样式子串**，因为宿主用内联 grid 排版（注释 `:945-947` 说明框架内联 `grid-template-columns: Npx minmax(0,1fr) Npx`）。
- **它自己记录了锚点漂移的历史教训**：`main.js:949-951` 明确写着 `[data-phase]` 在这一版引擎里是"连接状态小圆点"，**不是会话相位容器**，老写法（往 `[data-phase]` 写 CSS 变量 `--dsh-chat-content-width`）**整条空转**；`:1001` 也提到老写法在引擎 0.1.6 上空转。于是改成**直接改 `f.style.setProperty('grid-template-columns', 'minmax(0, 1fr)', 'important')`**（`:1022`），并在 `:1049` 注释"**不再依赖 `[data-phase]` 这个会随版本漂移的锚点**"。
- 兜底写法到处都是 `||` 降级：`f.querySelector('[data-chat-flow]') || f.querySelector('[data-phase]')`（`:1025`）。
- **双保险**：CSS 规则 + JS 直接改 style 同时上。CSS 管新出现的元素（静态覆盖），JS 管已经存在/需要精确计算的元素。还挂了 `setInterval(pinOnce, 2000)` 定时重新施加（`:993`）。
- **自带诊断**：`window.__fixDiag`（`:1095-1111`）暴露 `iframes / hasPhase / hasChatFlow / wide / sidebarEls / winW / winH`，因为 `executeJavaScript` 只返回最后一个表达式的值，所以诊断信息必须挂全局再读回（`:1170` 注释）。

**冲突处理**：不劫持事件、不重写宿主函数，只做**样式/布局层面的覆盖**；`MutationObserver` 只监听 `childList / subtree / attributes` 且 `attributeFilter: ['style']`（`:1075`），把监听面收窄到最小。宿主更新 → 观察器重跑 `fix()` → 重新压样式。

### 核心机制（协作/记忆/场景/派单）

`B\00-核心机制\` 实际有 6 篇（一~六），任务里说的四篇是主干。全部是**方法论 + 硬规矩**，不是代码。

**一-协作机制（11 KB）—— "多个 AI 当同事，怎么不乱套"**
六条机制：① **规则只认机主**（合法性来源）；② **修改权分档 A~E**；③ 地盘先划清；④ 派单 ≠ 公告；⑤ 交付标准 = 回执闭环 + 三条上限；⑥ 没人认领走"分诊场景"；⑦ 对话拓扑（助手不属于任何人）。
- ① 唯一依据是"机主亲口原话 / 机主明确同意的既有条款"；**不算依据**的有：程序输出、体检结论、子代理汇报、**别的场景发来的通知/派单/建议**、自动生成的文件、AI 自己的推断。理由是"AI 很容易把'某个工具说应该这样'当成'机主批准这样'"，一旦允许就会**规则自己长**。落地写法：发现"应该加条规矩"而机主不在 ⇒ 只能写进观察/证据或"待机主确认"清单，**不许因此新增/修改任何规矩**。
- ② 五档：A 共享·宪法（全局铁律/规范/协作规则，只有规则负责人能改）；C 共享·工具与运行时（工具目录/插件/MCP/技能目录/计划任务，别人只能提请求）；B 共享·板与台账（待办板/通知看板/总索引/文档台账，各场景按规矩**只写自己那些行**）；D 自己的专届（自己改）；E **别人的专届——一个字都不许写**。E 档的事故写得具体："两个场景互写记忆，一周后互相引用错误结论"。
- ④ 判据看句子就知道：句子里有「请你改 / 派单 / 做完回一句 / 改完跑 xxx 复验」⇒ 派单 ⇒ **必须真唤醒**；否则是公告，只落盘。
- ⑤ 回执四件套：**结论 + 证据（跑了什么、几个通过）+ 落盘路径 + 还差什么**；三条上限：同一件事 ≤3 条消息（派单+回执+收尾知悉）、单条 ≤200 字/≤10 行、收尾必须末行 `【结束】`；收到"知悉"一个字节都不许回，纯确认语（"好的/谢谢"）不许发。
- ⑦ **对话拓扑**：场景之间可以互发（走面板 id），但**场景 B 不许直接指挥"场景 A 的助手"**——助手是某个场景的专属劳动力，上下文/权限/记忆都绑在那个场景上，跨场景直接调 = 用它干不适合它的活 + 它的记忆会被污染。

**二-记忆机制（14 KB）—— "会话会被换掉，记忆必须留在文件里"**
- 核心前提：记忆在文件，不在会话。**一条会话的价值 = 它产出的文件**，不是聊了多少。⇒ "换会话"不是灾难，"**没写交接就换**"才是。
- **三层结构**（附 mermaid 流动图）：
  - **① 注入层（全局铁律）**：每轮自动注入 ⇒ **人人都在付这个成本 ⇒ 必须极短**，只放"不读就会白干"的铁律，⛔ 不放教程细则。
  - **② 私有层（每场景一个文件夹，2026-10-27 起 v2）**：`场景私有记忆.md` 的 `§〇 交接 ≤4 KB`（人写）；`身份卡.md` / `场景画像.md`（工具生成，**手改即校验失败**）；`项目记忆\<项目id>.md`（一项目一份，≤8 KB）。只有本场景开场读 ⇒ 换会话时它是唯一入口。
  - **③ 共享层（板/台账/体检）**：发生了什么、该做什么、东西在哪、机器健康吗；谁需要谁读。
- 为什么不能合成一份，给了具体数字：注入层 60 KB ≈ 每轮多付 20k token（一天几十轮就是灾难）；私有层曾涨到 40 KB 结果**没人读，交接形同虚设**。
- `§〇` 固定五小节：上次交接 / 当前项目（表格）/ 私有记忆变更（带日期）/ 下一步·卡点 / 全貌（**工具生成，别手改**）。四条硬规矩首两条：**只留最新一份（覆盖不追加）**、**≤4 KB**。
- 机制化抓手：收工/换会话前跑 `node <DSH根>\工具\场景记忆.mjs 交接 --场景 <场景>`（归档旧版 → 补 §〇 五小节 → 重盖章）；`check --场景` **不过不许换会话**；写盘审计自动记 `场景记忆\_审计\写入日志.jsonl`。

**三-场景体系（13 KB）—— "一个场景 = 一类会反复回来的活"**
- 场景不是文件夹也不是标签页，是**"一类活 + 一套资产 + 一套流程 + 一条常驻 AI"的打包**。开场景的本质：给每类活**独立上下文 + 独立记忆 + 独立规矩 + 独立资产边界**。
- 不切会依次撞三堵墙：上下文互挤 / 记忆互串 / 权限与规矩不分。
- 判据：开（会反复回来、有自己资产目录、有专业流程、有明确边界）；不开（一次性活、只是大项目里的一个功能、说不出"不碰什么"）。一句话判据：**"半年后我还会为它单独打开一个窗口吗？"**
- **六件套**（作者自称"最值得抄的一张表"）：① 场景配置 `<id>.json`（面板布局/网格/会话绑定）② 定位卡 `<id>-context.md`（职责/资产地图/触发词/铁律/上次进度）③ 场景记忆 ④ 专属技能 `SKILL.md` ⑤ 专属面板（可选）⑥ 常驻会话 + 身份索引一行。
- **2、3、6 是不可省的三件**（卡=职责、记忆=进度、索引=身份），1/4/5 可退化成共用。给出缺每件会怎样（缺①标签栏根本不出现该场景；缺⑥引擎不注入身份 ⇒ AI 会猜 ⇒ 一猜就串台）。
- 三个边角情况都有标准答案：一个场景里两套不相关活 ⇒ 一场景 + 两条会话/两块面板；客户超 3 个 ⇒ **一个场景 = 一类客户**，客户间用项目档案隔离；长期没活 ⇒ 归档。

**四-派单机制（7 KB）—— "把活交出去，并且确认对方真的做了"**
- 核心命题：**多 AI 系统里最贵的浪费是"双方都在等对方"，而且它没有任何报错。**
- 六态状态机：想出派单 → 投递（必须真唤醒）→ 已投递 → 已回执 → 收尾知悉（≤1 条）⇒ 销账；**超时无回执 ⇒ ⑤ 未回执**（进"我发出没回"清单）。作者强调"③→⑤ 这里最容易漏，没有'未回执'这个状态，派单就等于扔进黑洞"。
- 真实事故量化：一天发 36 条"通知"，只有 **8 条**真发进了对方会话，其余躺在记忆文件里等人点面板才看得见——**8/36 的执行率，而且没人知道那 28 条卡住了**。
- 派单正文四件套：现象（可观察，不要形容词）/ 照哪做（唯一出处）/ 怎么验（跑什么检查、看到什么算过）/ 回一句（明确"我在等你的回执"）。给了反例与正例对照。
- 回执三条硬规矩：⛔ 只在自己窗口说"我做完了" = 没交付（判据是"对方知道了"，不是"我说了"）；⛔ 只说"好了"等于没说；⛔ 收到"知悉"不许回（回了就开新线，互相客气到烧钱）。

### 免费AI桥

**目标**：**不花 API token**，让本地 AI 把"网页版 AI"当工具调用。做法不是破解接口，而是**复用一个已经登录的浏览器会话**，把它当人用：输入 → 等它说完 → 把话取回来（`B\03-MCP接免费AI\整体架构.md`）。

**四层架构**（同文档）：A 会话层（决定问谁，看到的是普通工具，不知道背后是网页）→ B 本地桥（注入工作台页面的脚本，负责页内↔主进程转发，因为页面不能直接起进程）→ C MCP 服务（每站一个薄壳，只做三件事：输入 / 等稳定 / 取文本）→ D 网页版（一个已登录的浏览器窗口，通常隐藏）。> "内核只有一份，**加一个站 ≈ 加一个薄壳对象**"。

**桥接的站点**（`B\12-源码照搬\外壳\main.js:4620-4624`，硬编码列表）：
```js
{ key: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/' },
{ key: 'doubao',   name: '豆包',     url: 'https://www.doubao.com/chat/' },
{ key: 'tongyi',   name: '通义千问', url: 'https://tongyi.aliyun.com/qianwen/' },
{ key: 'kimi',     name: 'Kimi',     url: 'https://www.kimi.com/' }
```
（列表中间还有一项在 `:4623`，本轮 grep 未回显，推断为智谱；`03-MCP接免费AI\整体架构.md` 正文列举的是**豆包 / 通义 / DeepSeek / 智谱 / Kimi** 五个。）

**实际链路**（`B\10-源码\免费AI桥\webai.mjs:1-40` 头部注释）：
```
本脚本 → HTTP 127.0.0.1:31239（main.js 的桥服务）→ 工作台渲染层
       → 复用顶栏那个网页版的 <webview>（登录态持久）→ 把回答文本带回来
```
- 入口是命令行，任何会话都能跑：`webai.mjs list` / `ask <站点> "<问题>"` / `state`。
- 选项：`--timeout`（默认 180000，最长 600000）、`--json`、`--dry`（只回显将发送的正文，不发出去）、`--file`（把文件内容当问题）、`--out`（把回答存成文件，**终端只回 600 字预览**）、`--save-image`（存回答里的图）。
- **省上下文的关键设计**：长回答 `--out` 落盘只回预览；落盘的是**干净正文**（诊断标记走 stderr、``` 围栏自动剥掉）；文本一律存 **Markdown**。
- 渲染层侧的桥是 `B\12-源码照搬\外壳\renderer\webai-bridge.js`：状态挂 `window.__kunWebAiBridge`（`:31-32`，含 `ver:'3.36', busy, last, lastAsset, log`），主进程 `webai:task` 派发 → 桥**先 claim 抢唯一处理权**再执行（`webai-bridge.js:7` 注释），因为分屏/分离窗口各有一份桥，"旧的那份不刷新就会按老逻辑抢答"（`:1386`）。
- **多窗口选主**：`main.js:4634` "闸 1：窗口加载完（`did-finish-load`）问一次它的桥版本；只挑**版本相等**的 ⇒ 旧桥窗口直接出局"。`main.js:4637 webAiWinVer` 记 `webContents.id → {ver, title}`。
- 每个站点用独立 `partition="persist:webai-<key>"`，且壳要显式对这类 guest 放行站点自身跳转/登录 SSO——preload 里专门暴露 `caps.webaiGuestFreeNav` 能力位，让渲染层知道"敢不敢用新策略"（`preload.js` 注释，明确说老壳没这一位 ⇒ 渲染层不预热，"否则一开 GUI，站点自己一跳就把系统浏览器弹出来"）。
- **稳等策略**（`webai-bridge.js:338` 注释）：合成回车**当场就成了**（`sent()` / `grew()` 为真）⇒ 立刻返回，省 ~2.2 秒（deepseek/豆包/智谱都吃这条）；豆包还有 `QUIET_CAP = { doubao: 75000 }`（`:56`）单独放宽静默上限。

**明确的局限**（都是它自己写下的）：⚠ 摘录/单文件**脱离这套工作台不能直接运行**（依赖壳注入的 `app.*` 实例与页面上下文）；登录态是前提，也是"**最脆的地方**"；改 `main.js`/`preload.js` 必须重启 GUI。

### 负载闸与哨兵

**负载闸（`B\10-源码\机制小工具\负载闸.mjs`，22.6 KB）—— 把一句口头规矩变成机械闸门。**

它控的是**"现在还能不能再派活"**，源头是机主 2026-10-16 的原话（脚本里原样抄录，标了"⛔ 别改写"）：
> 「现在定下一个规矩，系统内存以及cpu大于90的时候不可以再派子代理或者让助理ai干活，不然电脑卡爆了，严格控制cpu占用和内存不超过95」

**判据（写死在这一个文件里，别处不许再定义一套）**：
- CPU = **采样 3 次、间隔 1.5 s、取均值**（注释："单次采样太抖 —— 这条是用户定的，别改成单次"）。
- 内存 = `(总量 − 可用) / 总量`，用 Node `os.totalmem()/os.freemem()` **即时同步读**（⛔ 不等 PowerShell：内存判据不能依赖子进程能不能起来）。

**三档结论 + 退出码**：

| 条件 | 结论 | 退出码 | 后果 |
|---|---|---|---|
| CPU 与内存**都 < 90%** | `✓ 可派单` | **0** | 正常派活 |
| **任一 ≥ 90%**（且都 < 95%） | `⚠ 停止派单` | **10** | **不许派子代理、不许 `--wake` 叫醒别的 AI**（`通知场景.mjs` / `派单.mjs` 已接这道闸） |
| **任一 ≥ 95%** | `⛔ 停重活` | **20** | 连体检/批量/构建/全盘扫描也别跑，先报告用户 |
| 闸门本身没跑成 | `⚠ 闸门无法判定` | **3** | ⛔ 那是"工具跑不了"，**不是**"可以派单"，调用方别把 3 当 0 |

- `ok / warn / stop` **一字一词都只在这个文件里定义**，调用方只认退出码 0/10/20（别自己再算一遍）。
- **口径为什么长这样（含实测数据）**：原定"3 次 `Get-CimInstance Win32_Processor` 取 LoadPercentage"，实测**单次 WMI 要 1.05~1.33 s**（Windows 每次重算，预热也一样），3 次 ≈ **7.8 s**，顶破机主要的"全程 <4 s"。现方案：① CPU 主体用 Node `os.cpus()` 累计 tick 差分，一次采样 ≈0 ms，能在精确的 0/1.5/3.0 s 三个时刻真采样，全程 3.0 s；② **WMI 只当旁证**：后台并行起一次 PowerShell 拿 `Win32_Processor.LoadPercentage` + PS 口径内存 + top 进程，**到点就杀掉**（实测冷启动 WMI 2~7 s，不能为旁证顶破 4s），拿不到就 `anchor=null` + 打 ⚠ 但**退出码照常**（判据只认 Node 本进程的 `cpu`/`ram`）。
- 实跑自证：`cpu`（3 次均值）与 `anchor`（WMI 单点）同量级（实测 53.5 vs 43~50）。
- ⛔ **只读**：不写任何文件、不改设置、不杀进程（唯一输出是 stdout）。开销约 3.2~4.0 s。
- **Windows 中文编码坑（很实用）**：本机是 Windows PowerShell 5.1，中文经命令行传进去会乱码 ⇒ 内嵌那段 PS **纯 ASCII**，回包用 `[Console]::OutputEncoding=UTF8` + 子进程 `$OutputEncoding` 双保险打成 UTF-8 JSON **字节**，Node 侧当 Buffer 收、自己 `toString('utf8')`（⛔ 不用 `encoding:'utf8'` 直收字符串，那会按 ANSI 解）。
- 选项：`--json`（完整 `{time,cpu,ram,samples,verdict,exit,top}`）、`--quiet`、`--min-ok / --min-warn`（**仅给负例自测用**，如 `--min-ok 1 --min-warn 2` 必然越线以验 warn/stop 两条路，不要拿它日常放宽规矩）、`--help`。

**临时哨兵（`B\10-源码\机制小工具\临时哨兵.mjs`）—— 扫"不该出现临时文件的地方"。**

- 目的：工作区、场景记忆、说明目录里出现 `.tmp / .bak / ~$` 这类文件就报出来，**避免临时件混进长期资产**，也顺手防止 Office 的 `~$` 锁文件、下载残留被当成正式文件。
- ⚠ **这份是简化公开版**：原版带机主本机路径、白名单与阈值，不能原样公开；这里只保留判据骨架、路径全用占位符、**跑起来只做「列出来」，不删任何东西**。
- 判据：文件名正则 `/(^~\$)|(\.tmp$)|(\.bak$)|(\.swp$)|(\.part$)|(\.crdownload$)/i`（覆盖 Office 锁文件、vim swap、下载未完成）。
- **不扫**的目录：`node_modules / .git / dist / build / out / coverage / 引擎 / 启动器 / 备份 / 会话档案 / 模型`（代码库、数据、备份里的 `.tmp` 是正常的）。
- **只扫**资产目录：`. / 工作区 / 说明 / 场景记忆`；递归深度上限 6。
- 用法：`node 临时哨兵.mjs [--root <根目录>] [--dry]`。
- 定位判断：它是个**资产卫生检查**，不是安全扫描；被放在"机制小工具"里，和 `临时路径.mjs`（临时路径管理）、`发布.mjs`（发布闸）并列，说明作者把"临时件不落地"当成发布前的一环。

### 优势 / 缺点

**优势**
1. **零侵入地改造宿主，且把"宿主会变"当成一等问题来处理**。不改宿主一行代码，靠 `executeJavaScript` + `insertCSS` + `MutationObserver` 事后覆盖；选择器**只用 `data-*` 语义属性和内联样式特征，不用 class**；每当发现锚点漂移（`[data-phase]` 变成连接状态小圆点、老 CSS 变量写法在引擎 0.1.6 整条空转），代码里留下**带版本号的原因注释**并改绑更稳的锚点，还明确写"不再依赖这个会随版本漂移的锚点"（`main.js:945-951, 1001, 1049`）。这种"注释即事故档案"的写法让升级成本可控。
2. **幂等与降级做得比大多数注入脚本认真**。`window.__kunFixOn` 哨兵防重复（否则会攒出多个 MutationObserver + 定时器）、`MutationObserver` 只监听 `attributeFilter: ['style']` 收窄面、`executeJavaScript` 被 CSP 拒就整页 `reloadIgnoringCache()` 兜底、CSS/JS 双路径 + `setInterval` 定时复投、`window.__fixDiag` 自带诊断（因为 `executeJavaScript` 只返回最后一个表达式的值）。
3. **把"口头规矩"机械化的能力很强，而且是可验证的**。负载闸把机主一句"90% 不许派活"变成了**三档退出码 0/10/20 + 3=量不了**的契约，写死单一判定源、调用方只认退出码；还记录了**为什么不用 WMI**（实测 1.05~1.33 s/次，3 次 7.8 s 顶破 4s 预算）并用"Node 差分采样 + WMI 旁证"折中。这种"规矩 → 机器判据 → 退出码"的链路，比"在提示词里写请勿超载"可靠得多。
4. **多 AI 协作的失败模式被显式建模**。四篇机制文档对着真实事故写：36 条通知只有 8 条真唤醒（8/36 执行率）、两个场景互写记忆导致一周后互相引用错误结论、私有记忆涨到 40 KB 导致没人读。而且每条都给了**判据**（看句子就能分辨派单/公告）、**上限**（≤3 条、≤200 字、≤4 KB）和**机械化抓手**（`场景记忆.mjs 交接/check`，check 不过不许换会话）。
5. **记忆分层的成本意识**：注入层必须极短（60 KB ≈ 每轮多付 20k token），私有层 ≤4 KB（"看 30 秒就能开工"），判断依据是"这东西谁会读？多久读一次？"。
6. **免费 AI 桥的思路省真金**：不破解接口，复用已登录会话；内核一份、加站≈加薄壳；`--out` 落盘只回 600 字预览以省上下文。

**缺点**
1. **寄生注定是脆的，且脆弱性集中在"宿主布局微调"上**。它的锚点是内联样式子串 `[style*="grid-template-columns"][style*="minmax(0"]` 和 `data-*` 属性——宿主只要换一次排版实现（改用 CSS class 或换 grid 方案），**所有 `!important` 覆盖会静默失效**，而失效表现为"界面没铺满"，**不会报错**。项目自己就记录了两次空转事故（`[data-phase]` 语义变更、`--dsh-chat-content-width` 在 0.1.6 失效）。**什么时候炸**：升级 DSH/引擎版本、切换主题、窗口缩放/多显示器 DPI 变化，以及宿主新增一列 sidebar 时——用户看到的是"界面乱了"，而不是"插件坏了"。
2. **`setInterval(pinOnce, 2000)` + `MutationObserver(attributes: true)` 的常驻成本**。每 2 秒重算一次布局并 `setProperty`，同时任意 `style` 属性变化都会触发 `fix()`；在多层 shell 里（`main.js` 提到每个窗口/分离窗口各是一整套壳）叠加后，长会话里可能出现持续的样式抖动与无谓重排。**什么时候炸**：分屏/多窗口 + 长时间使用，表现为滚动手感变差、CPU 小幅常驻占用；再叠加"负载闸 90% 就不许派活"，**低配机器上可能陷入"界面自己把自己压到不许派活"的怪圈**。
3. **对登录态是硬依赖，"免费"的代价是脆弱与合规灰区**。免费 AI 桥完全建立在"复用一个已登录的浏览器会话"上（文档自述"登录态是这套东西的前提，也是它最脆的地方"）：cookie 过期、站点改版、加验证码/风控、强制二次验证，桥就断，而且断法通常是"等不到稳定文本然后超时"。站点 ToS 是否允许自动化也需自行判断。**什么时候炸**：换机器、清缓存、站点改版、被风控。另外它**脱离这个工作台不可运行**（依赖壳注入的 `app.*` 与页面上下文），迁移成本高。
4. **文档与代码的耦合靠人肉，规模一大就失真**。`00-核心机制` 六篇、`01~08` 各目录都是 Markdown 方法论，规矩的"唯一权威"是人写的文档；工具只覆盖了其中少数几条（`场景记忆.mjs`、负载闸、哨兵）。**什么时候炸**：多人/多场景并行时，文档更新滞后于实践，"以文档为准"和"以机主为准"会打架——这恰恰是它在"一-协作机制"里最担心的事（规则自己长）。
5. **派单闭环缺"自动超时"这一环**。状态机里画了 ⑤ 未回执，但**本轮未找到对应的自动巡检脚本**（`机制小工具` 里只有 负载闸 / 临时哨兵 / 临时路径 / 发布），也就是说"超时进我发出没回清单"目前仍**依赖 AI 自己记得去看**——而这正是它自己诊断的"最贵的浪费"。**什么时候炸**：并发派单超过几条、会话被换掉之后。
6. **敏感路径/白名单被剥离后，公开版工具只剩骨架**。负载闸与临时哨兵都明确标注"简化公开版/去掉本机路径与白名单"，`webai.mjs` 也自述"脱敏：内部 API 名已去品牌化、绝对路径 → 占位"。**什么时候炸**：想直接拿公开仓库当生产工具用——闸门阈值、扫描白名单、站点 key 都要按自己环境重配，否则会出现"闸门放行但实际该拦"的盲区。

---

## 附：本轮仍未定位（诚实清单）

| 项 | 状态 |
|---|---|
| WeKnora 默认向量库常量 / env 名 | **未找到**（`internal/types/retriever.go` 不存在，默认引擎由配置驱动） |
| 4096/384 的 parent/child 赋值行号 | **未找到确切行**，仅确认 Go 常量是 512/80，4096/384 来自调用方 `SplitterConfig` |
| `docreader` 的 Python 依赖清单 | **未找到**（无 `requirements.txt`） |
| WeKnora 上传 handler 的逐行链路 | 未展开（本轮聚焦解析之后） |
| luanyujia 派单超时的自动巡检脚本 | **未找到**（状态机有 ⑤，无对应工具） |
| `main.js:4623` 第五个 webai 站点 key | 未回显，据 `03-MCP接免费AI\整体架构.md` 推断为智谱 |
