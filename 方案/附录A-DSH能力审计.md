# 附录 A · DSH 运行时能力审计

> 目的：搞清"这套架构的每个部件，在当前 DeepSeek Harness 运行时上能不能做、用什么接口做、缺什么"。
> 方法：Cordis Inspect 实测查询（`Service.listService` / `Event.listEvents`）+ 本地包与配置读取。
> 证据等级：**[实测]** = 来自 Cordis Inspect 返回；**[推断]** = 基于签名语义的判断；**[未验证]** = 需要写 spike 确认。
> 审计时间：2026-11-06。运行时：DeepSeek Harness（Electron 客户端，`resources/app.asar`）。

---

## 0. 结论摘要

| 判断 | 结论 |
|---|---|
| **J1 做双层/三层架构最省力路径** | 用 `agentLoop.createAgent` / `agentLoop.resume` 直接创建与管理 Session（而非 `agentTeams`）；用 `agentPresets.register` **[实测]** 运行时挂两/三套 preset。**不需要 fork 运行时。** |
| **J2 做事件驱动主动响应的最大障碍** | **不是缺事件**（Event 总线很全：`agent/inbox/inserted`、`session/event`、`agent/status`、`tools/*`、`webhookRuntime` 等 80+ 个）。**真正的障碍是"外部事件如何进入一个已存在但不活跃的 Session"**——见 J2 详解与风险 R-1。 |
| **J3 自进化的可改边界** | Agent **能**改：文件（技能/记忆，走文件系统）、`agentPresets.register` 注册的 preset、`tools.register` 注册的工具、`systemPrompt.section/context` 注入的分节。Agent **不能**（或不应）改：沙箱策略、凭据、审批策略、已装插件集合（`plugin_manager` 需 danger-full-access 且属于 C 档）。 |

---

## 1. 服务全景（按用途分类）

> 只列与本架构直接相关的。原始目录返回 ~150 个服务。

### 1.1 会话与 Agent 生命周期

| Service | 关键方法 **[实测]** | 我们用它做什么 |
|---|---|---|
| `agentLoop` | `create(id, options, meta)`、`createAgent(ownerCtx, options)`、`resume(ownerCtx, options)` | 创建/恢复 Router、Scene、Worker Session |
| `agents` | `get(id)`、`list()`、`roots()`、`create`、`resume`、`register`、`announce`、`enter`、`isOwnedBy`、`turnBoundaryOf`、`currentInitiator` | 查找/管理活跃 Agent；`turnBoundaryOf` 用于判定"这一轮结束没" |
| `subagents` | `startActivation`（两种重载）、`sendMessage`、`interrupt`、`listChildren`、`listDescendants`、`waitForChildren`、`drainChildren`、`drainDescendants`、`registerProvider`、`prompt`、`interruptByParent` | 并发 Worker 的另一种实现；**注意父子邻接限制**（见 J2） |
| `agentTeams` | `spawnTeammate`、`sendMessage`、`createTask`、`updateTask`、`waitForChange`、`interrupt`、`listMembers`、`membership`、`listTasks` | 单任务内部的临时团队（Worker 内），**不用于场景间协作** |
| `agentPresets` | `register`（**运行时**）、`mount`、`select`、`resolve`、`list`、`readDocument`、`inspectCompositions`、`compositionInventory`、`acquireScope`、`serviceFor`、`composedPreset`、`composeFrom` | **三/四套角色 preset 的运行时挂载（R-3 关键）** |
| `workingDirectory` | `get`、`set`、`ensure`、`defaultDirectory` | Worker 一 Ticket 一目录 |
| `worktrees` | `create`、`restore` | 每个 Ticket 的隔离检出 |

### 1.2 命令与调度

| Service | 关键方法 | 用途 |
|---|---|---|
| `commands` | `register`、`find`、`execute`、`registerFileReceiptResolver` | `/sea-status`、`/sea-stop`、`/sea-propose` 等人类命令 |
| `timer` | `timeout`、`interval`、`throttle`、`debounce` | Watchdog 心跳、routine |
| `schedule`（通过 events 观测） | 事件 `schedule/changed`、`schedule/resolve-agent` | 计划任务；`resolve-agent` 正是"恢复 reminder 的 Session"的 hook |
| `workflowEngine` | `start(request)` | 声明式多步编排（适合"确定性流水线"，不适合"自主 Agent"） |
| `goal`（通过 events） | 事件 `goal/changed`、`goal/activation-changed` | 长目标追踪 |

