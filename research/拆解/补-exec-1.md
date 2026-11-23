# 补拆：orca / omp-studio / AionUi 的执行逻辑

> 只读分析。只覆盖「执行逻辑」一个维度。凡本次检索未证实的，显式标注「未找到」。
> 检索方式：顶层 ls + rg 关键词定向扫描（`runAgent|agentLoop|toolCall|abort|cancel|retry|backoff|compact|sqlite|jsonl|ipcMain.handle`）。

---

## orca

`D:\refs\orca` — Electron 43 + React 19 + Tailwind v4 + shadcn，版本 1.4.214。
主进程入口 `package.json:11` → `./out/main/index.js`。源码分 `src/{main,preload,renderer,shared,cli,packages,wsl-guest,types}`。

### 任务链路

- **orca 不自带 agent loop，它是「外部 agent CLI 的宿主 + 方言适配层」。** `src/main` 下并列 22 个 provider 方言目录：`amp`、`antigravity`、`claude`、`codex`、`copilot`、`cursor`、`devin`、`droid`、`gemini`、`grok`、`hermes`、`jcode`、`kimi`、`kiro`、`mimo`、`muse`、`openclaude`、`opencode`、`pi`、`qoder`、`qwen-code`、`zcode`。每个方言负责「怎么拉起这个 CLI、怎么解析它的输出」。
- **链路 A（渲染层 → 主进程）**：renderer 通过 preload 的 `ipcRenderer.invoke` 打到 `ipcMain.handle` 命名的通道。证据通道名：`agentStatus:getSnapshot`、`agentStatus:inferInterrupt`、`agentStatus:inferQuestionAnswered`、`agentStatus:hasVerifiableAgentProcess` [证据: `src/main/ipc/agent-hooks.ts:41`, `:51`, `:57`, `:63`]。
- **链路 B（主进程 → 子进程）**：Provider 进程由 supervisor 用 `spawn(providerCommand, providerArgs, {...})` 拉起 [证据: `src/main/provider-process/provider-process-supervisor.ts:53`]。stdio 写侧有独立队列串行化 [证据: `src/main/provider-process/provider-stdio-write-queue.ts:11` `private readonly queue: Write[]`]。
- **链路 C（子进程 → 回显）**：走 JSONL-RPC 双向流 + ACP 结构化事件。ACP 协议里带 `cancelled` 终态 [证据: `src/main/acp/generated/acp-protocol.generated.ts:850` z.literal('cancelled')]。渲染侧通过 transcript 读取器/尾部读者/监听器把落盘的会话文件增量转成消息 [证据: `src/main/native-chat/transcript-reader.ts`、`transcript-tail-reader.ts`、`transcript-watch.ts`、`transcript-read-cache.ts`]。
- **回显不是「主进程持有内存会话对象」，而是「读 transcript 文件 + 合并本地 journal」**：本地 journal 与外部 transcript 两套事实源并存，`native-chat/agent-session-journal/` 负责本地落盘态（含 `queuedMessages`）[证据: `src/main/native-chat/agent-session-journal/journal-store.ts:82` `readonly queuedMessages`]。

### 工具注册

- **未找到 orca 自建的中心化 tool registry。** 全仓 `registerTool|toolRegistry|ToolRegistry` 检索在 `src/main` 下无结果，唯一命中是 SSH 测试夹具里的 `const tools = [...]` [证据: `src/main/ssh/hostile-host-test-support/ssh-hostile-host-test-fixture.ts:213`]。**结论：工具集由外部 agent CLI 自带，orca 只做透传与展示。**
- **orca 自己拥有的是「能力包 / Skill」体系，不是 tool**：Skill 以 `SKILL.md` 为契约文件被发现和打包 [证据: `src/main/skills/package-archive/skill-package-creation.ts:65` 校验 `SKILL.md` 存在; `:83` `summarizeSkillMarkdown(...)`]。Skill 有上传/云端分发/删除暂存等完整生命周期 [证据: `src/main/skills/runtime-upload/skill-upload-session-record.ts:20`、`src/main/skills/cloud/skill-cloud-package-service.ts:98`]。
- 因此「工具被调用」在 orca 眼里就是一条 `toolCall` 类型的 transcript 记录，由 `native-chat/transcript-decoding/` 下的方言解码器还原（含 omp 方言）[证据: `src/main/native-chat/transcript-decoding/transcript-line-decoders-omp.ts:230` `case 'toolCall':`]。

### 并发取消

