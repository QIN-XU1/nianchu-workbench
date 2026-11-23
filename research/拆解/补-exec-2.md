# 补拆：pi / open-design / craft-anything 的执行逻辑

> 只读分析。所有路径均为**实测存在**的真实路径（注意：三棵树都比我原先以为的深一层，实际根为
> `D:\refs\pi-main\pi-main`、`D:\refs\open-design\open-design-main`、`D:\refs\craft-anything\craft-anything-main`）。
> 每条结论后附 `路径:行号`；本轮未直接读到的内容一律写「未验证」，不做推测。

---

## pi

### 1) 一次任务的完整链路

入口在 `packages/coding-agent`，会话对象是唯一的总线：

1. **装配**：`AgentSession` 构造时吃进 `initialActiveToolNames` / `allowedToolNames` / `excludedToolNames`，
   并把工具名过滤规则编译成匹配器 `createToolNameMatcher(...)`。
   `packages/coding-agent/src/core/agent-session.ts:534`、`:537-542`、`:118`
2) **取可调用集**：真正喂给模型的是 `this._getCallableTools()`；另有两个旁路 `this.agent.state.tools.slice()`
   用于快照/导出。
   `agent-session.ts:812`、`:861`、`:986`
3) **单轮循环**：循环主体在 `packages/agent/src/agent-loop.ts`（29,973 B），会话层把
   `runToolCall: (toolCall, parentId, signal, onUpdate) => ...` 注入循环，工具执行由**会话**而非循环负责，
   带 `beforeToolCall` / `afterToolCall` 钩子（这两个钩子随后会写进 session tree 的 parentId 链）。
   `agent-session.ts:802`、`:815-816`
4) **压缩前置**：每次请求助手回复之前先过一道
   `_compactBeforeNextAssistantResponse(turn.context)` —— 压缩是**链路上的闸门**，不是事后补救。
   `agent-session.ts:839`、`:968`
5) **事件流**：全过程往 `EventBus` 发结构化事件（`compaction_start` / `compaction_end` /
   `auto_retry_start` / `summarization_retry_attempt_start` 等），TUI 与 HTML 导出都消费这些事件。
   `agent-session.ts:223`、`:228`、`:235`、`:244`

**结论**：链路是「配置 → 工具集快照 → 注入 loop 的工具回调 → before/after 钩子落树 → 压缩闸门 → 事件流」。
工具的**执行权在会话层**，loop 只负责编排——这是 pi 与多数 agent 框架最大的结构差异。

### 2) 工具或能力的注册方式

- 工具对象类型是 `AgentTool`，定义在 `packages/agent/src/types.ts`（21,889 B），`agent.ts:1` / `agent-loop.ts:1` 均引用它。
- 插件/扩展注册表是个 **Map**：`tools: Map<string, RegisteredTool>`。
  `packages/coding-agent/src/core/extensions/types.ts:2325`
- 初始化点：`packages/coding-agent/src/core/extensions/loader.ts:616`（`tools: new Map()`）；
  由 `runner.ts:979` 统一持有并暴露给会话。
  `packages/coding-agent/src/core/extensions/runner.ts:979`
- **动态工具名分层**：MCP 工具用 `isMcpToolName(name)` 判定，并有一个开关 `_allowlistFiltersMcp`
  决定 allowlist 是否也管 MCP 命名空间；`agent-session.ts:1631`、`:540`。
- **工具的运行时增减**：`_pendingToolNames` / `_restoredToolNames` 两个 Set 处理
  「恢复会话后工具集与记录不一致」的场景——若旧工具被移除，pending 会被清空。
  `agent-session.ts:480-482`、`:1606-1620`
- **工具搜索**：存在专门扩展 `src/extensions/tool-search/tool.ts`（工具太多时按需检索）。
  `packages/coding-agent/src/extensions/tool-search/tool.ts:301`
- **代码模式**：`src/extensions/codemode/` 把工具当沙箱内 API 暴露（`execute.ts:585`、`:670`、`:730`；
  `tool.ts:234`、`:450`），即「工具不是只能被模型直接调用，还能被模型写代码调用」。
- 存在 `apps/p2/plugins/*/tool.ts` 形态的插件工具文件，实测 12 个：
  `agent, artifacts, dev-tools, history, locations, mcp, ports, send-file, subagents, telemetry, terminals, views`
  （例：`apps/p2/plugins/subagents/tools.ts` 34,871 B、`history/tools.ts` 16,304 B）

> **诚实说明**：任务简报称「8 个工具 + 70 个示例扩展」。本轮我在
> `packages/coding-agent/src` 下**未找到** `tools/` 目录（`Get-ChildItem ... -Directory` 只列出
> `bun, cli, core, experimental, extensions, modes, utils`），因此**8 个内置工具的具体清单未能定位到文件**。
> 同样，`src/extensions/` 下实测只有 **4 个**扩展目录（`codemode, llama, mcp, tool-search`），
> **「70 个示例扩展」未验证** —— 可能在别的包（`apps/p2/plugins` 系列）或仓库示例目录，未在本轮确认。

### 3) 并发与取消

取消是**多控制器、按职责分离**的设计，而非一个全局 signal：

| 控制器 | 管辖 | 证据 |
|---|---|---|
| `_compactionAbortController` | 手动压缩 | `agent-session.ts:437` |
| `_autoCompactionAbortController` | 阈值/溢出触发的自动压缩 | `agent-session.ts:438` |
| `_branchSummaryAbortController` | 分支摘要 | `agent-session.ts:442` |
| `_retryAbortController` | 重试退避等待 | `agent-session.ts:445` |
| `_bashAbortControllers: Set<AbortController>` | **每个 bash 子进程一个** | `agent-session.ts:454` |