### 1.3 事件入口（外部世界）

| Service | 关键方法与类型 **[实测]** | 用途 |
|---|---|---|
| `webhookRuntime` | `register<K>(rule: WebhookRule<K>)`、`dispatch<K>(delivery)` | **外部 webhook 的入口**。`WebhookRule.run()` 返回 `WebhookSessionRequest \| null`；`WebhookSessionRequest` = `{ workspacePath, title, prompt, agentPreset, permissionPreset, model? }`。**注意：内置动作是"新建 Session"** |
| `webServer` | `register(route)`、`registerUpgrade`、`registerFallback`、`readResource`、`getOrigin`、`tapIndex`、`applyIndexTaps`、`collectIndexInjections`、`renderIndex` | 面板 API、插件 HTTP 回调、页面注入 |
| `connection` | `rpc`、`fetch`、`createPeer`、`admit`、`createSharedFetchHandler('/api')`、`authenticatedUrl`、`authorizeIndex` | 远程/多端连接、认证 |
| `ssh` | `request`、`connectStream`、`ready`、`dispose` | 远端执行（多机） |
| `forge` | `register(provider)`（+ 事件 `forge/providers-changed`） | 代码托管平台抽象（GitHub/GitLab） |
| `browserUse` / `computerUse` | `register(name)` | 浏览器/桌面自动化（**降级手段，非主路径**） |

### 1.4 工具面

| Service | 关键方法 | 用途 |
|---|---|---|
| `tools` | `register(definition, options)`、`restrict(filter)`、`get`、`executable`、`resolve`、`definitions`、`schemas`、`setExecutor`、`execute(batch)`、`guard(guard)`、`checkGuards(exec)` | 工具族的注册与授权；**`guard` 是确定性护栏的挂点** |
| `toolResultPruner` | `pruneSession`、`pruneContent`、`measureContent`、`config` | 长工具结果裁剪（**上下文纪律**） |
| `spill` | `saveText(input)` → `SpillRef` | 长内容外置（**Inline & Spill 的 Spill 端**） |
| `compaction` | `compactIfNeeded`、`compactNow`、`compactRegion` | 历史压缩 |
| `tokenMeter` | `contextPressure`、`measure`、`estimateMessage` | 上下文压力观测 |
| `systemPrompt` | `section`、`context`、`variable`、`tools`、`suppressRuntimeContext`、`refreshContext`、`assemble`、`getSectionOrder`、`getContextOrder` | **七条上下文通道的挂点** |
| `clientModules` | `graph`、`fetchBundle`、`artifactBaseline`、`rebuilt`、`onRebuilt`、`onGraphChanged` | Web 面板客户端插件 |
| `skills`（通过事件） | `skills/change` | 技能变更广播 |

### 1.5 授权、审批、凭据

| Service | 关键方法 | 用途 |
|---|---|---|
| `approval` | `setPolicy(agent, policy)`、`request(req)`、`overrideOf(session)` | D5 五类强制 review |
| `authorization` | `registerFlow`、`list`、`describe`、`cancel`、`begin(request)` | 凭据获取流程（Broker 的对接点） |
| `credentials` | `resolve`、`describe`、`set`、`unset`、`readRecord`、`describeRecord`、`listRecords`、`modifyRecord`、`deleteRecord` | **Broker 内部使用；凭据绝不进上下文** |
| `userQuestions` | `ask`、`askTimed`、`answer`、`attachWait` | 结构化提问（**Super-agent 拒绝"从自由文本推断在等人"**） |
| `actionCards` | `register(kind)`、`record(decision)`、`view(session)`、`act(agent, callId, verb, payload)` | 人机卡片（**待办/待验收**） |

### 1.6 存储与持久化

