# OpenHands 拆解（D:\refs\openhands）

> 拆解口径：**抄哪几行**。每条结论带 `文件:行号`；未找到就写「未找到」。

---

## 0. ⚠️ 先纠正一个前提（影响整份报告的读法）

任务前提写的是「2,897 文件 / Python / All-Hands-AI / 老牌开源 agent」。
**这个 checkout 不是那个 Python 后端，而是 OpenHands 的 Agent Canvas 前端。**

证据：

- `package.json:2-3` → `"name": "@openhands/agent-canvas"`, `"version": "1.41.0"`
- `AGENTS.md:5` → 「This repository is the OpenHands Agent Canvas React/TypeScript frontend.」
- `AGENTS.md:33` → 后端是另一个仓 `OpenHands/software-agent-sdk`：「Python SDK, Agent Server, agents/tools, conversations, events…」
- `docs/architecture.md:14-19` → 「Agent Canvas is **not** responsible for: Executing agent actions directly / Providing the sandbox or workspace isolation layer / …」
- 文件构成实测：`.ts/.tsx` 2,391 个；`.py` 仅 **17** 个，且全是 fixture/CI 脚本（`.agents/skills/verify-openhands/scripts/fixtures/*.py`、`.github/scripts/*.py`、`tests/e2e/mock-llm/scripts/*.py`），产品代码里唯一的 Python 是 `tools/canvas_ui_tool.py`。
- 最近提交：`5ed4ffa 2026-11-16 chore(main): release 1.41.0 (#19687)`（`git log -1`）

**所以：agent 主循环的「实现」不在这个仓库。** 但本仓库把循环的**线上契约（事件/动作/观察/状态机/停止开关）完整镜像**成 TypeScript——这恰好是 C1/C2 最该抄的部分，因为契约就是接口，接口决定我们 DSH 侧怎么接。第 6 段按「本仓库能看到的循环」写，实现位置一律标注「不在本仓库」。

Star 数：本机离线，**未查**（不作猜测）。

---

## 1. 定位与规模

一句话：OpenHands 的 **Agent Canvas 前端** —— 一个 React/TS 单页应用，负责渲染对话、终端、浏览器、文件、设置、自动化，并把 UI 操作翻译成 Agent Server 的 API 调用；agent 执行、沙箱、调度全在外部服务。

| 项 | 值 | 证据 |
|---|---|---|
| 文件总数 | 2,897 | `Get-ChildItem -Recurse -File` 计数 |
| 主语言 | TypeScript/React（2,391 个 .ts/.tsx） | 同上 |
| Python | 17 个，全为 fixture/CI | 见 §0 |
| 版本 | 1.41.0 | `package.json:3` |
| 最近提交 | 2026-11-16 | `git log -1` |
| 依赖锚点 | agent-server 1.62.0 / automation 1.32.1 / 最低兼容 1.59.0 | `config/defaults.json:3-10` |
| star | 未查 | — |

运行形态有 4 种：`dev`（uvx 起 agent-server + Vite + ingress）、`dev:minimal`、`dev:static`、`dev:mock`（MSW）——`docs/architecture.md:49-56`。

---

## 2. 架构骨架

### 2.1 顶层目录 → 职责

| 目录 | 职责 | 证据 |
|---|---|---|
| `src/api/` (114 文件) | 服务适配层：Agent Server、cloud、settings、git、skills、automations、backend registry | `docs/architecture.md:37` |
| `src/components/` (716 文件, 11 子目录) | 路由与特性 UI：conversation/chat/browser/files/settings/backend/automation/onboarding | `docs/architecture.md:38`；子目录 `browser conversation conversation-events features files providers settings shared sidebar terminal ui` |
| `src/hooks/` (279 文件) | React Query 与特性 hooks | `docs/architecture.md:39` |
| `src/stores/` (26 文件) | Zustand 全局状态（conversation/event/goal/metrics/session-activity…） | `docs/architecture.md:40` |
| `src/routes/` (42 文件) | react-router 路由组件 | `src/routes.ts:8-52` |
| `src/types/agent-server/core/` | **后端事件/动作/观察模型的 TS 镜像**（本报告的核心证据源） | `src/types/agent-server/core/index.ts:1-9` |
| `src/extensions/` | Canvas 扩展（Apps）的加载器与 iframe 宿主 | `src/extensions/canvas-extension-module-loader.ts:1-41` |
| `src/manifests/` | 自动化清单的 admission / 校验 / 注册表 | `src/manifests/manifest-registry.ts:1-51` |
| `src/i18n/` | i18next 翻译资源 | `docs/architecture.md:41` |
| `src/mocks/` | MSW mock 与 e2e fixture | `docs/architecture.md:42`；`src/mocks/canvas-extensions-handlers.ts:7` |
| `bin/` `scripts/` | CLI 与本地栈启动器 | `docs/architecture.md:43` |
| `electron/` | 桌面壳 | `electron-builder.config.mjs` |

### 2.2 依赖方向（有单向约束，且被 CI 强制）

- 约定：`Agent Server contract → TypeScript client → Agent Canvas`，明令「Do not reimplement Agent Server endpoints or contracts in Canvas」——`AGENTS.md:37`。
- 三仓边界表：`OpenHands/OpenHands`(本仓=UI) / `software-agent-sdk`(Python 后端) / `extensions`(公共 skills·automations·plugins) / `automation`(调度) —— `AGENTS.md:30-35`。
- **强制手段是测试，不是文档**：`src/api/no-direct-agent-server-calls.test.ts:32-70` 全量扫描 `src/**/*.ts(x)`，禁止 `openHands.`、`createHttpClient(`、直连 `@openhands/typescript-client/client/http-client`、`new HttpClient(`、以及未白名单的 `axios(...)` / `fetch('/api/...')`（白名单只有 3 个文件，`:7-11`）。这是「依赖方向靠 CI 脚本强制」的现成例子。