- 统一收口：`abortAll()` 一次性 abort 前四个。
  `agent-session.ts:3087-3095`
- **忙判定**：`isBusy` 把「压缩 / 分支摘要 / 重试 / 排队续跑」全部算作忙，避免并发进入。
  `agent-session.ts:1550`、`:1718-1723`
- 压缩与分支摘要互斥：两者任一在跑就直接拒绝新的压缩。
  `agent-session.ts:2193`
- 并发/取消与压缩的交叉点被显式建模：压缩完成后要检查 `signal.aborted` 再决定是否落盘，
  并有「被扩展取消」的独立分支（`cancelledByExtension`）。
  `agent-session.ts:3015`、`:3059`
- 自动压缩有独立的 controller 租约：`_autoCompactionAbortController === abortController` 才算自己的，
  结束时只在仍属自己时清空（防止竞态误清）。
  `agent-session.ts:3284`、`:3407-3408`

> 未找到全局并发上限常量（如 maxConcurrent）；工具的实际并行度在 `agent-loop.ts` 内，本轮未展开读。

### 4) 错误处理与重试

- **可重试判定**是白名单语义：注释明写「overloaded, rate limit, server errors」。
  `agent-session.ts:3882`
- **指数退避**：`retryDelayMs(settings, this._retryAttempt)`，预算来自 `settings.maxRetries`。
  `agent-session.ts:3946`、`:3952`、`:3957-3958`
- **可中断的等待**：`await sleep(delayMs, this._retryAbortController.signal)` —— 退避期间用户可取消。
  `agent-session.ts:3968`
- **重试预算共享**：压缩用的重试与普通轮次的重试用同一份 budget/backoff
  （注释："Uses the same `settings.retry` budget/backoff as agent-turn retries"）。
  `agent-session.ts:3901`
- **事件化**：每次重试排期都经 `onRetryScheduled(attempt, maxAttempts, delayMs, errorMessage)` 上报，
  再转成 `auto_retry_start` 事件给 UI。`agent-session.ts:3901-3906`、`:235`
- **压缩失败的显式通道**：`session_compact_failed` 事件，且只在扩展注册了处理器时才发。
  `agent-session.ts:1117-1118`
- **摘要输出的完整性校验**：摘要被 token 上限截断时会产出「generation hit the token cap and the
  summary is incomplete」，即**拒绝把半截摘要当成功**。
  `packages/coding-agent/src/core/compaction/compaction.ts:590`
- **重试尝试也上报**：`summarization_retry_attempt_start`（source: `branchSummary` | `compaction`）。
  `agent-session.ts:244-247`

### 5) 上下文管理（append-only session tree ←→ 无损压缩）★重点

**数据结构**（`packages/coding-agent/src/core/session-manager.ts`）：

```
SessionEntryBase { id, parentId: string | null, ... }   // :57-60
type SessionEntry = ...                                 // :183（联合类型，多种 entry）
```

- `parentId` 是树的唯一结构字段：每个 entry 只指父，**不指子** → 天然 append-only。
  `session-manager.ts:60`
- 写入即追加且自动挂到当前叶子：`parentId: this.leafId` + `this._appendEntry(entry)`，
  所有 entry 类型共用这一条路径（`:1226`、`:1239`、`:1252`、`:1266`、`:1293`、`:1314`）。
  `session-manager.ts:1199`、`:1226`
- 官方定位一句话：**"Manages conversation sessions as append-only trees stored in JSONL files"**。
  `session-manager.ts:985`
- 分支 = 把 `leafId` 挪到别的节点再继续追加，旧分支的 entry 永不修改。切换/分支能力由
  `getBranch` 等接口提供（`:255`）。
- **`getBranch()` 是压缩与恢复的核心读取口**：把叶子到根回溯成线性数组 `SessionEntry[]`，
  压缩、模型选择恢复、thinking 级别恢复都从它读。
  `agent-session.ts:661-663`、`:673`、`:690-691`

**无损压缩怎么做到「无损」**：不是靠不丢数据，而是靠**树结构保底 + 摘要作为一种 entry 落盘**。

1. 保留窗口按 token 计算：`keepRecentTokens: 20000`。
   `packages/coding-agent/src/core/compaction/compaction.ts:123`、`:129`
2. 切点算法：从后往前累加 token，达到 `keepRecentTokens` 即切；注释明写
   "Find the cut point in session entries that keeps approximately `keepRecentTokens`"。
   `compaction.ts:431-434`、`:450`、`:472`
3. 被切掉的旧内容 → 生成**结构化摘要**（首次 `SUMMARIZATION_PROMPT`，后续
   `UPDATE_SUMMARIZATION_PROMPT` + `<previous-summary>` 标签做**增量更新**）。
   `compaction.ts:507`、`:577`、`:727`
4. 增量更新的硬规则：`UPDATE_SUMMARIZATION_INSTRUCTIONS` 要求 "PRESERVE all existing information
   from the previous summary" —— 这是「多次压缩不衰减」的关键约束。
   `compaction.ts:540-541`
5. 摘要本身作为 `compactionSummary` 类型 entry **落进同一棵树**，所以原始 entry 仍在磁盘上，
   只是不再进入模型上下文 → **磁盘无损、上下文有损且可回溯**。
   `compaction.ts:342-343`、`:358`、`:372`；`agent-session.ts:1028`