- **能同时跑几件事**：不是全面并行，而是「多 agent 会话并行 + 同名操作串行」。串行化用 keyed 队列，且刻意区分「暂存可乱序 / 发布必须持共享路径队列」[证据: `src/main/native-chat/conversation-context/agent-session-context-snapshots.ts:5` `runKeyedSerializedOperation`，`:40` 注释 "Staging can finish out of order; only publication holds the shared path queue"]。
- 有优先级信号量做闸门 [证据: `src/main/native-chat/agent-model-catalog/agent-model-catalog-lister.ts:2` `import type { PrioritySemaphore }`; `:125` `const queuedAt = Date.now()`]。
- 有按 key 的并发上限（如附件分片上传）[证据: `src/main/native-chat/agent-session-attachments/chunked-upload-registry.ts:10` `maxConcurrent: number`; `:31` `if (this.entries.size >= this.options.maxConcurrent)`]。
- **取消**：全链路 `AbortSignal` 贯穿，且**在「连接尚未建立」的窗口期就装好取消监听**，避免取消丢失 [证据: `src/main/provider-process/provider-acquisition-starts.ts:22` 注释 "Install cancellation before acquisition can yield"; `:29` `attempt.signal.addEventListener('abort', attempt.stopConnection, { once: true })`; `:36` `if (attempt.signal.aborted)`]。交接给会话后由 Session Stop 接管同一套取消，且显式摘掉旧监听以免被误判成崩溃 [`provider-acquisition-starts.ts:41` 注释 "Session Stop owns cancellation after handoff; this listener would make it look like a crash"]。
- **进程级兜底**：SIGTERM 带一个**有意设得很短**的 grace [`src/main/provider-process/managed-provider-process.ts:8` `PROVIDER_BRIEF_SIGTERM_GRACE_MS`; `:243` `? { briefGraceMs: PROVIDER_BRIEF_SIGTERM_GRACE_MS }`]。
- JSONL-RPC 层取消：`controller.abort(error)` [证据: `src/main/jsonl-rpc/peer.ts:173`]。协议层面约定「方言先发 abort，supervisor 再关进程连接」[证据: `src/main/jsonl-rpc/agent-connection.ts:199` 注释]。

### 错误重试

- **在 agent 执行主链路上未找到 orca 自建的退避重试**。重试语义被下推给方言/CLI 自身。
- 有的是「取消感知的等待」工具，不是重试：`waitForPromiseWithSignal` [`src/main/acp/conversation-copy/acp-conversation-copy.ts:12`]，以及 abort/cancel 竞速 [`src/main/acp/discovery/acp-session-discovery.ts:24-32` `Promise.race([work, cancelled])`]。
- 失败观测侧较完整：有 hang watchdog、crash-reporting、observability、diagnostics 等目录（`src/main/{hang-watchdog,crash-reporting,observability,diagnostics}`），说明**采用「快速失败 + 事后归因」而非「静默重试」**。
- **诚实标注**：指数退避未找到，可能不存在于本仓库。

### 上下文管理

- **orca 不做上下文裁剪，它只「识别」别人做的压缩。** 证据：解码器把 `compaction` 记录翻译成一个 `presentation: 'compaction'` 的提示块，并声明「压缩会让之前的 context 度量失效」[证据: `src/main/native-chat/transcript-decoding/transcript-line-decoders-omp.ts:31-36`，`:32` 注释 "Compaction invalidates earlier context measurements."，`:36` `{ type: 'text', text: 'Context compacted', presentation: 'compaction' }`]。
- Codex 方言同一逻辑，且兼容两代存储格式（legacy rollout 的 `context_compacted` 事件 vs 分页 rollout 的 `ContextCompaction` item）[证据: `src/main/native-chat/transcript-decoding/transcript-line-decoders-codex.ts:153-155`，`:196-197`]。
- **代价控制**：有 token 度量与历史导入时的祖先选择逻辑 [`journal-pi-context-import.spec.ts:53` "selects saved compaction ancestry after a large inactive branch"]，但「预算/裁剪」本身由 CLI 负责。**orca 侧无预算执行点。**

### 持久化

- **SQLite（better-sqlite3）是主载体**，且**按域分库**，一域一 `.db`：
  - `profile-state.db` — profile 状态权威库 [`src/main/persistence/profile-state/database/profile-state-database.ts:56` `probe = new Database(dbPath, {...})`; `:74`, `:141`]
  - `agent-model-catalog.db` — 模型目录缓存 [`src/main/native-chat/agent-model-catalog/agent-model-catalog-persistence.ts:202` `new KeyedJsonRowCache(join(directory, 'agent-model-catalog.db'), {...})`]
  - journal 库 [`src/main/native-chat/agent-session-journal/database/journal-database.ts`]
  - `orca-github-cache.db` [`src/main/persistence/loading-store/github-cache/github-cache-database.ts:23`]
- 有明确的**损坏隔离**机制（不是「坏了就重建」，而是隔离保留证据）[`src/main/persistence/profile-state/recovery/profile-state-database-quarantine.ts:43`]。
- **transcript 明文落盘在外部 CLI 自己的目录**，orca 只读 + tail + 缓存 [`session-file-resolver.ts`、`transcript-tail-reader.ts`、`transcript-read-cache.ts`]。
- **只在内存**：流式增量、IPC 快照、UI store。

### 执行逻辑的优势

1. **把 agent 能力做成「可插拔方言」而不是内建 loop —— 对的地方在于升级解耦。**
   22 个 provider 目录各自独立 [`src/main/{claude,codex,gemini,cursor,...}`]，新增一个 agent 只需加一个方言目录，不必动调度核心。为什么这对：orca 是 IDE 不是模型厂商，它卖的是「并行 agent 工作台」。若内建 loop，每次模型换代都要跟进；用方言则可直接复用用户已有的 Claude Max / Codex 订阅，把「谁的模型强」变成用户的选择而非 orca 的负债。

2. **取消是「双保险 + 竞态显式处理」，这在桌面 agent 里是真正的难点。**
   大多数产品死在「点停止时连接还没建好，取消丢了，进程继续烧钱」。orca 在 acquisition 阶段就装 abort 监听并二次检查 `signal.aborted` [`provider-acquisition-starts.ts:22,29,36`]，再加 SIGTERM grace 兜底 [`managed-provider-process.ts:8,243`]。为什么这对：取消路径是分布式时序问题，只靠「先建连再注册」必然漏窗口。