### 2.3 核心 / 插件边界

宿主 = Canvas，扩展 = 三类（skills / plugins / Apps），边界靠 **manifest + 能力门 + 宿主 API 白名单**，见 §3。

### 2.4 执行 / 沙箱隔离分层（用户明确：我们不做越界拦截，只看分层）

OpenHands 这里的分层很干净，一共 4 层，**前端只负责「选层 + 传参」**：

1. **Workspace 层**：start 请求里的 `workspace.kind` 只有两种——`LocalWorkspace`（`working_dir`）或 `DockerExecutionWorkspace`（固定 `DOCKER_EXECUTION_WORKING_DIR`）——`src/api/agent-server-adapter.ts:994-1003`、`:1392-1401`。
2. **Runtime 层**：服务器自报 `execution_runtime: "local" | "docker"`，前端据此选 workspace——`src/api/agent-server-compatibility.ts:38`、`src/api/agent-server-adapter.ts:261-264`。
3. **容器资源层**：`container_memory` / `container_cpus` / `container_browser` 只发非默认值——`src/api/agent-server-adapter.ts:815-835`。
4. **Cloud sandbox 层**：云模式独立的 `sandbox_id` 生命周期——pause 走 `pauseCloudSandbox`，resume 走 `resumeCloudSandbox`——`src/hooks/mutation/conversation-mutation-utils.ts:61-79`、`:163-192`。
5. **子会话隔离层**：`isolation: "worktree" | "shared"`，worktree 用 `git worktree add` 切独立分支，shared 直接共用父目录并明确警告会互相踩——`src/services/child-conversation-launch.ts:265-317`、`src/constants/child-conversation.ts:26`。

有一个很值钱的**架构自白**：`config/defaults.json:32` 承认 vscode 编辑器用「路径前缀」路由而非隔离——「a path prefix routes but does not isolate, so the editor shares the canvas's browser origin and therefore its localStorage」。即 OpenHands 自己也知道「路径级隔离 ≠ 真隔离」。我们不抄它的拦截机制，但可以抄这个**分层命名**（workspace / runtime / container / sandbox / worktree）。

### 2.5 多代理 / 委派（A8/A9）

两条独立机制，**都不是对等团队**：

- **父子会话委派**：`launch_child_conversation` 客户端工具（`src/api/launch-child-conversation-client-tool.ts:61-112`），实际执行在 `src/services/child-conversation-launch.ts:511-551`。特点：child 独立跑、父看不到 child 输出、异步回填（见 §6.7）。
- **SDK 内 subagent**：`TaskAction` / `TaskObservation`（`src/types/agent-server/core/base/action.ts:284-301`、`observation.ts:305-326`），带 `subagent_type`、`resume`（续跑已有子任务）、`task_id`。
- **ACP 外部 agent**：`ACPToolCallEvent`（`src/types/agent-server/core/openhands-event.ts:33-34`），把 Claude Code / Codex / Gemini / Pi / opencode 当子进程 agent 接进来（`src/constants/acp-providers.ts:10-23`）。
- **没有** peer/teammate/团队消息总线：grep `teammate|peer|swarm|orchestrator` 无产品级命中（未找到）。

---

## 3. 【A12】插件 / 扩展机制（重点）

本仓有 **三种彼此独立的扩展形态** + 一套共用范式（声明式清单 → 能力门 → 服务端安装 → admission 校验 → 可启停/刷新）。

### 3.1 形态一：Agent plugins（目录包，给 agent 加 skills）

- **清单/数据形状**：`MarketplacePlugin { name, description, source, ref, repo_path, installed, path, skills[], files[] }`——`src/api/plugins-service.ts:21-31`；本地「ambient」插件 `LocalPlugin { name, version, description, path, skills, files }`——`:41-48`。
- **怎么被发现**：不在前端扫描，由 agent-server 报告。`getPluginsMarketplace()` 走 `PluginsClient.getPluginsMarketplace()`（`plugins-service.ts:76-91`）；`getLocalPlugins()` 走 `getPlugins({ load_user: true, load_project: false })`——`:104-117`，注释明确目录是 `~/.agents/plugins`、`~/.openhands/plugins`（`:96-98`）。
- **怎么装载**：装的是「目录」，由服务端 clone 到 `~/.openhands/plugins/installed/`（`plugins-management-service.ts:65-75`）。
- **怎么校验**：无前端 schema；服务端返回已解析的 `skills`/`files`，加载失败时字段为 `null`（`plugins-service.ts:8-12` 注释「null when the installed plugin directory failed to load」）。
- **贡献点**：只能给 agent 加 **skills**（prompt 级），不加 UI、不加命令。
- **隔离**：插件跑在 agent 进程里，前端完全碰不到；前端只能读文件内容用于展示（`plugins-service.ts:127-147`，`FileClient.downloadFile` + NUL 字节判二进制 `:56-65`）。
- **热插拔**：`installPlugin / setPluginEnabled / uninstallPlugin / refreshPlugin` 四件套——`plugins-management-service.ts:42-53`、`:76-133`；状态存服务端，前端云后端下全部禁用（`:55-57`、`:78-80`）。
- **怎么挂到会话**：start payload 的 `plugins: [{source, ref?, repo_path?}]`——`src/api/agent-server-adapter.ts:1008-1016`。