6. 三个汇总入口共用一个 choke point（注释："Shared choke point for every compaction/branch-summary
   summarization call"），保证 prompt 与预算一致。`compaction.ts:612`
7. 分支摘要单独一套：`core/compaction/branch-summarization.ts`（13,295 B）。
8. 「turn prefix summary」支持把一次大 turn 拆开切分。`compaction.ts:764`

**恢复语义**：压缩快照**之前**的系统消息也仍在 branch 上（"All system messages on the branch,
including those before a compaction"），且「分支上曾被移除的工具保持非激活」——
即**工具装载状态也是树的一部分**。`agent-session.ts:1909`、`:1916`、`:1922`

### 6) 持久化

- **格式**：JSONL，一条 entry 一行，append-only。
  `session-manager.ts:985`
- **路径**：`~/.pi/agent/sessions/<cwd 编码后的安全目录名>/<时间戳>_<sessionId>.jsonl`
  `session-manager.ts:588`、`:594`、`:1088`
- **cwd 编码**：把工作目录编码进目录名（注释 "Encodes cwd into a safe directory name"）。
  `session-manager.ts:588`
- **版本字段**：`version?: number`（注释：v1 sessions 没有）。
  `session-manager.ts:45`
- **发现是 best-effort**：不可读/超大文件不算会话，**单个损坏文件不得拖垮其它会话的发现**。
  `session-manager.ts:734-735`、`:755`、`:960`
- 其它落盘：认证 `core/auth-storage.ts`（16,805 B）、崩溃日志 `core/crash-log.ts`、设置
  `core/settings-manager.ts`（47,254 B）、HTML 导出 `core/export-html/`。

### 优势（≥2）

1. **树的不可变性是压缩安全性的结构保证**：摘要只是新增一个 entry，历史永远在磁盘上。
   这让「压缩后后悔」是可恢复的，而不是破坏性操作（`session-manager.ts:985` + `compaction.ts:342`）。
2. **取消被拆成 5 个独立控制器**，粒度到「每个 bash 子进程一个」（`agent-session.ts:454`），
   因此能精确中止而不误杀并行的其它工作。
3. **重试预算跨场景复用**：普通轮次与压缩共用同一 backoff 配置，退避等待可被用户中断
   （`agent-session.ts:3901`、`:3968`），不会出现「卡在退避里按 Ctrl-C 没反应」。
4. **压缩是链路闸门而非补丁**（`agent-session.ts:839`），从根上避免超窗。
5. **失败语义显式**：半截摘要被判定为失败（`compaction.ts:590`），并有 `session_compact_failed` 事件通道。

### 缺点（≥2）

1. **单文件巨石**：`agent-session.ts` 170,518 B / ≈4581 行，承载工具装载、压缩、重试、事件、
   模型恢复、分支管理六件事——所有并发状态（5 个 controller）都在这一个类里，审阅与测试成本极高。
2. **append-only 只增不减**：没有任何 compaction/GC 机制清理 JSONL 本身（整轮扫描只见追加），
   长会话文件会无限增长；只有「发现」阶段有 oversized 过滤（`session-manager.ts:734`），不解决增长。
3. **压缩的「无损」依赖 LLM 自律**：靠 prompt 里的 "PRESERVE all existing information" 约束
   （`compaction.ts:541`）而非校验；只有 output 截断能被自动发现，**信息被悄悄丢掉时无检测**。
4. **内置工具与扩展的组织方式在源码中不易定位**：`packages/coding-agent/src` 下没有 `tools/` 目录，
   工具的「8 个内置」清单无法从目录结构直接读出（本轮实测），新人上手成本高。

---

## open-design

### 0) 先回答定性问题：**产品，不是库；有运行时。**

实测 `apps/` 下 5 个应用，且都带可执行入口：

| 应用 | package name | 入口 |
|---|---|---|
| `daemon` | `@open-design/daemon` | `bin: { od: ./bin/od.mjs }`, `main: ./dist/cli.js` |
| `desktop` | `@open-design/desktop` | `main: ./dist/main/index.js`（Electron 主进程） |
| `web` | `@open-design/web` | `sidecar/server.ts` |
| `closure` | `@open-design/closure` | `main: ./dist/index.mjs` |
| `packaged` | `@open-design/packaged` | `main: ./dist/index.mjs` |

证据：`apps/{closure,daemon,desktop,packaged,web}/package.json`（`od` 这个 bin 名说明它是**给用户的 CLI 产品**）。
README 自述：**"OpenDesign is the 1st collaborative AI design agent workspace"**（`README.md:26` 附近），
不是 design-system 库。

**运行时栈**：Express HTTP 服务 + Electron 桌面壳 + web sidecar。
- `apps/daemon/src/server.ts:3290`、`:3295`、`:3305`、`:3330`、`:3500`、`:3847`（`express.static`）
- `apps/web/sidecar/server.ts`（sidecar 进程，独立 server）

### 1) 一次任务的完整链路

1. **请求进入 daemon**：`app.use(express.json({ limit: '4mb', verify: captureJsonBodySize }))` 统一挂
   body 解析与体积计量。`apps/daemon/src/server.ts:3305`
2. **大载荷走独立解析器**：素材入库 `/api/library/ingest` 128mb、品牌抽取
   `/api/brands/:id/extract-from-html` 32mb。`server.ts:3290`、`:3295`
3. **/api 中间件链**：三处 `app.use('/api', ...)`（`:3330`、`:3500`）做鉴权/主体注入/错误包装，
   最终统一错误出口在 `:3487`、`:3372`。