3. **持久化按域分库 + 损坏隔离，而不是一个大 SQLite。**
   `profile-state.db` / `agent-model-catalog.db` / journal 库 / `github-cache.db` 各自独立。为什么这对：agent 会话写入极其频繁（journal 每次流式修订都可能写），把它和「UI 布局/账号状态」放一个库会让 fsync 争用互相拖死；分库后单库损坏不致全盘不可用，配合 quarantine 还能留证。

### 执行逻辑的缺点

1. **工具层完全外包，orca 无法做统一权限管控 —— 出事场景是「换 agent 后语义漂移」。**
   证据：`src/main` 下无中心 tool registry；工具来自各 CLI 自带。**什么场景出问题**：用户在 Claude 方言下审批过的「危险命令确认」策略，切到 Codex 方言后由 Codex 自己的策略决定，orca 既不能强制「删除必须二次确认」，也无法给出一致的工具调用审计口径。对主打「并行多 agent」的产品，这是治理上的空洞。

2. **SIGTERM grace 被刻意设短（"brief"），方言不配合就会丢尾部。**
   证据：命名即意图 [`PROVIDER_BRIEF_SIGTERM_GRACE_MS`, `managed-provider-process.ts:8`]；协议上依赖「方言先发 abort 再关连接」[`agent-connection.ts:199`]。**什么场景出问题**：某个 CLI 版本升级后漏发 abort，或在大文件写入中途被取消 —— 短 grace 下进程被硬杀，transcript 尾部截断，用户看到「会话最后一段丢失/无法恢复」。而 orca 主链路无重试，只能靠 crash-reporting 事后归因。

3. **并发写者不安全只能靠「拒绝」兜底。**
   证据：`structured-agent-session-history-adoption.ts:74` 注释直说 "Codex does not lock threads: concurrent writers silently diverge, so host ownership must reject them"。**什么场景出问题**：同一 thread 被两个 pane 意外认领时，产品行为是报错拒绝而非合并 —— 用户体验上是「明明文件都在，就是不让我继续」，且无法自愈。

---

## omp-studio

`D:\refs\omp-studio` — monorepo，`apps/{desktop,renderer}` + `packages/{client,client-contract,host-client-api,platform,platform-darwin,platform-win32,runtime-installer,studio-host,studio-protocol,testkit,transport-desktop,transport-web}`。
另有 `omp-patch/`（上游 omp 的补丁层）与 `catalog/`（能力目录）。

### 任务链路

- **架构是「Studio 前端 ↔ Host(studio-host) ↔ 外部 runtime 可执行文件」三段式。** Host 不实现 agent，它编排一个外部 runtime 进程。
- **链路**：renderer 发出**带 kind 的命令** → `CommandArbiter` 判定该命令是「可排队」还是「必须独占/可抢占」 → 通过 bridge-client 送到 runtime → runtime 事件回流 → `runtime-projection` 投影 → `conversation-coalescer` 合并增量 → 回显。
- 命令语义在仲裁器里被显式分类 [证据: `packages/studio-host/src/command-arbiter.ts:61` 可排队白名单 `["btw.ask","btw.followUp","btw.abort","session.import.execute","runtime.auth.set","runtime.auth.remove"]` → `return "queue-compatible"`]。
- Runtime 生命周期由 actor 收口，只有 start / relaunch / stop 三个动作 [证据: `packages/studio-host/src/runtime-actor.ts:33` `async start(binding: SessionBinding)`；`:50` `async relaunch()`；`:63` `async stop()`]。
- Session 驻留态由 broker 管，带心跳 [证据: `packages/studio-host/src/session-broker.ts:114` `heartbeatTimer: ReturnType<typeof setInterval> | undefined`；`:198` `if (record.worker !== undefined && record.residency === "online")`]。
- Runtime 身份是可执行的：来源二选一 `system` 或 `custom`，都带 `executable` 与 `executableIdentity` [证据: `packages/studio-protocol/src/contracts/runtime.ts:13-14` `{ kind: "system"; executable?: string; allowLimited: boolean } | { kind: "custom"; executable: string; allowLimited: boolean }`；`:42` `executableIdentity`]。

### 工具注册

- **未找到「工具」粒度的注册表；omp-studio 的注册单位是「agent 定义（agent definition）」。**
  核心在 `omp-agent-definitions-adapter`：它把 agent 定义适配成 runtime 可执行的东西，并**强制注入 `yield` 工具** [证据: `packages/host-client-api/src/omp-agent-definitions-adapter.ts:312` `if (tools && !tools.includes("yield")) tools = [...tools, "yield"];`]。
  为什么 `yield` 要强制注入：说明 runtime 的 agent 是**协作式让出**模型 —— 子 agent 必须显式 yield 才能把控制权交回编排层，这是多 agent 并发的关键原语。
- Agent 定义本身是**声明式目录**（顶层 `catalog/` 目录即能力清单），定义里直接写工具集与用途说明，例如内置的只读侦察子 agent [证据: `omp-agent-definitions-adapter.ts:122` "MUST be used for exploratory codebase research... Fast read-only scout returning compressed context for handoff."]。
- **注意区分**：`apps/renderer/src/conversationWorkspace/hosts.ts:117` 的 `registerTools(id, hosts, store)` 是**面板 UI 的工具注册**，不是 agent 工具，别混。 [证据: `packages`/`apps/renderer/src/conversationWorkspace/Workspace.tsx:214` `const release = workspace.hosts.registerTools(id, hosts, store);`]