### 3.2 形态二：Canvas Extensions / Apps（ESM 前端包，这是最像「我们的插件」的）

**清单文件 `canvas-extension.json`**——`src/types/canvas-extension.ts:17-28`：

```ts
export interface CanvasExtensionManifest {
  schema_version: typeof CANVAS_EXTENSION_MANIFEST_SCHEMA_VERSION; // = 1
  name: string;
  display_name?: string | null;
  version: string;
  description?: string | null;
  entrypoint: string;
  backend?: { secret_refs?: string[] } | null;
  contributes?: CanvasExtensionContributions | null;   // { pages?: [{id,title,path,nav_label,description}] }
  icon?: string | null;                                // 由 Agent Server 在 /installed/{name}/icon 提供
}
```

- **发现**：`CanvasExtensionsService.listInstalled()` → `GET /api/canvas-extensions/installed`（`src/api/canvas-extensions-service.ts:245-253`）。
- **装载**：`fetchBundle(name)` 拿到 ESM 源码文本（`:294-301`）→ `loadCanvasExtensionModule(source)` 用 **Blob URL + 动态 import**（`src/extensions/canvas-extension-module-loader.ts:30-41`），并 `assertCanvasExtensionModule` 强制导出 `activate` 函数（`:10-23`）。
- **贡献点**：只能 `registerPage(contributionId, mount)`，且**必须是清单里声明过的页**，否则抛错——`src/components/features/canvas-extensions/canvas-extensions-runtime.tsx:78-101`（`getDeclaredPage` → 「registered undeclared page」）。段/路径还做 `^[a-z0-9]+(-[a-z0-9]+)*$` 校验（`:64-66`）。
- **宿主 API 白名单（隔离的关键）**——`src/types/canvas-extension.ts:82-105`：只给 `apiVersion`、`extension{name,version,resolvedRef}`、`backend{id,kind,orgId}`、`registerPage`、`navigate`、`agentServer.request`、可选 `appBackendView`。**没有** `window`、没有 fetch、没有 store。`agentServer.request` 还强制 root-relative 路径（`src/api/canvas-extensions-service.ts:320-336`：`path` 必须以单个 `/` 开头，禁止 `//`）。
- **后端视图隔离**：App 的后端面板是 **iframe**，sandbox token 由服务端下发并二次校验（`src/extensions/canvas-extension-app-view.ts:61-69`、`:178`；同源校验 `canvas-extensions-service.ts:162-176`）。
- **装/启/卸**：`install`（`:255-265`）、`setEnabled(name, enabled, consent{revision, secret_refs})`（`:267-285`，启用必须给 consent，且要求后端具备 `canvas_app_backend_enable_lifecycle_v1` 能力）、`uninstall`（`:287-292`）。
- **能力门**：不支持的后端不是静默失败，而是三分类错误 `no-backend | cloud-backend | missing-api`（`:47-64`），404 映射成 `missing-api`（`:109-118`）。
- **热插拔**：`enable/disable` 即插即用；运行时按 `activationSignature`（backend + 已启用清单 + installed_at）整体重建页面（`canvas-extensions-runtime.tsx:141-163`），刷新同一版本也会重挂。

### 3.3 形态三：声明式 automation manifest（「清单是不可信数据」的最佳示范）

- **admission**：`createSetupRegistry(candidates)`——`src/manifests/manifest-registry.ts:19-51`。规则：没有 `setup` 块的条目直接跳过（是卡片不是安装体验，`:26-28`）；校验失败 **整条丢弃**并 `console.warn`，绝不半渲染（`:30-35`）；重复 id 拒绝（`:37-42`）。
- **为什么丢弃**：注释原话「everything downstream treats its content as instructions」（`:6-8`）；`types.ts:334-342` 又写「the published data is validated at admission rather than trusted」。
- **闭集约束**：字段类型 `SetupFieldType`（`:17-29`）、Git provider（`:36-37`）、图标 slug 只允许 8 个（`:431-442`）、概览指标只允许 4 个（`:452-457`）、endpoint 只给 3 个 preset（`:285-286`）。**manifest 只能「选」宿主实现，不能「定义」宿主行为**（`:416-424` 的注释说得最清楚）。
- **校验器**：`hasSetupBlock` + `validateSetupEntry`（`src/manifests/manifest-registry.ts:10`、`src/manifests/manifest-validation.ts`），另有 `manifest-local-validation.ts` / `interface-validation.ts`。
- **超时上限也由部署自报**：`DeploymentCapabilities.maxAutomationTimeoutSeconds`（`types.ts:244-247`），前端据此约束表单。

### 3.4 小结：这套范式里真正能抄的 5 个动作

1. 清单是**数据**，不是代码；先 admission 再使用。
2. 失败**整条丢弃**，不做部分渲染（避免半可信内容进入下游）。
3. 能力**用闭集枚举**，manifest 只做选择题。
4. 宿主 API 白名单 + 路径/段名校验 + 贡献点必须已声明。
5. 安装状态归服务端，前端只做 install/enable/disable/refresh 的代理，云/不支持时给**结构化错误原因**。

---

## 4. 【A13】MCP / 工具接入