4. **run 状态处理**：`retryFinalResultForRunStatus`（导入于 `:178`，另导出测试别名 `:228`）
   —— 一次 run 的「最终结果」是**可重试补齐**的独立阶段，说明 run 是异步长任务、结果可能晚到。
5. **事件推给前端**：`apps/web/src/hooks/useEventStream.ts`（SSE/事件流），
   前端靠事件而非轮询跟上进度。
6. **静态资源兜底**：`:3847` `express.static(staticDir)`。

### 2) 工具或能力的注册方式

- 工具能力的组织单位是 **plugin 目录 + route 注册函数**，不是统一 schema 注册表：
  实测 `registerPublicFileStopRetryRoutes`（`server.ts:1073` 导入）这类 `register*Routes` 命名，
  说明路由按功能模块拆文件、集中注册。
- 还有 `apps/daemon/src/routes/public-file-stop-retry.ts` 这类独立路由文件。
- 前端能力注册：`apps/web/src/runtime/exports.ts`（runtime 导出层）。
- **未验证**：是否存在类似 craft 的「单一声明式工具注册表」。本轮**未找到**统一 tool registry 文件；
  观察到的是 Express 路由 + 功能模块函数注册。

### 3) 并发与取消

- **取消是一等公民**：存在专门的错误判别器 `isAbortedOperationError`（`server.ts:282` 导入
  `./integrations/aborted-error.js`），即取消被建模成**可识别的错误类型**而非裸异常。
- **sidecar 代理取消**有独立测试：`apps/web/tests/sidecar-proxy-cancellation.test.ts`、
  `sidecar-proxy-keepalive.test.ts`、`sidecar-proxy-daemon-unavailable.test.ts` —— 说明
  web↔daemon 之间的代理层显式处理取消、保活、对端不可用三种态。
- **sidecar 关闭**有测试：`apps/web/tests/sidecar-shutdown.test.ts`。
- **停止重试的路由**：`routes/public-file-stop-retry.ts`（`server.ts:1073`）。
- **启动期重试器**：`retryShareBindingsAtStartup`（`:5576`）、`retryPublicFileStopsAtStartup`（`:5594`）。
- 版本竞争的取消语义：`:6030`「aborts the in-flight pull when a higher published version supersedes it」
  —— **新版本发布即取消旧版本的拉取**，这是很具体的并发设计。

### 4) 错误处理与重试

- **重试策略被抽成独立模块**：`./run-retry-policy.js` 导入于 `server.ts:590`。
- **事件化的重试生命周期**：`event.phase === 'retry-scheduled' || 'retry-exhausted'`
  （`:6041-6042`）—— 重试的排期与耗尽都是**可观测事件**。
- **可重试性逐案标注**：错误对象上挂 `retryable` 布尔（`:4158`），并对特定错误显式置
  `retryable: false`（AMR 模型不可用，`:2893-2895`）—— 不盲目重试不可恢复错误。
- **面向用户的错误文案生成**：`:2853` 有「The run failed due to an unknown upstream streaming error.
  Please retry.」这类兜底消息，`:2893` 是模型可用性的定向修复建议。
- **重试风暴防护**：`:6518` 注释「not signal again, avoiding a retry storm while the 30s poll remains」
  —— 用 30s 轮询兜底 + 不重复发信号来防风暴。
- **后台任务失败不致命**：`:5652-5661` share binding 重试失败只 `console.warn('... unavailable')`。
- **上报器不能中断主路径**：`:2477` 注释「intact instead of aborting the reporter before it reaches
  that path」—— 可观测性失败不得影响业务。

### 5) 上下文管理

- **未验证 / 未找到**：本轮未在 open-design 中找到等价于 pi session tree 的上下文压缩机制。
- 可确认的相关能力：`apps/daemon/src/critique/artifact-handler.ts`（产物处理器）、
  `apps/web/src/hooks/useEventStream.ts`（流式更新）。
- 简报提到「token 两套」（设计 token 两套）。本轮**未验证**其实现位置——但结合定性结论
  （产品有完整前后端），「两套 token」更可能是**产品设计系统层面的 token**（品牌/主题），
  而非 LLM 上下文 token 预算。**此判断需下一轮确认，本轮不下定论。**

### 6) 持久化

- **未验证**：本轮未定位到具体落盘格式（未读 db/schema 目录）。
- 可确认的落盘点：
  - 素材库 `/api/library/ingest`（128mb 上限，说明会存二进制资产）
  - 品牌：`/api/brands/:id/extract-from-html`
  - 分享绑定 outbox：`shareBindingOutbox`（`server.ts:5576`）—— **outbox 模式**，先写本地再重试外发
  - 公开文件停止记录：`retryPublicFileStopsAtStartup`（`:5594`）同样具备启动期补偿
  - 团队项目元数据：`:4532`（带 principal/teamId/projectId 维度）

### 优势（≥2）

1. **取消与重试都被显式建模并可观测**：`isAbortedOperationError` 作为独立错误类型
   （`server.ts:282`）+ `retry-scheduled`/`retry-exhausted` 事件（`:6041`），比裸 try/catch 成熟得多。
2. **重试风暴与「不该重试」都有对策**：30s 轮询兜底且不重复发信号（`:6518`），
   不可恢复错误显式 `retryable: false`（`:2895`）。