### 并发取消

- **并发模型是「单会话串行 + 命令分类并行」**：仲裁器把命令分成可排队（btw.*、import、auth）与不可排队两类，可排队者走队列，其余必须等前序完成 [证据: `command-arbiter.ts:61`；`:162` 有条件豁免 `&& request.operation.kind !== "queue.enqueue"`]。
- **中断是「一等命令」，且永远不会被普通命令挡住。** 归属于中断族的 kind 被集中列出：`core.abort`、`agent.kill`、`job.cancel`、`eval.agent.cancel`、`eval.completion.cancel` [证据: `command-arbiter.ts:85`, `:104`, `:107`, `:108`, `:109`]。
  并且 `core.abort` 在排队判定中被**单独开了一道口子**：`request.operation.kind !== "core.abort"` [证据: `command-arbiter.ts:161`]。这是「取消优先于一切」的显式实现。
- `btw.abort` 被划入 queue-compatible [证据: `command-arbiter.ts:61`]，即「顺带问一句」的中断可以排在队列里，不抢占主流程。
- 回收与恢复：`runtime.resume` 属于可恢复类 [证据: `command-arbiter.ts:118`]。
- 交互（审批/确认）有独立所有权协议，需持有 interaction id + generation 才能完成，防止旧一代交互被误提交 [证据: `packages/studio-host/src/interaction-adapter.ts:70` `this.arbiter.adoptInteraction(...)`、`:110` `completeInteraction(event.interactionId, event.commandId, pending.owner, pending.generation)`]。

### 错误重试

- **有退避，但是线性而非指数。** 归档重试：`for (let attempt = 0; attempt < 5; attempt += 1)`，等待 `setTimeout(resolve, 50 * (attempt + 1))` [证据: `packages/studio-host/src/session-archive-service.ts:333`、`:339`]。总计上限约 50+100+150+200 = 500ms，第 5 次直接放弃 [`if (attempt === 4) return;` :338]。
- **Bridge 层有轮询式重试**，默认 50ms 间隔，且用 `Math.min(retryDelayMs, remaining)` 保证不超总预算 [证据: `packages/studio-host/src/bridge-client.ts:168` `const retryDelayMs = options.retryDelayMs ?? 50;`；`:184` `setTimeout(resolve, Math.min(retryDelayMs, remaining))`]。
- **可执行文件探测有「有限重试 + 分类可重试」**：只对 `TRANSIENT_PROBE_FAILURES` 集合内的失败重试，且有 attempts 上限 [证据: `packages/studio-host/src/runtime-resolver.ts:473` `const attempts = Math.max(1, Math.trunc(environment.probeAttempts ?? DEFAULT_PROBE_ATTEMPTS))`；`:476-478` `attempt <= attempts && outcome.failure !== undefined && TRANSIENT_PROBE_FAILURES[outcome.failure] === true`]。注释强调「一次冷启动失败不足以证明可执行文件坏了」[`:193-194`] —— 这是把「瞬时失败」和「真坏」分开的正确做法。
- **事件序列缺口有快照恢复**，且退避是为了「不要自旋」：第一次立即，后续等待 [证据: `packages/studio-host/src/runtime-session-controller.ts:41-43` 注释 "The first attempt is immediate. Another gap may arrive in the same read as the recovery snapshot, so subsequent attempts wait long enough not to spin"]。
- **付费守卫**：失败可重试，但「Worker 丢了绝不重启到付费工作」[证据: `packages/studio-host/src/evaluation-coordinator.ts:565` 注释 "A failed write is retryable while the Worker remains resident. A lost Worker is never restarted into paid work."]。这是明确的经济性约束。

### 上下文管理

- **压缩由 runtime（omp 本体）负责，Studio 侧只做「投影与边界」**。本仓库未找到 compaction 实现。
- Studio 侧能做的是**字节级边界控制**：对话增量先经 coalescer 合并，单批超过 `MAX_BYTES` 立即冲刷 [证据: `packages/studio-host/src/conversation-coalescer.ts:116` `if (bytes > MAX_BYTES) { this.#enqueue(envelope); this.#drainPending(); return; }`；`:106`, `:188` `#enqueue`]。
- 工具参数与工具结果有**字节上限的 JSON 投影**，避免单个巨大 tool result 撑爆链路 [证据: `packages/studio-host/src/session-archive-reader.ts:1620` 注释 "Byte-bounded JSON projection shared by toolCall arguments and toolResult details."]。
- Agent 定义里把「压缩上下文交给下游」写进了职责 [证据: `omp-agent-definitions-adapter.ts:122` "returning compressed context for handoff"]。
- **诚实标注**：token 预算/自动摘要未找到，可能在 `omp-patch/` 指向的上游。

### 持久化