- **配置形状**：`MCPServerConfig { id, type: "sse"|"stdio"|"shttp", url?, headers?, timeout?, command?, args?, env?, auth?, enabled? }`——`src/types/mcp-server.ts:11-29`；`enabled` 缺省视为启用（`:25-28`）。
- **连接/健康**：`McpServerHealth` 四态 `unchecked | checking | healthy | failed`，且区分证据强度 `verified`（跑了一次真实只读工具调用）vs `connectivity-only`（只 connect + tools/list）——`src/types/mcp-health.ts:3-25`。这是个很细但很值的区分：**「连上了」不等于「凭据能用」**。
- **probe 超时**：云侧 `DEFAULT_MCP_TEST_TIMEOUT_SECONDS = 15`，请求 deadline 取 `2*timeout+5` 覆盖连接+工具调用——`src/api/cloud/mcp-service.api.ts:11,35-46`。
- **用户管理 UI**：`/mcp` 路由自带 marketplace、已安装区、安装弹窗、自定义 server 编辑器——`src/routes/mcp.tsx:28-36`（`McpToolbar / MarketplaceSection / InstallServerModal / CustomServerEditor / InstalledServersSection`），配置解析 `parseMcpConfig`（`:13`）。
- **工具怎么暴露给模型**：后端做，前端只见契约——`MCPToolAction { data: Record<string, unknown> }`（`src/types/agent-server/core/base/action.ts:8-13`）。
- **结果怎么回填**：`MCPToolObservation { content: (Text|Image)[], is_error: boolean, tool_name: string }`——`src/types/agent-server/core/base/observation.ts:9-22`。注意它把「错误」建模成 observation 字段而非抛异常，这一点和 §6 的 tool-failure 处理直接相关。

---

## 5. 【A11】调度 / 后台任务

前端**不 tick 任何定时器**（`docs/architecture.md:19`「Running scheduled or event-triggered automations without an automation backend」= not responsible；`:28-29` 调度在 Automation Server）。

能抄的是**任务定义的字段设计**——`src/types/automation.ts:1-28`：

```ts
AutomationTrigger {
  type: string;              // "cron" | "schedule"（时间）/ "event"（事件）；故意不闭集
  schedule?: string;         // cron 表达式
  schedule_human?: string;   // 人话描述
  timezone?: string;         // IANA
  source?: string;           // 事件源，如 github
  on?: string | string[];    // 事件键，"pull_request.opened" / ["push","release.*"]
  filter?: string;           // JMESPath，对原始 webhook payload 求值
  destination?: string;      // "dispatch_run"（默认） | "continue_conversation"（续跑原会话）
}
```

失败处理（这是四态之外最值钱的一段）：
- `AutomationState = "ACTIVE" | "INACTIVE" | "DRAFT"`（`types/automation.ts:43`）。
- `disabled_reason` + `disabled_detail { reason, source, run_id, threshold, consecutive counts, status_detail }`——`types/automation.ts:79-93`。注释点明区分「manual 用户手动禁用」和「自动禁用（连续失败、永久配置故障）」。**这就是我们缺的「tool failure loop 检测」的同类机制，只是它在调度层而不是循环层。**
- 创建时可带 `timeout`（秒）——`src/api/automation-service.api.ts:142,424`；已有 automation 则返回 200 表示「已装」而不是假装新建（`:830-833`）。
- 草稿（draft）是**服务端持久化的一等对象**，每次 create/update 服务端回刷 `validationErrors` + `dispatchable`——`src/manifests/types.ts:288-326`。

UI：`/automations`、`/automations/templates`、`/automations/events`、`/automations/new/:automationId`、`/automations/:automationId`——`src/routes.ts:38-44`。

---

## 6. 【C1/C2】agent 主循环与停止条件（最长段）

### 6.1 主循环在哪个文件？—— 本仓库没有（未找到）

**未找到主循环实现。** 三条硬证据：

1. `docs/architecture.md:14-19`：Agent Canvas 明确「**not responsible for Executing agent actions directly / Providing the sandbox or workspace isolation layer**」。
2. `AGENTS.md:33`：agents/tools/conversations/events 属于 `software-agent-sdk`。「Do not reimplement Agent Server endpoints or contracts in Canvas」（`AGENTS.md:37`）。
3. 产品代码里唯一的 Python 是单个工具 `tools/canvas_ui_tool.py`；没有任何 `AgentController` / `while True` 循环（grep `AgentController|while True|run_loop` 在 `src/ docs/ tools/` 无命中）。

**但本仓库完整镜像了循环的契约层**（`src/types/agent-server/core/`），这就是可抄的东西。下面全部按「契约」写，涉及判定实现的地方标「SDK 内，未找到」。

### 6.2 一轮怎么定义

一轮 = **一次 `ActionEvent` + 一条对应的 `ObservationEvent`**，两头靠 `tool_call_id` 配对。

- 事件基底：`BaseEvent { id, timestamp, source }`，`source ∈ "agent"|"user"|"environment"|"hook"`——`src/types/agent-server/core/base/event.ts:10-25`、`common.ts:56`。
- 十六类事件的总 union——`src/types/agent-server/core/openhands-event.ts:25-46`：`ActionEvent | MessageEvent | ObservationEvent | UserRejectObservation | AgentErrorEvent | SystemPromptEvent | ACPToolCallEvent | HookExecutionEvent | CondensationEvent | CondensationRequestEvent | CondensationSummaryEvent | ConversationStateUpdateEvent | ConversationErrorEvent | PauseEvent | ServerErrorEvent | StreamingDeltaEvent`。
- 收尾一轮用 `FinishAction { message }`（`action.ts:15-20`）/ `FinishObservation { content, is_error }`（`observation.ts:24-33`）。
- 流式输出单独走 `StreamingDeltaEvent`（不入 `Action/Observation`，只在 UI 侧拼临时气泡，见 `use-event-store.ts:110-127` 的注释）。