3. **outbox + 启动期补偿**模式贯穿分享与公开文件（`:5576`、`:5594`），意味着进程崩溃后外部一致性可自愈。
4. **可观测性不侵入主路径**（`:2477`），上报失败不拖垮业务。
5. **按载荷分级 body 上限**（4mb / 32mb / 128mb，`:3305`/`:3295`/`:3290`），真实工程细节。

### 缺点（≥2）

1. **`apps/daemon/src/server.ts` 是巨型单文件**：实测行号跨度 >6500 行，混装路由、错误策略、
   启动补偿、代理、版本竞争、SSE —— 与 pi 的 `agent-session.ts` 是同一类问题。
2. **没有声明式工具注册表**：能力靠 `register*Routes` 函数分散注册，无法像 craft 那样从单一
   数据源派生多面（MCP/CLI/Agent），新增能力要动多处；也没有工具元数据（effects/schema）可比对。
3. **重试语义散落**：`run-retry-policy.ts` 是模块化的，但 `retryable` 判定又以字面量散在
   业务分支里（`:4158`、`:2895`），策略与判定不在同一处。
4. **错误文案写死在服务端**（`:2853`、`:2893`），本地化与前端文案治理会打架。

---

## craft-anything

### 1) 一次任务的完整链路（以三面共用一条链路为核心）

1. **启动构建注册表**：`Registry::with_all_tools()` → `Registry::new(crate::tools::all())`。
   `crates/engine/src/registry.rs:83`、`:84`
2. **注册表去重**：重复 id 被 log 后**忽略**（不是 panic）。
   `registry.rs:72-79`
3. **运行时工具叠加**：`with_runtime(tools)` 校验 id 合法（小写字母/数字/`_`，1-64 字符）、
   schema 必须是 object、不得重名，然后 `Box::leak` 固化字符串。
   `registry.rs:89-113`、`:32-34`、`:96`
4. **三面各自读同一注册表**：
   - MCP：`"tools/list" => self.tools_list()`。`crates/mcp/src/lib.rs:314`
   - CLI：`s.cli_name()` 生成 kebab 命令。`apps/craft-anything-cli/src/main.rs:332`、`:343`
   - Agent：同一批 `ToolSpec` 直接作为可调用工具（`tool_list.rs:17` 原文声明）
5. **调用期校验**：可见性 `self.visible(s.toolset)` + Clean room 白名单
   `craft_anything_engine::clean_room::allows(s.id)`。`crates/mcp/src/lib.rs:383`、`:390`
6. **目标参数补齐**：`requires == Requires::Target` 的工具若没给路径，CLI 直接给用法错误。
   `apps/craft-anything-cli/src/main.rs:547`
7. **执行**：`ToolSpec.run`（`ToolFn`），上下文是 `Ctx<'a>`，内含 `cancel: CancelToken`。
   `crates/engine/src/tool.rs:230`、`:234`

### 2) 工具注册方式 ★重点：303 工具如何「三面一源」

**单一数据结构** `ToolSpec`（`crates/engine/src/tool.rs:273-286`）：

```rust
pub struct ToolSpec {
    pub id: &'static str,          // snake_case；同时是 MCP 工具名
    pub title: &'static str,
    pub summary: &'static str,     // 给 agent 与熟练用户
    pub beginner: &'static str,    // Beginner 模式的纯英文描述
    pub toolset: Toolset,
    pub effects: Effects,
    pub requires: Requires,
    pub input_schema: fn() -> Value,
    pub run: ToolFn,
}
```

**三面派生的具体机制**：

| 面 | 派生规则 | 证据 |
|---|---|---|
| MCP 工具名 | 直接用 `id`（snake_case） | `tool.rs:274` 注释「also the MCP tool name」 |
| CLI 命令 | `id.replace('_', "-")`（kebab） | `tool.rs:294-298` `cli_name()` |
| Agent 工具 | 同批 spec 直接可调 | `tool_list.rs:17` |
| 参数 schema | `input_schema: fn() -> Value` 惰性生成 | `tool.rs:284`；`schema_of::<T>()` = `schemars::schema_for!` `tool.rs:301-303` |
| CLI 参数 | 由 JSON Schema 的 properties **反向生成** `--kebab-case` 旗标 | `apps/craft-anything-cli/src/tool_args.rs:170`、`:227`、`:290` |

关键点：**CLI 的 `--flag` 不是手写的，是从 schema 的 `props.keys()` 反射出来的**
（`tool_args.rs:170`：`props.keys().map(|k| format!("--{}", k.replace('_', "-")))`），
`:290` 直接拼 help 文本 `format!("  --{:<28} {ty}{star}  {desc}\n", ...)`。
这就是「一源」的真正含义：**schema 是唯一真源，CLI 帮助/解析、MCP inputSchema、Agent 工具描述全部由它派生**。

**注册表本体**（`registry.rs:60-66`）：

```rust
pub struct Registry {
    specs: Vec<ToolSpec>,
    index: BTreeMap<&'static str, usize>,     // id -> 下标，O(log n) 查
    schemas: BTreeMap<&'static str, Value>,   // 仅运行时工具的 schema
}
```

- 内置工具的 schema 走 `(spec.input_schema)()` 函数指针；运行时工具走 `schemas` map。
  统一入口 `input_schema(&self, spec)`：`self.schemas.get(id).cloned().unwrap_or_else(|| (spec.input_schema)())`。
  `registry.rs:116-118`
- `RuntimeTool` 是**插件与外部 MCP 代理工具**的统一表示（注释：plugin's, or one proxied from an
  external MCP server），且 `run` 可以**一个闭包服务多个工具**，靠 `Ctx::tool` 区分。
  `registry.rs:13-28`