- **格式是 JSONL，冷归档用 gzip level 9。** 会话文件后缀 `.jsonl`，压缩后 `.jsonl.gz` [证据: `packages/studio-host/src/session-archive-service.ts:15-16` `const SESSION_SUFFIX = ".jsonl"` / `const COMPRESSED_SESSION_SUFFIX = ".jsonl.gz"`]。
- 归档布局对齐上游 `omp gc`：`<agentDir>/archive/sessions` [证据: `session-archive-service.ts:76` "`.jsonl` becomes `.jsonl.gz` (level 9) under `<agentDir>/archive/sessions`"；`:46-47` `archiveRoot` 默认值注释]。
- **不能归档的保护条件**（说明冷热分层的严格性）：会话仍在 Runtime 中驻留则拒绝归档 [`session-archive-service.ts:51` 注释 "Rejects archive/unarchive while the session is resident in a Runtime"]；刚写过则拒绝以保护崩溃尾部 [`session-archive-service.ts:141` "Session was written recently; retry shortly so a crash tail cannot be archived"]；`omp gc` 持锁则拒绝 [`session-archive-service.ts:235` `"GC_LOCK_HELD"`]。
- 有 **command ledger**（命令账本）做持久化幂等 [`packages/studio-host/src/command-ledger.ts`, `command-ledger-store.ts`]，以及 **session lease**（会话租约）[`session-lease-store.ts`]。
- 归档读取走 **worker + pool**，不阻塞主线程 [`session-archive-worker.ts`, `session-archive-pool.ts`]。
- **只在内存**：runtime 投影、coalescer 的 pending 缓冲、PTY 回放缓冲（`replay-text-buffer.ts`）、ticket（`pty-ticket.ts`）。

### 执行逻辑的优势

1. **「取消优先」被写进仲裁器，而不是靠各调用点自觉。**
   `core.abort` 在排队判定中被单独豁免 [`command-arbiter.ts:161`]，中断族被集中枚举 [`command-arbiter.ts:85,104,107-109`]。为什么这对：并发系统里最典型的 bug 是「用户点停止，但前面还排着 3 条命令，abort 排在它们后面」—— 用户感知为「点了没反应，还在烧钱」。把 abort 提成不可阻塞的一类，从协议层消灭了这个死锁。

2. **失败被分类对待：可重试 / 不可重试 / 绝不重试到付费。**
   `TRANSIENT_PROBE_FAILURES` 白名单决定是否重试 [`runtime-resolver.ts:473-478`]，而 evaluation 层明确「Worker 丢了不再重启进付费工作」[`evaluation-coordinator.ts:565`]。为什么这对：桌面 agent 的重试错误会造成真实金钱损失；能区分「网络抖动值得再试」与「环境已死，重试只会重复计费」，是产品级的克制。

3. **流式回显有字节级合并与上限，避免 UI 被 token 洪水打垮。**
   coalescer 在 `MAX_BYTES` 处强制冲刷 [`conversation-coalescer.ts:116`]，工具参数/结果也做字节有界投影 [`session-archive-reader.ts:1620`]。为什么这对：高层流式协议按 token 逐条推送时，IPC 消息数可能上万/分钟；合并 + 上限把渲染压力与内存峰值都锁住了。

### 执行逻辑的缺点

1. **重试是线性退避（50ms×n，5 次封顶），对真实的外部争用太短。**
   证据：`session-archive-service.ts:333,339`。**什么场景出问题**：杀毒软件/OneDrive 同步/Windows 索引服务持有文件句柄时，文件锁竞争常持续数秒；500ms 总预算下必然失败，用户看到「归档失败，稍后重试」，而重试仍需人工触发。指数退避（或至少秒级上限）才是合适策略。

2. **归档的三重前置条件叠加，使「活跃工作目录上的会话」几乎无法归档。**
   需同时满足：不在 Runtime 驻留 [`session-archive-service.ts:51`]、最近未写入 [`:141`]、`omp gc` 未持锁 [`:235`]。**什么场景出问题**：正好在跑长任务的用户想清理磁盘，会遇到「每一个想归档的会话都在驻留或刚写过」，于是归档功能在实际使用中基本失效；且错误码 `GC_LOCK_HELD` 直接把上游工具的内部状态暴露给了用户。

3. **真正的 agent 执行与上下文压缩不在本仓库，执行逻辑的「核心一半」不可审计。**
   studio-host 只有编排、仲裁、归档、投影；loop 与 context 在外部 runtime 可执行文件里（`runtime.ts:13-14` 的 `system|custom` executable、`omp-patch/`）。**什么场景出问题**：出现「模型烧了 20 万 token 却没压缩」这类问题时，Studio 侧没有任何执行点可以介入或加护栏，只能改上游 —— 对一个自称 Host 的层来说，这是把最关键的成本控制交给了不受控的第三方二进制。

---

## AionUi

`D:\refs\aionui\AionUi-main` — monorepo，`packages/{desktop, web-cli, web-host, shared-scripts}`。
`packages/desktop/src` 分层：`common/`、`preload/`、`process/`（主进程）、`renderer/`。
主进程下 `process/{backend, bridge, services, resources, startup, utils, feedback, pet, brand}`。

### 任务链路

- **AionUi 是「多 agent 后端 + 内置 MCP 工具」的桌面客户端，且有 Web 变体（web-host/web-cli）。**
- **链路**：renderer `pages/conversation` → preload → 主进程 `process/` → 按会话的 `agent_type` 分发到不同 agent 后端 → 事件回流到 renderer 的 `pages/conversation/runtime` + `Messages/`（含 `Messages/acp/`）渲染。
- **Agent 后端类型被写死在数据库 CHECK 约束里，且随版本演进**：初始 `('gemini','acp','codex')` [证据: `packages/desktop/src/process/services/database/migrations.ts:191`] → 逐步扩到含 `'openclaw-gateway'`（`:381`）、`'nanobot'`（`:529`）、`'remote'`（`:802`）、`'aionrs'`（`:990`）。**这五行是一张「AionUi 支持过哪些 agent 后端」的版本时间线**。
- 模型调用层是多 provider 抽象：`ClientFactory` 依 provider 类型构造 `OpenAIRotatingClient` / `GeminiRotatingClient` / `AnthropicRotatingClient` [证据: `packages/desktop/src/common/api/ClientFactory.ts:11`、`:19`、`:23`、`:121` `return new AnthropicRotatingClient(provider.api_key, clientConfig, rotatingOptions);`]。