| Service | 关键方法 | 用途 |
|---|---|---|
| `storage` | `backend`、`mount(form)`、`form` | 存储后端枢纽 |
| `storageDomain` | `open(spec)`、`get(name)`、`closeAll` | **内核账本的落点**（Domain 抽象） |
| `workspaceRegistry` | `create`、`initializeDefault`、`get`、`list`、`delete`、`insertBefore`、`archiveSession`、`unarchiveSession`、`pinSession`、`unpinSession`、`resolveByPath` | 工作区与会话归档 |
| `workspaceFiles` | `read`、`readBytes`、`stat`、`list`、`changes` | Web 侧文件读取 |
| `workspaceController` | `create`、`rename`、`delete`、`follow` 等 | 面板侧工作区操作 |
| `files` / `attachments` | `saveImages`、`saveFile`、`saveFileStream`、`readFileStream`、`admitPromptContent`、`imageHostPath` | 物证（截图/文件）的存储 |
| `fileUploads` | `upload`、`uploadStream`、`uploadImageStream`、`resolve`、`bindPrompt`、`retirePrompt` | 上传物证 |
| `workspaceChanges` | `summary(sessionId, seq)`、`diff(sessionId, seq, index)` | **文件变更审计**（可用于 Evidence 自动采集） |
| `sessionTelemetry`（事件） | `session-telemetry/record`（waterfall，可变换出站记录） | 预算/审计埋点 |

### 1.7 观测与健康

| Service | 关键方法/事件 | 用途 |
|---|---|---|
| `health`（在 infra 层） | 各 effect kind 的健康条目；`retry-health` | Watchdog W1 |
| `workspaceController.follow`（stream） | 实时帧 | 面板实时更新 |
| `cotTranslation` | `limits`、`translate` | 可选（推理翻译） |
| `translator` | `availableProviders`、`resolve`、`translate` | 可选（多语言） |

---

## 2. 事件全景（这是"主动性"的基础，也是最重要的实测结果）

> `Event.listEvents` 返回 **80+ 个事件**。下面是**对本架构有用**的，按用途分组。

### 2.1 会话生命周期（Watchdog 与状态台账的关键）

| 事件 | 模式 **[实测]** | 签名要点 | 用途 |
|---|---|---|---|
| `session/created` | emit | `(session)` | 新会话登记 |
| `session/disposed` | emit | `(session)` | 会话离开 |
| `session/event` | emit | `(session, event: SessionEvent)` | **post-commit 追加流 → 这是最全的观测面** |
| `session/flush` | parallel | `(session) => Promise<void>` | 持久化检查点 |
| `agent/created` | serial | `(agent, source)` | 专属初始化（**可在此注入身份**） |
| `agent/disposed` | emit | `(agent)` | 清理 |
| `agent/status` | emit | `(agent, status: 'idle'\|'running')` | **W2 进展监控的核心** |
| `agent/error` | emit | `(agent, turn, step, error)` | 故障 |
| `agent/turn-stopping` | serial | `(agent, turn)` | **轮结束前的最后一个 hook**（可用于自动交接/写回） |

### 2.2 消息进出（事件路由的关键）

| 事件 | 模式 | 用途 |
|---|---|---|
| `agent/inbox/inserted` | emit | **一条消息进入 inbox 的瞬间 → 这是我们做"投递策略"的唯一观测点** |
| `agent/inbox/claimed` | emit | 消息被取走（进入某一轮） |
| `agent/inbox/discarded` | emit | 消息被丢弃（**可用于审计"发了但没人看"**） |
| `agent/pre-step` | **waterfall** | **可以"拒绝一个提议的步骤"或"替换进入该步的消息"** → 硬护栏（如禁 `sleep`） |
| `agent/assistant-stream` | emit | 流式输出观测 |
| `agent/request-error` | waterfall | 模型请求失败的处置（重试策略） |

### 2.3 工具执行（生命周期标签与护栏的关键）

| 事件 | 模式 | 用途 |
|---|---|---|
| `tools/pre-execute` | **waterfall** | **allow / deny / cancel / ask before dispatch** → 我们的确定性护栏主挂点 |
| `tools/post-execute` | **waterfall** | **accept / replace / enrich / block 结果** → **VCP 生命周期标签的挂点** |
| `tools/execute` | waterfall | 超时/重试/指标（around dispatch） |
| `tools/result` | emit | 冻结的最终结果观测 |
| `tools/change` | emit | 工具注册变化 |
| `tools/ptc-dispatch-log` | waterfall | `run_code` 子派发日志的内容替换 |

### 2.4 提示词装配（七通道的关键）

| 事件 | 模式 | 用途 |
|---|---|---|
| `system-prompt/assemble` | **waterfall** | **对已装配的分节/上下文/变量做最后一次呈现变换** |
| `system-prompt/change` | emit | 提示词提供者变化 |