- 自定义 toolset id 用 `OnceLock<Mutex<Vec<&'static str>>>` + `Box::leak` 做**进程内一次性驻留**。
  `registry.rs:38-58`
- **AREA 约束**：工具 id 首词必须是 29 个 area 之一（`core, native, managed, java, android, apple,
  harmony, js, web, app, firmware, formats, radio, packets, db, assets, game, project, rebuild, build,
  runtime, adb, frida, engines, settings, plugins, setup`）。`registry.rs:8-11`
- **工具集是 MCP 侧的渐进披露单位**：默认只列 Essentials，靠 `list_toolsets` / `enable_toolset`
  元工具逐步开启，开启时发 `notifications/tools/list_changed`；`--all-tools` 全开。
  `crates/mcp/src/lib.rs:3-5`、`:401`、`:431`、`:507`
  且**调用未开启工具集里的工具会自动开启而非拒绝**（`:521-525`）——降低 agent 卡死概率。
  元工具本身也注册在列表里：`meta_list_toolsets()`（`:813`）、`enable_toolset`（`:402`）。

**`cargo xtask tools` 生成什么**：

- 命令分派：`Some("tools") => tools(&root, args.iter().any(|a| a == "--check"))`。
  `xtask/src/main.rs:44`
- 生成物 = `docs/tools.md`：`crates/engine/src/tool_list.rs:1-2`（注释「`cargo xtask tools` writes it to
  `docs/tools.md`」）、`:14`（标题行 "Generated by `cargo xtask tools`. Do not edit by hand."）
- 内容结构：按 toolset 分组，每组标题 `## {title} ({id}, {count})`，条目 `- \`{id}\`: {title}`。
  `tool_list.rs:21-31`
- 头部统计句：`**{n} engine tools** in {m} toolsets`，并声明每个工具「is an MCP tool, a CLI command
  (`craft-anything-cli <id with dashes>`) and a tool the agent can call」。`tool_list.rs:15-20`
- **有下限守卫**：`pub const MIN_TOOLS: usize = 271;` + 测试 `the_tool_count_never_drops`
  断言 `Registry::with_all_tools().all().len() >= MIN_TOOLS`；注释要求「只能加不能减」。
  `tool_list.rs:6-7`、`:40-43`
- 另有 `the_list_names_every_tool_once` 保证每个 id 在文档中恰好出现一次（`matches(...).count() == 1`）。
  `tool_list.rs:45-52`
- `--check` 模式用于 CI 校验文档与代码同步（`main.rs:44` 的布尔参数）。
- 其他同族生成器：`schemas`（→ `docs/schemas/{name}`，`main.rs:45`、`:378`）、`layers`、`locks`、
  `status`、`i18n-coverage`、`wasm`、`licenses`、`version`、`pending`、`secrets`、`ico`、`ci`。
  `main.rs:40-55`

> **诚实说明关于「303 工具」**：代码里的**硬性下限是 271**（`tool_list.rs:7`），
> 实际数量由 `registry.all().len()` 运行期决定，该值写入 `docs/tools.md` 头部。
> 本轮**未读到 docs/tools.md 的实际数字**，故「303」这一具体数值**未在本轮验证**；
> 可确认的是「≥271 且只增不减」的机制存在。

**能力元数据（比工具签名更重要的一层）**：`Effects` 位标志
（`crates/engine/src/tool.rs:36-57`）——`EVIDENCE`/`NATIVE_EVIDENCE`/`NETWORK_EVIDENCE`/`READ_ONLY`，
并派生出三类风险查询：是否 destructive（`MAY_DISCARD_DATA | EXECUTES_FOREIGN_CODE | MUTATES_DEVICE`）、
是否需要权限（`LAUNCHES_PROCESS | ACCESSES_NETWORK`）、是否需沙箱（`EXECUTES_FOREIGN_CODE | MUTATES_DEVICE`）。
`tool.rs:45`、`:49`、`:53`、`:57`

### 3) 并发与取消

- **协作式取消**：`pub use craft_anything_platform::cancel::CancelToken;`，注释说明它放在 `platform`
  层是为了「与长任务共享」。`crates/engine/src/tool.rs:215-217`
- 每个工具调用都拿到 `Ctx { cancel: CancelToken, .. }`。`tool.rs:230`、`:234`
- 跨平台抽象：走 `craft_anything_platform::sync::Mutex`（而非直接 `std::sync`）。
  `registry.rs:39`、`:41`
- 注册表并发热点用 `OnceLock` + `Mutex` + `PoisonError::into_inner`（**中毒不 panic，恢复继续**）。
  `registry.rs:41`、`:48`
- **未验证**：工具级并行度上限、MCP 请求并发模型本轮未读（`crates/mcp/src/lib.rs` 只读到
  tools/list 与元工具部分）。

### 4) 错误处理与重试

- **结构化错误**：`ToolError { code: ErrorCode, .. }` + `ErrorCode::StaleRevision` /
  `ErrorCode::invalid(..)`。`crates/evidence/src/unknown.rs:73`、`:77`
- **错误必须带补救建议**：`.with_remediation("Read the unknown again and retry with its current revision.")`
  `unknown.rs:74`；`with_remediation("Call list_toolsets to see the ids.")` `crates/mcp/src/lib.rs:495`
  —— 错误本身就是给 agent 的下一步指令，这是很值得抄的设计。
- **不 panic 的错误哲学**：重复 id 只 `log::error!` 后继续（`registry.rs:74`、`:93`）；
  互斥锁中毒恢复（`registry.rs:48`）。