### 工具注册

- **工具 = MCP server**，这是 AionUi 最清晰的一层。
- **传输层支持四种**：Stdio / SSE / HTTP / StreamableHTTP [证据: `packages/desktop/src/common/config/storage.ts:595` `IMcpServerTransportStdio`、`:602` `...SSE`、`:608` `...HTTP`、`:614` `...StreamableHTTP`；联合类型 `:620-624`]。
- **MCP server 可以按会话圈定**：既有全局 `mcp.config?: IMcpServer[]` [`:107`]，也有 `session_mcp_servers?: ISessionMcpServer[]` [`:262`、`:467`]，后者取 MCP server 的 `id|name|transport` 子集 [`ISessionMcpServer = Pick<IMcpServer, 'id' | 'name' | 'transport'>`, `:642`]。**结论：同一台机器上不同会话可挂不同工具集。**
- **内置 MCP server**：`process/resources/builtinMcp/` 下有 `browserServer.ts`、`imageGenServer.ts`、`cdpBridge.ts`、`cdpTargetProtocol.ts`、`browserServerPort.ts`、`constants.ts`。工具用 MCP SDK 的 `server.tool(...)` 注册 [证据: `packages/desktop/src/process/resources/builtinMcp/imageGenServer.ts:47` `server.tool(`]。
- **调用格式转换**：内部统一用 OpenAI function-calling 形状，再按 provider 转成各家的原生格式。证据：`request.tools = [` [证据: `packages/desktop/src/common/api/OpenAI2GeminiConverter.ts:177`]，配套 `OpenAI2AnthropicConverter` [证据: `AnthropicRotatingClient.ts:12-15` 导入 `OpenAI2AnthropicConverter`]。
- **未找到**「用户自定义 JS 插件式工具」。工具来源只有两条：外部 MCP server（用户配置）+ 内置 MCP server。

### 并发取消

- **未找到 agent 侧的统一取消实现。** 全仓 `abortController|.abort(|stopConversation|cancelTask` 在主进程的命中**全部集中在软件更新器** `updateBridge.ts` [证据: `packages/desktop/src/process/bridge/updateBridge.ts:319` `const controller = new AbortController();`、`:320` `setTimeout(() => controller.abort(), timeoutMs)`、`:360`、`:742`]。
- 进程级 kill 只出现在内置 browser MCP 的清理里 [证据: `packages/desktop/src/process/resources/builtinMcp/browserServer.ts:171` `process.kill(process.pid, signal)`、`:181` `child.kill(signal)`]。
- **诚实标注**：「能否中断一次正在流式输出的对话」在本仓库证据不足。考虑到 `agent_type` 含 `'acp'`（`:191`）与 `'remote'`（`:802`），取消很可能由 ACP 子进程 / 远端协议承担，本仓库只转发。**未找到，可能不存在于本仓库。**
- 并发上限：未找到全局并发闸门（无 semaphore / p-limit 命中）。

### 错误重试

- **核心机制是「API Key 轮换」而非「时间退避」** —— 这是 AionUi 区别于另外两者的地方。
  存在 `RotatingApiClient` 基类与三个具体实现 [证据: `packages/desktop/src/common/api/ClientFactory.ts:23` `export type RotatingClient = OpenAIRotatingClient | GeminiRotatingClient | AnthropicRotatingClient;`]，且 `api_key` 是**多个 key 的字符串**（构造签名 `apiKeys: string`）[证据: `AnthropicRotatingClient.ts:27` `constructor(apiKeys: string, config: AnthropicClientConfig = {}, options: RotatingApiClientOptions = {})`]。
  **这意味着失败时的处置是「换下一个 key 再试」，而不是「等一会儿再试」**。对多 key / 中转站的国内使用场景，这是最贴合的失败模型。
- Key 解析还有「环境变量优先」的回退 [证据: `AnthropicRotatingClient.ts:55` 注释 "For Anthropic, try to get from environment first"]。
- 有 `binaryResolver` 负责可执行文件定位 [证据: `packages/desktop/src/process/backend/binaryResolver.ts`]，且配了测试 `binaryResolver.test.ts`。
- **诚实标注**：指数退避 / 重试次数上限未找到，可能不存在。

### 上下文管理

- **未找到明确的裁剪/压缩/预算控制实现。** 检索 `compact|context|token|truncat` 在 API 转换层只命中工具透传 [证据: `OpenAI2GeminiConverter.ts:177` `request.tools = [`]。
- 能做的是**格式转换层的保真**，而不是裁剪：`OpenAI2GeminiConverter` / `OpenAI2AnthropicConverter` 负责把统一格式转成各家格式，多模态与工具都要转。
- **诚实标注**：若存在上下文管理，最可能在 ACP 子进程或 `'aionrs'` 内置 runtime 中（`migrations.ts:990`），本次未定位到实现。

### 持久化