### 6.3 停止条件枚举（贴行号，这是全报告最该搬走的一张表）

| # | 停止条件 | 本仓库位置 | 判定实现在哪 |
|---|---|---|---|
| 1 | **max iterations** | `agent-server-adapter.ts:179-183`（`DEFAULT_MAX_ITERATIONS = 500`）→ payload `:1037`、`:1241`、`:1408`；设置项 `types/settings.ts:132`；`/goal --max N` 覆盖 `use-goal-interceptor.ts:12,38-54` | SDK |
| 2 | **budget（单任务最大花费）** | `max_budget_per_task` 契约 `agent-server-conversation-service.types.ts:41,305`；UI 展示 `conversation-panel/budget-usage-text.tsx:10-28` | SDK |
| 3 | **stuck detection** | start payload **写死 `stuck_detection: true`** — `agent-server-adapter.ts:1038,1242,1409` | SDK（产出 `STUCK`） |
| 4 | **7 态状态机** | `ExecutionStatus = IDLE｜RUNNING｜PAUSED｜WAITING_FOR_CONFIRMATION｜FINISHED｜ERROR｜STUCK` — `core/base/common.ts:67-75` | SDK 写，UI 读 |
| 5 | **等人确认（确认策略）** | `confirmation_policy`：`NeverConfirm` / `ConfirmRisky{threshold:"HIGH", confirm_unknown:true}` / `AlwaysConfirm` — `agent-server-adapter.ts:784-796`；安全分析器 `LLMSecurityAnalyzer/PatternSecurityAnalyzer/PolicyRailSecurityAnalyzer` — `:798-809` | SDK |
| 6 | **显式 finish** | `FinishAction` / `FinishObservation` — `action.ts:15-20`、`observation.ts:24-33` | 模型侧 |
| 7 | **无工具调用 → 等输入** | `IDLE → AgentState.AWAITING_USER_INPUT` — `hooks/use-agent-state.ts:20-21` | 推论：`IDLE` 即本轮到顶 |
| 8 | **用户中断 vs 暂停** | 中断走 `/interrupt`（立即取消在途 LLM）`conversation-mutation-utils.ts:48-59`；暂停在云上=暂停 sandbox `:61-79` | 服务端 |
| 9 | **goal 外层循环的 4 个终态** | `GoalStatus.status = "running"｜"complete"｜"capped"｜"interrupted"`；`capped` 即打满 `max_iterations` — `core/events/conversation-state-event.ts:82-97` | SDK |
| 10 | **judge 判定完成** | `GoalVerdict { score: 0-1, complete: boolean, missing: string }` — `conversation-state-event.ts:68-75` | SDK judge |
| 11 | **工具执行超时** | `ExecuteBashAction.timeout`（秒）/ `ExecuteBashObservation.timeout` 布尔 — `action.ts:38-41`、`observation.ts:74-77`；`-1` exit code 表示软超时未完成（`observation.ts:63-69`） | SDK |
| 12 | **服务器/会话错误** | `ServerErrorEvent{code,detail}`、`ConversationErrorEvent`、`AgentErrorEvent` — `conversation-state-event.ts:153-174`、`openhands-event.ts:31,42` | SDK |

**关键观察（直接回应我们的痛点）**：我们能看到的「刹车」是 `max_iterations` + `budget` + `stuck_detection` **三个并行开关**，不是只一个 maxTurns；「停」被建模成 **7 态**而不是布尔；「等用户」(`WAITING_FOR_CONFIRMATION`) 和「暂停」(`PAUSED`) 是**一等状态**不是异常。这正是我们 C2 缺的粒度。

### 6.4 循环状态怎么持久化（断了能续 —— 能）

答案：**服务端事件日志是唯一真相，前端只维护游标 + 去重**。

1. **先 REST 拉历史（分页），再开 WS**：`useConversationHistory(conversationId)` 首屏预载 → 只有首屏加载完才建 socket，目的是能用 `resend_mode='since'` 而不是 `'all'` — `contexts/conversation-websocket-context.tsx:444-453`、`:594-618`。
2. **游标是 `after_seq`**（取代旧的 `resend_mode/after_timestamp`，注释说旧方案比的是 naive 本地时间戳）——`conversation-websocket-context.tsx:1296-1307`，首次连接无游标用 `-1` 要全量，REST 重叠部分靠事件 store 按 id 去重。
3. **去重**：`appendEvent` 用 `eventIds: Set` 做 O(1) 判重 — `stores/use-event-store.ts:129-140`；`addEvents` 把「向上翻页」的旧页按 timestamp **重排插到正确位置** — `:86-92`。
4. **客户端工具调用幂等台账**：`claimClientToolCall(ledgerKey, toolCallId)`，localStorage 记已处理的 toolCallId，防止 socket 重连 `resend_mode:'all'` 时把「启动子会话/花钱」类非幂等动作重放一遍 — `utils/claim-client-tool-call.ts:1-33`。
5. **续跑对话**：`resumeConversation` → `runConversation(conversationId)` — `conversation-mutation-utils.ts:163-197`。
6. **续跑 goal**：`resumeGoal(conversationId)`，服务端「resume 本会话最后一个 goal」，没有可续的返回 `no_resumable_goal` — `:126-133`；UI 只在「最新且 interrupted 且当前无活跃 goal」时显示 Resume — `goal-status-content.tsx:148-168`。
7. **本地 UI 活动记录**（只是展示，不是循环状态）：`session-activity-store.ts:1-18` 的 `SessionActivity{kind:"initialize"|"resume", phase:"pending"|"connecting"|"complete"|"failed"}`，存 sessionStorage（`:173-198`），注释明确「Presentation history for this tab only; never sent as agent events」（`:71`）。