### 2.5 审批、提问、授权

| 事件 | 模式 | 用途 |
|---|---|---|
| `approval/request` | **waterfall** | 审批决策（D5） |
| `user-questions/request` | **waterfall** | 结构化提问 |
| `authorization/settled` | emit | 凭据流程结束 |
| `credentials/record-updated` / `credentials/reference-updated` | emit | 凭据变更审计 |

### 2.6 外部与定时

| 事件 | 模式 | 用途 |
|---|---|---|
| `schedule/changed` | emit | 任务集变化 |
| `schedule/resolve-agent` | **waterfall** | **"恢复 reminder 的 Session"——这正是我们需要的"唤醒"能力的一个现成例子** |
| `app-boot/config-reload` | emit | 配置重载完成 |
| `plugin-manager/*` | emit/parallel | 插件安装状态 |
| `file / fs`：`fs/write-intent`、`fs/edit-intent`、`fs/delete-intent`、`fs/observed` | **waterfall** | **文件写意图拦截 → 这是"E 档禁止跨写"的硬执行点** |

### 2.7 Subagent / Workflow / Goal

| 事件 | 模式 | 用途 |
|---|---|---|
| `subagent/start` / `subagent/end` | emit | Worker 内子任务的观测 |
| `workflow/start`、`workflow/phase`、`workflow/log`、`workflow/agent-start`、`workflow/agent-end`、`workflow/end` | emit | 确定性编排的进度 |
| `goal/changed`、`goal/activation-changed` | emit | 长目标 |

### 2.8 连接与前端

| 事件 | 模式 | 用途 |
|---|---|---|
| `connection/request` | waterfall | 共享 API 请求准入/包装 |
| `webserver/index-inject` | emit | 页面注入表（**乱雨家"宿主注入 JS"的等价原语**） |
| `hmr/change`、`hmr/reload` | emit | 插件热重载观测 |

---

## 3. 三条硬判断（详解）

### J1 做三层架构的最省力路径

| 选项 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| `agentTeams`（spawnTeammate） | 有任务板、有 wait、有 interrupt | **它绑定"一个 Lead Session 的持久日志"**；`membership(agent)` 语义是团队，不是场景分层 | ❌ 不作主路径（仅 Worker 内部用） |
| `subagents`（startActivation） | 支持 continuable child、能 interrupt、能 list | **`sendMessage` 要求"direct parent or direct continuable child"** → 严格树形邻接 | ⚠️ 需 spike 验证能否承载"平级 Scene" |
| `agentLoop.createAgent` + `agentPresets.register` | 最自由；preset 可运行时注册 **[实测]**；可自定 workspace/cwd | 需要自己管生命周期与并发 | ✅ **主路径** |

**推荐组合**：
```
Global Router   → agentLoop.createAgent({ agentPreset: 'sea-router' })
Scene Session   → agentLoop.createAgent({ agentPreset: 'sea-scene',  cwd: sceneRoot })
Worker Session  → agentLoop.createAgent({ agentPreset: 'sea-worker', cwd: ticketDir })
投递            → R-1 spike 后定（见 §4）
```

### J2 事件驱动的最大障碍（**这是全审计最重要的发现**）

**事件不是问题。** 事件总线覆盖了会话、消息、工具、提示、审批、文件、外部、定时六个面。

**真正的障碍是一个具体问题**：

> **如何把一个外部事件投递进"已持久化但当前不活跃（不在 registry 里）"的 Session，并让它真正开始一轮？**

相关事实（全部 **[实测]**）：

| 事实 | 证据 | 含义 |
|---|---|---|
| `subagents.sendMessage` 的描述：**"an idle target starts a turn, and an absent direct child cold-resumes from persistence"** | Service 描述 | ✅ **存在"冷恢复 + 启动一轮"的能力**，但**仅限 direct child** |
| `subagents.sendMessage` throws：`"when continuation services are unavailable, adjacency is rejected, or the message was not admitted"` | 同上 | ⚠️ **邻接被拒**是明确错误路径 |
| `agentLoop.resume(ownerCtx, options)` | Service 签名 | ✅ 可以恢复一个 Agent；但恢复后如何**主动给它一条消息并驱动一轮**需确认 |
| `webhookRuntime` 的内置动作是 **"Session creation is the only built-in action"** | Service 描述 | ⚠️ 它偏向"新建"而非"投递到已有" |
| `schedule/resolve-agent` waterfall："Restore a reminder's Session through its embedding's owning controller" | Event 描述 | ✅ **这是"恢复已有 Session"的一个官方范例**，说明该模式被支持 |
| `agent/inbox/inserted` | Event | ✅ 有 inbox 概念与投递观测 |