- **SQLite 是会话与配置的权威存储**，且有完整逐版本迁移链 [证据: `packages/desktop/src/process/services/database/migrations.ts`，`:191`、`:381`、`:411`、`:456`、`:489`、`:529`、`:562`、`:622`、`:682`、`:740`、`:802`、`:990`、`:1024` —— 十余次表结构演进]。
- 用 **CHECK 约束做枚举强校验**（`agent_type TEXT NOT NULL CHECK(agent_type IN (...))`, `:191`），意味着**写入非法 agent 类型会被数据库直接拒绝** —— 这是把领域约束下沉到存储层的做法。
- 配置与 MCP server 定义同为结构化存储（`common/config/storage.ts` 中的 `IMcpServer` 等）。
- 另有 `process/utils/runBackendMigrations.ts` 做 backend 数据迁移，含把旧配置转成 MCP JSON 的逻辑 [证据: `runBackendMigrations.ts:150` `original_json: JSON.stringify({ mcpServers: { [BUILTIN_IMAGE_GEN_NAME]: serverConfig } }, null, 2)`] —— 说明**内置能力是以「MCP server 配置」的形态落盘的**，与用户自配 MCP 走同一套数据模型。
- **只在内存**：流式生成中的消息、renderer 侧会话状态。
- 有 `Database` 服务层但未见 WAL/分库策略证据，**与 orca 的按域分库形成对比**。

### 执行逻辑的优势

1. **工具以 MCP 为标准接口，并且把「工具集」的作用域下沉到会话级。**
   `ISessionMcpServer`（`storage.ts:642`）与 `session_mcp_servers`（`:262`）让同一份安装可以「A 会话挂浏览器工具、B 会话不挂」。为什么这对：MCP 是跨产品的事实标准，选了它就不必自建插件生态；而**会话级作用域**解决了 agent 工具最常见的安全投诉 —— 「我只想让这个任务用浏览器，别的任务别碰我的登录态」。相较 orca 完全外包、omp-studio 只有 agent 级定义，AionUi 的隔离粒度最细。

2. **失败处置用「Key 轮换」而非「时间退避」，贴合真实部署形态。**
   `RotatingApiClient` + 多 key 字符串入参 [`ClientFactory.ts:23`、`AnthropicRotatingClient.ts:27`]。为什么这对：AionUi 的用户大量使用第三方中转/多 key 池，典型失败是 **429/额度耗尽/单 key 被禁**，这类错误「等一会儿」无效，「换一个 key」立刻恢复。把轮换做进 client 基类，等于把最有效的恢复手段变成了默认行为。

3. **领域约束下沉到数据库 CHECK，迁移链完整可追溯。**
   `agent_type` 有 CHECK 枚举 [`migrations.ts:191`]，十余次迁移 [`migrations.ts` 多处]。为什么这对：agent 后端会不断增删（gemini→acp→codex→openclaw-gateway→nanobot→remote→aionrs），若只靠应用层校验，历史脏数据会在升级后引发难以定位的渲染崩溃；CHECK + 迁移让每次扩枚举都是一次显式、可回滚的 schema 变更。

### 执行逻辑的缺点

1. **agent 侧的取消链路在本仓库不可见，长任务中断能力无法自证。**
   证据：主进程 `AbortController` 命中**全部**在更新器 [`updateBridge.ts:319,320,360,742`]；agent 相关零命中。**什么场景出问题**：用户让 agent 跑一个会改 50 个文件的任务，中途想停 —— 如果取消依赖 ACP 子进程配合（如 orca 那样），则子进程不响应时 UI 会一直转圈且继续消耗额度；而本仓库没有一层「主进程强制回收」的兜底可审计。

2. **IPC 通道没有统一注册点，执行链路难以从一处读懂。**
   全仓 `ipcMain.handle` 只命中两处，且都是反馈模块 [证据: `packages/desktop/src/process/bridge/feedbackBridge.ts:52` `ipcMain.handle('feedback:collect-logs', ...)`、`:76` `ipcMain.handle('feedback:capture-screenshot', ...)`]。**什么场景出问题**：排查「消息发出去了但没回显」时，无法像 orca 那样用 `agentStatus:*` 通道名一路追到底，必须逐个 bridge 文件读；新接手的开发者构建心智模型的成本显著更高。

3. **上下文管理缺位，长会话有失控风险。**
   本次检索在 API 转换层与主进程均未找到 compaction / token 预算实现，转换层只做格式保真 [`OpenAI2GeminiConverter.ts:177`]。**什么场景出问题**：长时间多轮会话（尤其带大量工具结果、截图）会持续膨胀直至撞上模型上下文上限，届时表现为请求直接报错而非自动摘要，用户被迫手动开新会话并丢失上下文。

---

## 三者对比