### 6.5 观察 / 动作空间怎么定义（有没有 AgentController？）

**没有 `AgentController` 类（未找到）**。等价物是三个 TS union，这就是「动作空间 / 观察空间」的正式定义：

- **动作空间**：`type Action = MCPToolAction | FinishAction | ThinkAction | ExecuteBashAction | TerminalAction | FileEditorAction | StrReplaceEditorAction | TaskTrackerAction | PlanningFileEditorAction | BrowserNavigateAction | BrowserClickAction | BrowserTypeAction | BrowserGetStateAction | BrowserGetContentAction | BrowserScrollAction | BrowserGoBackAction | BrowserListTabsAction | BrowserSwitchTabAction | BrowserCloseTabAction | GlobAction | GrepAction | InvokeSkillAction | TaskAction | SwitchLLMAction | CanvasUIAction | AutomationFormUpdateAction | LaunchChildConversationAction | RequestSecretAction`——`core/base/action.ts:369-397`（27 种）。
- **观察空间**：`type Observation = MCPToolObservation | FinishObservation | ThinkObservation | BrowserObservation | ExecuteBashObservation | TerminalObservation | FileEditorObservation | StrReplaceEditorObservation | TaskTrackerObservation | PlanningFileEditorObservation | GlobObservation | GrepObservation | InvokeSkillObservation | TaskObservation | CanvasUIObservation | SwitchLLMObservation | ClassifyAndSwitchLLMObservation`——`core/base/observation.ts:389-406`（17 种）。
- **关键设计点**：动作和观察**不是一一对称**的（`Browser*` 有 10 个 action 只对应 1 个 `BrowserObservation`；`ThinkAction` 有 action 但观察只是确认串），说明它们按「工具」而非「RPC」建模。
- **「客户端工具」= 动作空间里的宿主回调**：`ClientToolSpec { name, description, parameters(JSON Schema), annotations{readOnlyHint,destructiveHint,idempotentHint,openWorldHint} }`——`api/canvas-ui-client-tool.ts:9-20`。注册到会话：payload `client_tools` — `agent-server-adapter.ts:1224-1238`。这四个 annotation 就是「这个动作能不能并发/能不能重放/要不要确认」的机器可读声明，**很值得抄**。
- 工具开关还有一层账号级 `disabled_skills/enabled_skills`（`types/settings.ts:151-158`）。

### 6.6 一张「我们该补什么」的对照表

| 我们现状 | OpenHands 的事实 | 差距 |
|---|---|---|
| 只有 `maxTurns?: number`（`AgentAPI.ts:65`） | `max_iterations` + `stuck_detection:true` + `max_budget_per_task` 三开关 | 缺 stuck / budget |
| 无 idle/hard timeout | `WAITING_FOR_CONFIRMATION`/`PAUSED` 一等状态 + bash 软/硬超时（exit `-1`） | 缺「等」与「超时」的状态建模 |
| 无 tool failure loop 检测 | 调度层有 `disabled_detail{consecutive counts, threshold}` 连续失败自动禁用（`types/automation.ts:79-93`） | 可在循环层照此加计数器 |
| 停止=结束，二值 | 7 态 + goal 4 终态（complete/capped/interrupted/running） | 缺「打满上限」与「被打断」的区分 |

### 6.7 附带：多代理委派里的「子循环何时算停」

子会话不是本轮循环的一部分，它是**独立会话 + 异步结果回填**：

1. 工具调用先被服务端 ack（浏览器还没干活），所以结果只能靠**消息**回填：`postClientToolResult` 以 `[child-conversation] ` 前缀发一条 user 消息，由 agent 下一轮转述——`services/client-tool-result.ts:16-28`、`constants/child-conversation.ts:11-20`。
2. **goal 循环期间禁止回填**：`postClientToolResult` 先查 `useGoalStore`，`active` 直接 return（`client-tool-result.ts:21-23`），因为「agent-server cancels an active /goal loop on any inbound message」（`:12-14`）。这是个很隐蔽的耦合，抄的时候必须注意。
3. 子会话的「停」由它自己的 `ExecutionStatus` 决定，父只轮询 `startTask.status`（`READY`/`ERROR` 停止轮询）——`hooks/query/use-sub-conversation-task-polling.ts:22-41`；cloud 分支有 180s 上限轮询 `child-conversation-launch.ts:44-45,359-378`。

---

## 7. 【A6/A7】记忆

结论：**没有长期记忆子系统**。有「上下文工程」，没有「记忆库」。