**结论**：能力大概率**存在**，但**入口可能受限（邻接/父子）**。这恰好是风险 **R-1** 必须优先 spike 的原因。

**如果受限，三条备选路径**（详见 `04` §8）：
1. 把 Scene 建成 Router 的 **continuable child**（满足邻接），用 child↔parent 的 `sendMessage` 双向通信
2. 用 `webhookRuntime` 的"新建 Session"能力 + `seed`（把上下文重建），每次事件新建 Worker（Super-agent 的 Worker 本来就是"一 ticket 一 session"，**但 Router 必须是常驻的**）
3. 用 `schedule` 的 resolve-agent 模式（需要自定义 schedule 条目）

### J3 自进化的可改边界

| 层 | Agent 能否自己改 | 依据 **[实测]** | 我们的档位 |
|---|---|---|---|
| **文件（技能/记忆）** | ✅ 能（`fs/write` 工具） | `fs/write-intent` waterfall 可拦（我们能加 E 档拦截） | **D 档** |
| **preset 注册** | ✅ 能（`agentPresets.register` 是普通 Service 方法） | 但它是**进程内调用**——模型通过工具调用走不到，需要插件代为执行 | D 档（经提案） |
| **工具注册** | ✅ 能（`tools.register`） | 同上，需要插件代执行 | **C 档**（需人批） |
| **systemPrompt 分节** | ✅ 能（`section`/`context`） | 需插件代执行 | D 档 |
| **skills 目录** | ✅ 能（文件 + `skills/change`） | 有 `skill` 工具与文件系统 | **D 档** |
| **沙箱策略** | ❌ 不能 | 属插件配置，`plugin_manager` 需 danger-full-access | **A 档** |
| **审批策略** | ❌ 不能 | `approval.setPolicy(agent)` 是进程内 API | A 档 |
| **凭据** | ❌ 不能（也不应） | `credentials` 需 `CredentialKey`，Host 消费者才能取 | A/C 档 |
| **已装插件集合** | ❌ 不能（也可不应） | `plugin_manager` 明确"Cannot invoke business Service methods"且需 danger-full-access | **C 档（仅人）** |
| **Event 监听** | ⚠️ 需插件注册 | `ctx.on(...)` 是插件能力，不是模型能力 | 由我们的插件持有 |

**关键结论**：
> **模型不能"直接"改运行时——它只能通过"我们注册给它的工具"去改。**
> 这**正是**不变量 2 的天然实现：**我们把哪些能力包装成工具，就等于划定了自进化的合法空间。**
> 所以"进化边界"不是靠提示词约束，而是靠**工具面暴露**。这是 DSH 架构给我们的最大礼物。

---

## 4. 能力对照表（核心交付物）