| 维度 | orca | omp-studio | AionUi |
|---|---|---|---|
| **是否内建 agent loop** | 否。宿主 22 种外部 CLI 方言（`src/main/{claude,codex,gemini,...}`） | 否。编排外部 runtime 可执行文件（`runtime.ts:13-14`），loop 在 `omp-patch/` 上游 | 部分。多后端并存（`agent_type`: gemini/acp/codex/openclaw-gateway/nanobot/remote/aionrs，`migrations.ts:191→990`），ACP 走子进程 |
| **主链路关键节点** | renderer → `ipcMain.handle('agentStatus:*')`（`agent-hooks.ts:41+`）→ supervisor `spawn`（`provider-process-supervisor.ts:53`）→ JSONL-RPC/ACP → transcript 读取器回显 | renderer → **CommandArbiter 分类**（`command-arbiter.ts:61`）→ bridge-client → runtime → projection → **coalescer 合并**（`conversation-coalescer.ts:116`）→ 回显 | renderer `pages/conversation` → preload → `process/` → 按 `agent_type` 分发 → `Messages/acp/` 渲染 |
| **工具来源** | **完全外包**给外部 CLI；orca 自身无 tool registry（仅 Skill/SKILL.md 体系，`skill-package-creation.ts:65`） | **agent 定义**为注册单位，强制注入 `yield`（`omp-agent-definitions-adapter.ts:312`），声明式 `catalog/` | **MCP server**（4 种 transport，`storage.ts:595-624`）+ 内置 MCP（`imageGenServer.ts:47` `server.tool(`） |
| **工具作用域粒度** | 无（由 CLI 决定） | agent 定义级 | **会话级**（`ISessionMcpServer`, `storage.ts:642`）—— 三者中最细 |
| **并发模型** | 多会话并行 + keyed 串行（`agent-session-context-snapshots.ts:5`）+ PrioritySemaphore（`agent-model-catalog-lister.ts:2`）+ 分片并发上限（`chunked-upload-registry.ts:10`） | **单会话串行 + 命令分类**：可排队白名单 vs 独占（`command-arbiter.ts:61`） | 未找到全局并发闸门 |
| **中断实现** | `AbortSignal` 全链路 + **建连前就装监听**（`provider-acquisition-starts.ts:22,29,36`）+ 短 SIGTERM grace（`managed-provider-process.ts:8`） | **中断为一等命令且豁免排队**（`command-arbiter.ts:161`），中断族集中枚举（`:85,104,107-109`） | **未找到 agent 侧取消**；`AbortController` 仅见于更新器（`updateBridge.ts:319`） |
| **重试/退避** | 主链路无自建重试；快速失败 + 事后归因（hang-watchdog / crash-reporting） | **有，但线性**：50ms×n、5 次封顶（`session-archive-service.ts:333,339`）；bridge 50ms 轮询（`bridge-client.ts:168`）；探测仅重试 `TRANSIENT_PROBE_FAILURES`（`runtime-resolver.ts:473-478`） | **不用时间退避，用 Key 轮换**：`RotatingApiClient`（`ClientFactory.ts:23`），`apiKeys: string` 多 key（`AnthropicRotatingClient.ts:27`） |
| **付费/成本护栏** | 无显式护栏 | **有明确策略**："A lost Worker is never restarted into paid work"（`evaluation-coordinator.ts:565`） | 未找到 |
| **上下文管理** | 不裁剪，只**识别**他人的压缩（`compaction` → `presentation:'compaction'`，`transcript-line-decoders-omp.ts:31-36`；codex `:153-155,196-197`） | 无 compaction 实现；只做**字节边界**：`MAX_BYTES` 冲刷（`conversation-coalescer.ts:116`）+ toolCall/result 字节有界投影（`session-archive-reader.ts:1620`） | **未找到**裁剪/预算实现 |
| **持久化载体** | **SQLite 按域分库**：`profile-state.db`、`agent-model-catalog.db`、journal 库、`orca-github-cache.db`（`profile-state-database.ts:56`、`agent-model-catalog-persistence.ts:202`）+ 损坏隔离（`profile-state-database-quarantine.ts:43`） | **JSONL + gzip level 9 冷归档**：`.jsonl` → `.jsonl.gz`，落 `<agentDir>/archive/sessions`（`session-archive-service.ts:15,16,76`）+ command ledger + session lease | **单一 SQLite + 十余次迁移**，`agent_type` 用 CHECK 约束强校验（`migrations.ts:191` 起） |
| **归档/清理保护** | 未见显式保护 | **三重拒绝**：Runtime 驻留拒绝（`:51`）、刚写拒绝（`:141`）、gc 持锁拒绝（`:235`） | 未见 |
| **只在内存的部分** | 流式增量、IPC 快照、UI store | runtime 投影、coalescer pending、PTY 回放缓冲、ticket | 流式消息、renderer 会话状态 |
| **最大执行逻辑风险** | 工具层无治理 + 短 grace 丢会话尾 | 退避过短 + 归档条件叠加失效 + 核心 loop 不可审计 | 中断能力不可自证 + IPC 无统一注册点 + 上下文无护栏 |

### 一句话定位

- **orca**：把「多 agent」做成 OS 级调度 —— 方言可插拔、取消有双保险、状态按域分库；代价是**工具治理空心化**。
- **omp-studio**：把「命令仲裁」做成协议 —— 谁可排队、谁可中断、谁付费，全部显式；代价是**退避策略偏短、核心 loop 在仓外**。
- **AionUi**：把「工具」做成标准 MCP 且可会话级圈定 —— 生态与隔离最好；代价是**执行侧（取消/上下文）反而最不透明**。

---

### 本次检索的诚实边界

以下项目**未找到**证据，可能不存在或位于尚未扫描的路径（如 `omp-patch/` 上游、`.gitmodules` 子模块、编译产物）：
1. orca 的中心化 tool registry —— 判定为「不存在，工具由外部 CLI 提供」。
2. orca 主链路的指数退避重试。
3. omp-studio 的上下文压缩实现 —— 判定位于上游 omp 二进制。
4. AionUi 的 agent 侧取消实现、上下文裁剪/预算控制、全局并发闸门。
5. 三者的「单次运行 token 费用上限」类硬护栏（仅 omp-studio 有「不重启进付费工作」这一条间接约束）。