- **A6 部分**：
  - `SkillType = "repo" | "knowledge" | "agentskills"`——`types/settings.ts:67`。`knowledge` 类 skill 是最接近「记忆」的东西（文件型 SKILL.md）。
  - 组装在 `buildAgentContext`：把 `agent_context.skills` 与内置 ~60 条 skills 合并，内置走 **allow-list**（注释解释：deny-list 会让未来每条新增都进 system prompt，`agent-server-adapter.ts:929-939`），并置 `load_public_skills:false / load_user_skills:true / load_project_skills:true`（`:941-961`）。
  - 压缩代替记忆：`enable_default_condenser` / `condenser_max_size`（`types/settings.ts:135-136`；云侧 `api/cloud/settings-service.api.ts:34-92`），planner 用 `LLMSummarizingCondenser{max_size:100, keep_first:6}`（`agent-server-adapter.ts:1385-1390`）。
- **A7 无**：grep 全仓 `ttl|supersede|decay|老化|conflict` 无记忆淘汰逻辑（未找到）。没有「溯源标注 / 冲突消解 / TTL」。
- **跨会话召回**：`getStoredConversationMetadata` 只在子会话启动时读父的 repo 元数据（`child-conversation-launch.ts:16,276`），不是语义召回。

---

## 8. 【D1–D5】界面

- **技术栈**：React 19.3 + react-router 8.5 + HeroUI 3.2 + Tailwind 4.3 + Zustand + TanStack Query 5 + Monaco + xterm 6 + i18next 27（`package.json:24-60`）。
- **布局范式（D1）**：路由树 `src/routes.ts:8-52`；会话页 = 左聊天 + 右 tab 面板（`files / terminal / browser / vscode / planner / tasklist`，见 `canvas-ui-client-tool.ts:74`）+ 可抽屉式 overview（`components/features/conversation/conversation-overview-drawer.tsx`）+ `panel` 独立路由支持移动端（`routes.ts:12-15`）。
- **状态可见性（D3）**——做得比我们好，值得逐项对：
  - `AgentStatus`：一个 pill 里同时表达 loading / stop / resume / error / finished，且 `compact` 模式在聊天有进度时缩成图标——`components/features/controls/agent-status.tsx:74-121`、`:117-118`、`:186-219`。
  - 预算：`BudgetUsageText` 显示 `$x / $y (z%)`——`conversation-panel/budget-usage-text.tsx:10-28`。
  - 上下文用量：`useContextWindowUsage()` 返回 `{perTurnToken, contextWindow}`，优先 store 兜底 metrics——`hooks/use-context-window-usage.ts:6-51`。
  - goal：轮次 `iteration/max`、判分百分比、`missing` 可展开、spinner/勾/叉三态——`goal-status-content.tsx:100-103,170-200`。
  - 成本/用量面板：`conversation/usage-panel/usage-panel.tsx:77`、`metrics-modal/cost-section.tsx:10-19`。
- **可视化（D2）**：Monaco diff 视图（`features/diff-viewer/file-diff-viewer.tsx:1,73`）、mermaid 12（`package.json`）、`driver.js` 引导。没有 dashboard/时间线图表（未找到）。
- **多主题 / 多工作区（D4/D5）**：`themes/color-themes.ts` + `use-color-theme.ts:8-14`（`useSyncExternalStore`）；Monaco 4 套 diff 主题 `file-diff-viewer.tsx:64-138`；多后端切换 `api/backend-registry/*`；i18n 多语言 `src/i18n`。

---

## 9. ⭐ 最值得抄的 3 条机制

### 机制 1：把「停」做成 7 态状态机 + 三个并行刹车开关

```
机制：max_iterations / budget / stuck_detection 三开关并行，停止结果落成 7 态
      (IDLE|RUNNING|PAUSED|WAITING_FOR_CONFIRMATION|FINISHED|ERROR|STUCK)，
      「等人确认」和「暂停」是一等状态，不是异常。
位置：src/types/agent-server/core/base/common.ts:67-75（7 态）
      src/api/agent-server-adapter.ts:179-183,1037-1042,1241-1242（三开关 + 默认 500）
      src/api/agent-server-adapter.ts:784-796（confirmation_policy 三级）
      src/hooks/use-agent-state.ts:12-37（状态→UI 映射）
为什么好：我们现在只有 maxTurns 一个布尔式刹车，「等用户」只能靠超时兜底，
          分不清「打满上限停」和「被打断停」和「卡住停」，导致重试/告警全错。
我们抄到哪：apps/vouch-web/src/web-ui/src/infrastructure/api/service-api/AgentAPI.ts:65
          把 maxTurns 扩成 { maxIterations, maxBudget?, stuckDetection?, confirmPolicy? }，
          并在同文件加 RunStopReason 枚举（7 态），DSH 侧 run 结束必须回填 reason。
```

### 机制 2：`/goal` 外层循环 —— judge 判分 + capped/interrupted + 可 resume，全程事件流

```
机制：外层循环（不是内层工具循环）由「目标 + 判分器」驱动，每轮跑完 judge 一次，
      给 score/complete/missing；终态四值 running|complete|capped|interrupted；
      capped = 打满 max_iterations；interrupted 可 resume 最后一个 goal。
位置：src/types/agent-server/core/events/conversation-state-event.ts:65-97（GoalVerdict/GoalStatus）
      src/hooks/chat/use-goal-interceptor.ts:11-61（/goal [--max N] 解析与启动）
      src/hooks/mutation/conversation-mutation-utils.ts:95-133（start/stop/resume）
      src/components/features/chat/goal-status-content.tsx:100-168（轮次/分数/缺失/停止/恢复）
为什么好：这正是我们「停止条件弱」的解药——不是加更多 if，而是把「什么时候算完」
          外置成一个可判分、可审计、可续跑的循环；且 stop 只取消循环、不杀在途 turn，
          语义清晰（goal-status-content.tsx:122-128 的注释把这个坑写明了）。
我们抄到哪：tools/schedule/ 旁新建 tools/goal/（start/stop/resume/status 四命令），
          状态存对话事件流；judge 用一次独立 LLM 调用返回 {score,complete,missing} JSON。
```