| 能力需求 | DSH 原语 | 可行性 | 缺口 / 说明 |
|---|---|---|---|
| **常驻 Router 会话** | `agentLoop.createAgent` + preset | ✅ 现成（创建）<br>⚠️ 需验证（唤醒） | **R-1**："创建"没问题，"外部事件唤醒"需 spike |
| **多 Worker 并发** | `agentLoop.createAgent` / `subagents.startActivation` | ✅ **现成** | 并发上限自己管（WorkerSlots） |
| **Worker 一 Ticket 一目录** | `worktrees.create` 或 `workingDirectory.set` | ✅ 现成 | prepare 命令自己跑（走 `subprocess` / shell 工具） |
| **事件源：webhook** | `webhookRuntime.register/dispatch` | ⚠️ **需插件**（且内置只建 Session） | 需要"投递到已有 Session"的自定义实现（R-4） |
| **事件源：HTTP** | `webServer.register(route)` | ✅ 现成 | 需自己做鉴权（`connection.admit`） |
| **事件源：定时** | `timer.interval` / `schedule` 服务 | ✅ 现成 | routine 频率限制自己做 |
| **事件源：文件监听** | `workspaceFiles.changes`（stream）/ `fs/observed` | ✅ 现成 | 防抖自己做 |
| **事件源：IM/邮件/代码平台** | 均需自定义插件（`webhookRuntime` + CLI 或 HTTP） | ⚠️ **需插件** | 这是工作量最大的部分；建议先做 1-2 个 |
| **触发过滤（调模型前）** | **自己的投递逻辑**（在 `agent/inbox/inserted` 之前） | ✅ 可控 | **关键：必须在"投递前"过滤，不能进 inbox 再拦** |
| **硬护栏（调模型后）** | `agent/pre-step` waterfall；`tools/pre-execute` waterfall | ✅ **现成** | 两个 hook 都是 waterfall，可拒绝 |
| **上下文七通道** | `systemPrompt.section/context/variable` + `'system-prompt/assemble'` | ✅ **现成** | 顺序稳定性自己保证（cache 命中） |
| **工具结果生命周期标签** | `'tools/post-execute'` waterfall + `spill.saveText` | ⚠️ **部分** | **R-2**：能否真"不入历史"待验证；spill 是可靠替代 |
| **压缩保留关键指针** | `compaction.compactRegion` / `toolResultPruner.pruneContent` | ⚠️ **需自控** | 默认压缩会丢；需要在 pruner 里保护 DoneSpec/Evidence 引用 |
| **长内容外置** | `spill.saveText` | ✅ 现成 | — |
| **上下文压力观测** | `tokenMeter.contextPressure/measure` | ✅ 现成 | — |
| **审批（D5）** | `approval.setPolicy/request` + `'approval/request'` | ✅ 现成 | 五类强制清单自己实现 |
| **结构化提问** | `userQuestions.askTimed` + `'user-questions/request'` | ✅ 现成 | — |
| **人机卡片** | `actionCards.register/record/view/act` | ✅ 现成 | 需写 UI 插件 |
| **凭据不进上下文** | `credentials.*` + 自建 Broker 进程 | ⚠️ **需自建** | **R-7**：`credentials` 是 Host 消费者 API，模型侧拿不到 → 天然有利；但 Broker 的进程隔离要自己做 |
| **文件写拦截（E 档）** | `fs/write-intent` / `fs/edit-intent` / `fs/delete-intent` waterfall | ✅ **现成** | 这是"存储层禁止"的实现点 |
| **审计流** | `session/event` + `session-telemetry/record` + 自建审计表 | ✅ 现成 + 自建 | 审计必须 append-only |
| **持久化账本** | `storageDomain.open(spec)` + `'domain/changed'` | ✅ 现成 | DomainSpec 需自己设计 |
| **会话日志** | `session/event`（post-commit feed） | ✅ 现成 | — |
| **Watchdog** | 独立 Agent + `timer` + `agent/status` + 自建 W2 指标 | ✅ 现成 | 需自己写 W2 的"实质进展"判定 |
| **自进化落点：preset** | `agentPresets.register`（**运行时**） | ✅ **现成** | R-3（需 spike 确认 mount 生效） |
| **自进化落点：技能** | 文件 + `skills/change` + `skill` 工具 | ✅ 现成 | 版本化自己管（`asset_version`） |
| **自进化落点：工具** | `tools.register` | ✅ 现成（C 档需人批） | 注册后要 `tools/change` 广播 |
| **自进化落点：提示词** | `systemPrompt.section/context` | ✅ 现成 | 版本化自己管 |
| **配置热改** | `configEditor.entries/configuration/edit` | ⚠️ **仅人**（C 档） | `edit` 是程序化改配置并热生效，但应只给人用 |
| **远程/多机** | `connection.createPeer/admit`、`ssh`、`forge` | ✅ 现成 | 端侧 daemon 协议自己做 |
| **Web 面板** | `clientModules` + `webServer` | ✅ 现成 | 需写客户端插件 |
| **页面注入（会话绑定）** | `webserver/index-inject` | ✅ **现成** | 乱雨家"注入 JS"的等价物 |
| **命令** | `commands.register` | ✅ 现成 | — |
| **技能加载** | `skill` 工具 + `skills/change` | ✅ 现成 | 分级目录自己组织 |

---

## 5. 缺口汇总

### 5.1 需写插件（工作量小-中）