- **未验证**：网络/进程类工具的自动重试策略本轮**未找到**统一 retry 模块；
  从 `Effects` 里没有 retry 相关位来看，重试可能是各工具自理。

### 5) 上下文管理

- 没有 pi 式的对话树压缩；craft 的「上下文管理」是**账本式**的两本账：
  1. **证据账本**：`crates/evidence/src/lib.rs:203 struct Evidence`，`id`（`:206`）由
     `format!("ev_{}", sha256_hex(canonical_json(&v).as_bytes()))` 生成（`:252`）——
     **内容寻址**，同内容必然同 id，天然去重且可校验。
     `Subject { kind, sha256: Option<String>, name }` 定义被证对象（`:67`、`:70`、`:180`），
     并有 `EvidenceBuilder`（`:327`）。
  2. **未知项账本**：见第 6 节。
- 设计意图：agent 的「记忆」不是对话历史，而是**可验证事实 + 待解决疑问**两张表，
  这让结论可追溯到 sha256 级别的证据。

### 6) 持久化 ★重点：unknown.rs 账本结构

`crates/evidence/src/unknown.rs`（3,888 B）：

```rust
// :8-15
enum UnknownStatus { Open(默认), Investigating, Blocked, Contradicted, Resolved }

// :19-25
enum Severity { Low, Medium(默认), High, Critical }

// :30-47
struct Unknown {
    id: String,            // "unk_" + 前 16 位 sha256(question + domain)
    revision: u64,
    question: String,
    severity: Severity,
    domain: String,        // 领域：native / network / ui / storage ...
    status: UnknownStatus,
    probes: Vec<String>,        // 「什么能解决它」：探针、要跑的工具、要查的事实
    evidence_for: Vec<String>,
    evidence_against: Vec<String>,
    resolution: Option<String>,
}
```

**三个必须点名的机制**：

1. **ID 是内容寻址的**：`Unknown::new()` 用 `sha256_hex(canonical_json(&{question, domain}))`
   取前 16 位，`id = format!("unk_{short}")`。`unknown.rs:53-57`
   → 同一问题重复提出会得到同一 id，天然幂等。
2. **乐观并发**：`apply_update(&mut self, based_on_revision, next)`，版本不匹配返回
   `ErrorCode::StaleRevision` 并附补救建议；匹配则 `next.revision = self.revision + 1`。
   `unknown.rs:71-83`；测试 `optimistic_concurrency` 验证 rev 1→2 且旧版本报 StaleRevision。`:96-105`
3. **完成态强约束**：`resolution_is_valid()` 要求 `status == Resolved` **且** resolution 非空
   **且** `evidence_for` 非空。`unknown.rs:86-88`
   另外 `apply_update` 里也拦一道：Resolved 缺 resolution 直接 `ToolError::invalid`。
   `unknown.rs:76-78`
   → **「已解决」不能只改状态，必须给出结论 + 至少一条正面证据**。

**其它落盘**（部分）：
- `docs/tools.md`（由 `cargo xtask tools` 生成，禁止手改）`tool_list.rs:14`
- `docs/schemas/{name}`（由 `cargo xtask schemas` 生成）`xtask/src/main.rs:378`
- 会话级证据：`Effects::MUTATES_SESSION`（`tool.rs:36`）说明证据写到会话范围而非全局。
- 引入 `about.hbs`/`about.toml`（licenses 生成）、`Cargo.lock` 锁文件校验（`xtask/src/locks.rs`）。

### 优势（≥2）

1. **真正的「三面一源」，而且是最彻底的那种**：`ToolSpec` 一个结构同时喂 MCP schema、
   CLI 的 `--flag` 解析与 `--help` 文本（`tool_args.rs:170`、`:290`）、Agent 描述；
   CLI 参数**不是手写**的而是从 JSON Schema 反射出来（`tool_args.rs:227`）——
   这是三个项目里唯一做到「加一个工具、三面同时出现且不漂移」的架构。
2. **元数据比签名更有价值**：`Effects` 位标志（`tool.rs:36-57`）让「是否破坏性/是否需要权限/
   是否需要沙箱」变成可计算属性，权限与 UI 无需维护第二份清单。
3. **错误即指令**：`with_remediation(...)`（`unknown.rs:74`、`mcp/src/lib.rs:495`）把下一步动作
   写进错误体，直接降低 agent 卡住的概率。
4. **未知项账本有完成态强校验**：Resolved 必须带结论 + ≥1 正面证据（`unknown.rs:86-88`），
   把「装懂」在数据结构层面堵死。
5. **文档与代码不漂移**：`cargo xtask tools --check` + `MIN_TOOLS` 下限 + 「每个 id 恰好出现一次」
   测试（`tool_list.rs:40-52`），文档同步是 CI 强制的。
6. **渐进披露工具集**：默认只暴露 Essentials，按需 `enable_toolset`，且调用未开启工具会自动开启
   （`mcp/src/lib.rs:521-525`）——271+ 工具能塞进上下文的关键。

### 缺点（≥2）

1. **`&'static str` + `Box::leak` 的代价**：运行时工具一旦注册就**永久占用内存**
   （`registry.rs:16`「keeps its strings for the rest of the process」、`:52`、`:96`），
   插件热重载/大量外部 MCP 工具代理场景下内存只增不减。