### 机制 3：扩展的「清单 + 能力门 + 宿主 API 白名单 + admission 整条丢弃」四件套

```
机制：扩展是数据不是代码。manifest 只做闭集选择（schema_version/contributes.pages/
      icon/backend.secret_refs）；装载时 assert 只认 activate()；宿主只给 7 个 API，
      贡献点必须已在清单声明否则抛错；后端不满足能力给结构化原因；不可信清单
      校验失败整条丢弃、绝不半渲染。
位置：src/types/canvas-extension.ts:17-28（清单）、:82-105（宿主 API 白名单）
      src/extensions/canvas-extension-module-loader.ts:10-41（assert activate + blob import）
      src/components/features/canvas-extensions/canvas-extensions-runtime.tsx:78-101（未声明页拒绝）
      src/api/canvas-extensions-service.ts:47-64,267-285,320-336（能力门/consent/路径限制）
      src/manifests/manifest-registry.ts:19-51（admission 整条丢弃）
为什么好：我们的 tools/plugin/ 现在是「给插件多大权限」没有答案；它用「白名单 + 必须声明」
          把这个问题变成可枚举的，且失败不污染宿主。A12 的痛点是边界，它给了边界。
我们抄到哪：tools/plugin/ 加 manifest.schema.json（pages/api/权限三段闭集）+
          宿主 API 对象（只给 registerPanel/command/navigate/hostRequest）+ admission
          在加载前整条校验，失败丢弃并回报 reason。
```

> 注：A8/A9 的委派（`launch_child_conversation` + `parent_conversation_id` + worktree/shared 隔离 + `claimClientToolCall` 幂等台账）质量也很高，见 §2.5 与 §6.7；若第 4 条可选，就抄它的「父子链 + 幂等台账 + 异步结果回填」三件套。

---

## 10. 我们不该抄的

1. **13 态 × 8 态 × 7 态的三层状态映射**。`AgentState` 13 个（`types/agent-state.tsx:1-15`）× `ConversationStatus` 8 个（`types/conversation-status.ts:1-9`）× `ExecutionStatus` 7 个（`common.ts:67-75`），映射在 `use-agent-state.ts:12-37`，甚至把 `STUCK → ERROR`「for now」（`:32-33`）。这是历史包袱：多后端多版本兼容的产物。我们单运行时，一套状态就够，抄三层等于自己造 bug。
2. **三层扩展形态（skills / plugins / Apps）全搬**。我们没有 cloud + ACP + 多 workspace 的矩阵，先只抄「Apps」这一层的「清单+白名单+admission」，不要一上来做目录包 git 安装。
3. **把 canvas extension 的 ESM blob import 直接放进主进程**。它的安全性其实来自「只有页贡献 + 宿主对象 + iframe 后端视图」，**不是**来自 ESM 本身——`loadCanvasExtensionModule` 里的 `import(blobUrl)` 一旦在宿主主文档里跑，插件就拿到了整个 window。没有 iframe/worker 隔离就别抄这条，否则是给插件全权限。
4. **`DEFAULT_MAX_ITERATIONS = 500` 这个硬默认**（`agent-server-adapter.ts:180`）。对我们是「跑太久没人管」，抄值不抄数：默认应该更小，且必须能按任务覆盖。
5. **`isCloudBackend()` 双分支**（`plugins-service.ts:77-79`、`plugins-management-service.ts:55-57`、`canvas-extensions-service.ts:83-85`、`conversation-mutation-utils.ts:66-79` …）。我们是单机，这套分叉只会制造死代码；要抄的是它「不支持时给结构化 reason」的思路（`no-backend|cloud-backend|missing-api`），不是双分支本身。
6. **goal 与「任何入站消息都会取消 goal」的耦合**（`services/client-tool-result.ts:12-14`）。照搬到 DSH 会有竞态：我们 `send_message` 是自己实现的，必须显式区分「用户消息」和「工具回填消息」，否则一次工具回填就把 goal 干掉。
7. **condenser / 上下文压缩**。与 DSH 现有压缩重叠，且它自身在 planner 里是手工镜像「preset」的（`agent-server-adapter.ts:1380-1390` 注释承认是在对齐 SDK 预设），说明这套东西耦合深、收益不稳。先不抄。
8. **把「千行以上巨型文件」当范式**：`agent-server-adapter.ts` 1,596 行、`automation-setup-panel.tsx` 4,044 行、`conversation-websocket-context.tsx` 1,660 行、`conversation-panel.tsx` 1,592 行（实测行数）。它自己 `AGENTS.md:41-45` 都在写「shared adapter 改动要枚举所有 consumer」——正是巨型适配器的代价。我们抄结构，不抄体量。

---

## 附：一句话总账

这个仓库**不是 agent 实现，是 agent 的 UI + 契约层**；它最值钱的不是「循环怎么写」，而是**「循环的对外形状」**：
7 态停止状态机、三并行刹车、goal 外层判分循环、以及「清单/能力门/白名单/admission」这套扩展边界。
C1 的实现我们抄不到（在 SDK 里），**C2 的契约我们可以整段搬**——这恰好命中我们「只有 maxTurns」的唯一缺口。