| # | 缺口 | 说明 |
|---|---|---|
| G1 | **事件投递器** | 把外部事件投进 Router/Scene Session（依赖 R-1/R-4 结论） |
| G2 | **场景契约加载与校验** | `scene.yaml` → 内部结构；校验 forbidden 路径 |
| G3 | **DoneSpec 执行器** | 跑 check、收集 evidence、产出 diff-set |
| G4 | **注意力账本 + 三上限** | 记账 + 拦截第 4 条消息 |
| G5 | **E 档文件拦截** | 用 `fs/*-intent` waterfall 实现"跨场景写拒绝" |
| G6 | **上下文七通道装配** | `systemPrompt.section/context` + 顺序稳定 |
| G7 | **工具族注册** | `tools.register` + `restrict` + 家族参数归一化 |
| G8 | **Watchdog W2** | 实质进展判定（last_progress_at、evidence 增长） |
| G9 | **进化提案流水线** | 提案/沙箱/封存集/灰度/回滚 |
| G10 | **面板** | 第一屏 + 卡片 + 提案审批 |

### 5.2 需改运行时（不建议，尽量避免）

| # | 需求 | 是否能绕开 |
|---|---|---|
| T1 | 让"外部事件唤醒不活跃 Session"更直接 | ✅ 可绕（用 continuable child / 新建+seed） |
| T2 | 让工具结果"永不入历史" | ✅ 可绕（spill + 工具不返回长内容） |
| T3 | 更细的压缩控制 | ⚠️ 部分可绕（自建 pruner 策略 + 保护引用） |
| T4 | 真正的进程级凭据隔离 | ⚠️ 需自建 Broker 进程（不改运行时，另起进程） |

> **结论：不需要 fork DSH。** 唯一可能需要外部组件的是"凭据 Broker"（独立进程）与"端侧 daemon"（独立进程）——这两者都在运行时之外，不算改运行时。

### 5.3 不可行 / 明确不做

| # | 需求 | 结论 |
|---|---|---|
| U1 | 让模型直接注册插件 | ❌ 不做（C 档） |
| U2 | 让模型改审批策略 | ❌ 不做（A 档） |
| U3 | 让模型读凭据明文 | ❌ 不做（安全底线） |
| U4 | 跨实例 A2A | ❌ v1 不做（按 `02` §16 / `04` §11 X2） |

---

## 6. 待 spike 清单（按优先级）

| P | spike | 问题 | 影响 |
|---|---|---|---|
| **P0** | `r1-resume-delivery` | 持久 session 能否被外部事件唤醒并驱动一轮 | **架构地基** |
| **P0** | `r1b-peer-delivery` | 平级 Session 能否投递；不行则用父子 | 编排拓扑 |
| **P1** | `r3-preset-hot-register` | `agentPresets.register` + `mount` 是否立即生效 | 零重启加场景 |
| **P1** | `r4-webhook-to-session` | 自定义 webhook rule 能否投递到已有 session | 外部事件入口 |
| **P2** | `r2-lifecycle-tag` | `tools/post-execute` 能否实现"不入历史" | 上下文纪律 |
| **P2** | `r7-credential-broker` | `credentials` 语义 + Broker 可行性 | 安全 |
| **P3** | `r6-approval-integration` | `approval.setPolicy` 与 `autonomy.ceiling` 的映射 | D5 落地 |

---

## 7. 附录：实测查询记录

| 查询 | 结果规模 | 用途 |
|---|---|---|
| `Service.listService`（无参） | ~150 个服务目录 | §1 服务全景 |
| `Service.listService({service:'webhookRuntime'})` | 完整契约 + 类型 | §1.3 / R-4 |
| `Service.listService({service:'subagents'})` | 完整契约 + 30+ 类型声明 | §1.1 / J2 |
| `Event.listEvents`（无参） | **80+ 事件目录** | §2 事件全景 |
| **未做（受篇幅与配额限制）** | `Config.listConfigs`、`Tool.listTools`、`Event` 逐个精确契约 | 建议在 P0 spike 时补 |

> **诚实说明**：§5 里标 ⚠️ 的项都还需要精确契约验证（本文档只做了目录级 + 两个重点服务的精确查询）。这不是遗漏，是**有意的分层**——精确契约应该在写代码前的 spike 阶段逐个拉，而不是一次性全拉进上下文。