2. **`Path` 仍是字符串**：`id: &'static str` + `BTreeMap<&'static str, usize>`（`registry.rs:62-63`），
   编译期无法保证 id 唯一——只能靠运行期 `log::error!` 忽略重复（`registry.rs:73-75`），
   漏了不会被编译或测试发现（除非恰好触到 `the_list_names_every_tool_once`）。
3. **schemas 与 specs 双存储**：运行时工具的 schema 单独存在 `schemas` map，
   内置工具走函数指针（`registry.rs:65`、`:116-118`），`input_schema()` 里 set 的并集意味着
   两条路径的 schema 校验强度不同。
4. **无统一重试层**（本轮未找到）：`Effects` 无 retry 维度，重试责任散在 271+ 个工具自身。
5. **锁中毒处理是「吞掉」**：`unwrap_or_else(PoisonError::into_inner)`（`registry.rs:48`）
   保证了不 panic，但也意味着**一次 panic 后的状态被继续使用**，没有任何告警。

---

## 对比表

| 维度 | pi | open-design | craft-anything |
|---|---|---|---|
| **形态** | CLI/agent 框架 + 插件生态（产品化） | **完整产品**，非库（daemon+desktop+web+closure+packaged 五 app） | CLI + MCP server + desktop(egui/web) 多面产品 |
| **语言/量级** | TS，`agent-session.ts` 170KB/≈4581 行 | TS，`apps/daemon/src/server.ts` >6500 行 | Rust，29 crates + 3 apps + xtask |
| **运行时** | Node/Bun 进程内 loop | **Express HTTP 服务 + Electron 桌面 + sidecar** | 原生二进制，MCP over stdio |
| **任务链路核心** | 配置→工具快照→注入 loop 回调→压缩闸门→事件流 | HTTP 请求→分级 body 解析→/api 中间件→run→事件流→静态兜底 | 建注册表→三面派生→可见性/Clean room 校验→`ToolSpec.run(Ctx)` |
| **工具注册** | 无单一注册表：扩展 `Map<string, RegisteredTool>` + 命名过滤器 + MCP 命名空间判定 | **无声明式注册表**，`register*Routes` 函数分散注册 | **唯一注册表** `Registry{specs,index,schemas}`，`ToolSpec` 单一真源 |
| **多面派生** | 弱：MCP/扩展/内置各自接入 | 无（仅 HTTP 面） | **强：MCP 名=id、CLI=kebab、Agent 同 spec、`--flag` 从 schema 反射** |
| **工具数量纪律** | 未验证（8 内置/70 扩展未定位） | 未验证 | `MIN_TOOLS=271` 下限 + `--check` + 唯一性测试 |
| **并发/取消** | **5 个专用 AbortController + 每 bash 一个**（`:437-454`） | 取消=可识别错误 `isAbortedOperationError`；代理层有取消/保活/不可用三态测试 | 协作式 `CancelToken`（platform 层共享），互斥锁中毒恢复 |
| **重试** | 指数退避 + **退避可中断** + 预算跨场景复用（`:3901-3968`） | 独立 `run-retry-policy` + `retry-scheduled/exhausted` 事件 + 防风暴 | **未找到统一重试层**（责任下沉到工具） |
| **错误哲学** | 可重试白名单 + 显式失败事件 | 逐案 `retryable` 标注 + 定向用户文案 | **错误即指令**：`with_remediation` + `ErrorCode` 校验 |
| **上下文管理** | **append-only session tree + 摘要 entry 落盘**（磁盘无损/上下文有损） | 未找到等价机制（未验证） | **账本式**：内容寻址证据 `ev_{sha256}` + 未知项 `unk_{sha256前16}` |
| **持久化格式** | JSONL，`~/.pi/agent/sessions/<cwd>/<ts>_<sid>.jsonl` | 未读具体格式；`shareBindingOutbox` outbox 模式 | `docs/tools.md`/`docs/schemas/*` 由 xtask 生成禁手改；账本结构化序列化 |
| **压缩/收敛** | `keepRecentTokens=20000` 切点 + 增量摘要「PRESERVE all」 | 未验证 | 无压缩；用 `Resolved` 强校验（结论+≥1证据）收敛未知项 |
| **文档与代码同步** | 未见机制 | 未见机制 | **CI 强制**：`xtask tools --check`、`schemas --check`、`locks`、`i18n-coverage` |
| **最值得抄** | 摘要作为 entry 落盘 → 压缩可回滚；退避可中断 | outbox + 启动期补偿；可观测性不侵入主路径 | **schema 单源派生三面**；`Effects` 位标志；错误带 remediation |
| **最大问题** | 单文件巨石 + JSONL 只增不减 + 摘要靠 LLM 自律 | 单文件巨石 + 无声明式注册表 + 重试语义散落 | `&'static str`+leak 内存只增 + id 唯一性仅运行期 + 锁中毒吞掉 |

---

### 本轮未验证清单（诚实标注，勿引用为结论）

1. pi「8 个内置工具」的具体清单 —— `packages/coding-agent/src` 下**无 `tools/` 目录**。
2. pi「70 个示例扩展」—— `src/extensions/` 实测仅 4 个（`codemode, llama, mcp, tool-search`）。
3. craft「303 工具」—— 代码硬下限是 **271**（`tool_list.rs:7`），实际数值在 `docs/tools.md` 头部，未读。
4. open-design「token 两套」的具体实现位置 —— 疑为设计系统 token（品牌/主题）而非 LLM 上下文 token。
5. open-design 的持久化格式与数据库 schema。
6. 三个项目的工具级并行度上限（pi 在 `agent-loop.ts` 内、craft 在 mcp 请求层、open-design 在 run 调度层）。
