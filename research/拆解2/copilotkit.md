# CopilotKit 拆解（v2 口径：能抄什么）

> 仓库：`D:\refs\copilotkit` ｜ 24,230 文件（用户给 24,116，本地统计 24,230）｜ 主语言 TypeScript ｜ 最近 commit `8d5faeb2 2026-11-17 07:27 UTC`（`git log -1`）
> 纪律：每个结论带 `文件:行号`；没找到就写「未找到」，不猜。

---

## 1. 定位与规模

一句话：**agent 前端的 UI + 传输框架**——把 AG-UI 协议（`@ag-ui/client` 1.0.4）的事件流接到 React 组件上，提供聊天/侧边栏/弹窗、工具调用渲染、人机审批、记忆与"生成式 UI"，并配一个 Node runtime 做 agent 编排。

- 证据：根 `package.json`（`"name": "CopilotKit"`, `private:true`, pnpm workspace, `engines.node>=20`）；`nx.json`、`pnpm-workspace.yaml`；`packages/*` 共 42 个包。
- 语言：TypeScript 为主（`packages/*/tsconfig.json`，构建用 `tsdown`，见 `packages/react-core/package.json`）。
- 它**不是 agent 后端**：核心 agent 循环在外部依赖 `@ag-ui/client`，本仓 `packages/core` 只是把该 agent 暴露给 React 的桥（`packages/core/package.json` dependencies 里 `@ag-ui/client: 1.0.4`）。

---

## 2. 架构骨架

顶层（`D:\refs\copilotkit`）：

| 目录 | 职责 | 证据 |
|---|---|---|
| `packages/react-core` | **核心 React 组件库 + hooks**（v2 是当前主线，v1-deprecated 是历史兼容） | `packages/react-core/src/v2/`（components / hooks / lib / providers / a2ui / generative-ui） |
| `packages/react-ui` | v1 时代的 CSS/Tailwind 组件（`CopilotChat` 旧实现），现与 v2 并存 | `packages/react-ui/src/components/chat/*.tsx`、`src/css/*.css` |
| `packages/core` | 平台无关内核：agent 注册、run 处理、thread、memory、interrupt、生成式 UI 运行时 | `packages/core/src/core/{agent-registry,run-handler,state-manager,trajectory-connection}.ts` |
| `packages/shared` | 跨端共享：事件转换、类型、telemetry、A2UI 协议 | `packages/shared/src/{event-transforms,telemetry,types}` |
| `packages/runtime` | Node 服务端：把各家 agent 框架转成 AG-UI 事件流（SSE/GraphQL） | `packages/runtime/src/v2/runtime/*`、`src/agent/converters/*` |
| `packages/runtime-client-gql` | 前端 GraphQL/urql 客户端（旧通道） | `packages/runtime-client-gql/package.json`（urql/graphql） |
| `packages/web-inspector` / `web-components` | 开发调试 HUD（Lit web component，浮层显示 agent 内部态） | `packages/web-inspector/src/{hud-loader,home-briefing,persistence}.ts`；`react-core/src/v2/components/CopilotKitInspector.tsx:40-47` 动态挂载 |
| `packages/{react-native,vue,angular}` | 多框架适配（复用 `react-core/v2/headless` 的契约） | `packages/react-core/src/v2/headless.ts` 注释 |
| `packages/channels*` | IM 通道（Slack/Discord/Teams/WhatsApp） | `packages/channels-slack`、`channels-discord`、`channels-teams`、`channels-whatsapp` 目录 |
| `packages/intelligence-*` | 按 agent 框架（LangGraph/Mastra/ADK/.NET）的适配 | `packages/intelligence-langgraph`、`intelligence-mastra`… |
| `sdk-python` / `runtime-{python,go,ruby,dotnet}` | 非 JS runtime 实现 | 顶层 `sdk-python/`、`packages/runtime-go` 等 |

**依赖方向（单向）**：`react-core` → `@copilotkit/core` + `@copilotkit/shared` + `@ag-ui/*`；`core` → `@ag-ui/client` + `shared`；`runtime` → `@ag-ui/*` + `shared`（且 **runtime 不 import react-core**）。证据：`packages/core/package.json` 与 `packages/react-core/package.json` 的 dependencies 列表；`packages/core/src/v2/../index.ts` 只 re-export core/shared。

**边界靠什么强制**：不是类型、不是 CI 脚本，而是 **pnpm workspace + 每包独立 `package.json` 声明依赖 + `tsdown` 分包构建**（`packages/*/tsdown.config.ts`），再加 `publint/attw/check-dts` 发布校验（根 `package.json` scripts `check:packages`）。另外有一个 **headless 子入口**专门隔离"带 UI 的重依赖"：`packages/react-core/src/v2/headless.ts:1-20` 说明主入口会把 streamdown/mermaid/katex 全拖进 bundle，故单独出 `headless` 构建（对应 issue #4893）。**没有**运行期"内核/插件"强边界（见第 3 段）。

---

## 3. 【A12】插件 / 扩展机制

**结论：CopilotKit 没有"用户可安装的运行时插件系统"。** 它有两个层次，都不是传统插件市场：

### 3.1 唯一的"plugin"清单 = 给 Claude Code 用的 skill 分发，不是本框架的插件
- 清单文件：`.claude-plugin/plugin.json`（`name: copilotkit`, `version: 1.88.0`, `mcpServers: "./.mcp.json"`）；`.claude-plugin/marketplace.json`（`plugins:[{name:"copilotkit", source:"./"}]`）。
- 内容只是把 `skills/` 里的 9 个 skill（`skills/copilotkit`、`copilotkit-cli`、`inspector-workbench`…）打包给编码 agent。**它不是运行时插件：没有发现逻辑、没有装载、没有贡献点挂载**——是静态目录+manifest。
- 所以若问"插件怎么被发现/校验/装载/热插拔"：本仓**未找到**面向产品运行时的实现（对应 openclaude 那种 `pluginLoader.ts` 在本仓不存在）。

### 3.2 真正的扩展机制是 **Slots（UI 插槽）+ Renderer 注册表（代码级）**
- **Slots**：每个复合组件把子部件声明为可覆盖"槽"，三态覆盖（组件 / className / props）。
  - 类型：`packages/react-core/src/v2/lib/slots.tsx:12-28`（`SlotValue = C | string | Partial<Props>`；`WithSlots`）。
  - 渲染：`slots.tsx:118-131` `renderSlot(slot, Default, props)`，内部 memo 包装（`slots.tsx:88-108`）。用法遍布：`CopilotChatAssistantMessage.tsx:562-569`（toolCallsView 槽）、`CopilotChatView.tsx:58-67`（messageView/scrollView/input/suggestionView 槽）。
- **Renderer 注册表**（相当于"贡献点"）：hook 注册进 `CopilotKitCore` 的注册表。
  - `useRenderTool`（按工具名）/ 通配 `"*"`：`packages/react-core/src/v2/hooks/use-render-tool.tsx:46-51, 69-114`。
  - `useFrontendTool` / `useHumanInTheLoop` / `useComponent` / `useAgentContext`：`react-core/src/v2/headless.ts:38-52` 导出。
  - 注册/注销是 **React layout effect**，不是动态 import/沙箱：`use-human-in-the-loop.tsx:126-140`（卸载时 `removeHookRenderToolCall`）。
- **能力受限**：renderer 只拿到 `{toolCall, toolMessage, status, parameters, result, respond}`，拿不到宿主内部对象（`use-render-tool-call.tsx` / `CopilotChatToolCallsView.tsx:91-106` 的 props 契约）。
- **热插拔**：无"安装/启用/禁用"状态存储；等于"组件挂载即注册、卸载即注销"。**未找到**持久化的插件启用态。

> 对我们：CopilotKit 给的是 **"槽 + 注册表"的编译期扩展**，不是插件生态。我们要抄的是这套**细粒度 UI 槽**（见第 9 段），别指望它给插件市场。

---

## 4. 【A13】MCP / 工具接入

- MCP 客户端**不在本仓手写**，委托给中间件：`packages/runtime/package.json` dependencies 有 `@ag-ui/mcp-middleware: 0.0.2`、`@ag-ui/mcp-apps-middleware: 0.1.1`、`@modelcontextprotocol/sdk: ^1.18.2`、`@ai-sdk/mcp`。
- runtime 侧只做"按 agent 选 server + 校验策略边界"：`packages/runtime/src/v2/runtime/handlers/shared/mcp-apps-servers.ts:1-40`（`resolveMcpAppsServers`，对 `includeTools/excludeTools` 直接抛错，说明策略归中间件）。
- 浏览器侧 WebMCP：`packages/core/src/core/webmcp.ts:1-45` 把前端工具注册到页面的 `document.modelContext.registerTool`（WebMCP 标准），`getWebMCPModelContext` 做能力探测。
- UI 渲染 MCP Apps 活动：`packages/react-core/src/v2/components/MCPAppsActivityRenderer.tsx`（配套 `packages/mcp-apps-renderer/src/request-queue.ts`）。
- 工具列表怎么暴露给模型：由 AG-UI middleware 合并进 agent 的工具池（`packages/runtime/src/agent/mcp-tool-names.ts` 处理 `mcp__server__tool` 命名）。
- **用户管理 MCP server 的 UI：未找到**（无增删改/启停面板；只能走配置 `McpAppsServerConfig`，见 `mcp-apps-servers.ts` 的 import）。

---

## 5. 【A11】调度 / 后台任务

**未找到**。全 `packages` 非测试代码里没有 cron / 定时任务 / 常驻 loop：
- `grep 'cron'` 无命中；`setInterval(` 命中全部是 **UI 计时器**：`CopilotChatWorkSummary.tsx:39`（每秒刷新工作时长）、`CopilotChatReasoningMessage.tsx:88`（思考计时）、`packages/mcp-apps-renderer/src/request-queue.ts:298`（请求重试队列）、`status-checker.ts:47`（健康轮询）。
- 没有"任务怎么定义/谁 tick/失败重试/四态"的后台调度抽象。

> 结论：CopilotKit 是**请求-响应 + 事件流**框架，不做定时/后台任务。我们 A11 别从这抄。

---

## 6. 【C1/C2】agent 循环与停止条件

- **主循环不在本仓**：在外部 `@ag-ui/client`（`packages/core/package.json`: `@ag-ui/client: 1.0.4`）。本仓 `packages/core/src/core/run-handler.ts`（2105 行）是**前端侧 run 生命周期编排**：订阅 agent 事件、转发前端工具结果、处理 interrupt、stop/abort。
- 一轮的定义=AG-UI 事件：`RUN_STARTED → (TEXT_MESSAGE_CONTENT | TOOL_CALL_* | THINKING) → RUN_FINISHED | RUN_ERROR`，SSE 编码见 `packages/runtime/src/v2/runtime/handlers/shared/sse-response.ts:76-120`（`EventEncoder`、`terminalEventWritten` 保证只在终结后关流）。
- **停止条件**由 AG-UI/agent 决定；前端侧的"停"是显式中断：`run-handler.ts:339-360` `abortCurrentRun/abortAgentRuns`；UI 里 stop 按钮 `CopilotChatInput.tsx:521-545`（`isProcessing && canStop` 时渲染 Square 停止）。
- 循环状态持久化：thread 级（`packages/core/src/threads.ts`，1596 行；前端 `use-threads.tsx` 467 行）——可断线重连（`packages/core/src/utils/connect-replay.ts`）。**重启后续跑**由后端 agent 负责，前端只重放 thread。

> 结论：C1/C2 主体在 `@ag-ui/client`，本仓只做"前端如何跟着循环改 UI 状态"。判"部分"。

---

## 7. 【A6/A7】记忆

Storage/recall 都在 `packages/core/src/memory.ts`（1593 行），形态是**服务端权威 + 前端镜像**，不是本地文件：

- 类型：`MemoryKind = "topical" | "episodic" | "operational"`、`MemoryScope = "user" | "project"`（`memory.ts:76-79`），`Memory`/`NewMemory`/`MemoryChanges`（`memory.ts:103-131`）。
- 接口：`recall(query,{limit,scope})` 走 `POST {runtimeUrl}/memories/recall`（hybrid RAG，带 `score`）；`addMemory/updateMemory/removeMemory`（**update=supersede，id 会变；remove=非丢失性退休**）。证据：`memory.ts:561-599`。
- 实时态：`MemoryRealtimeStatus = "connecting"|"connected"|"unavailable"`（`memory.ts:97`），通过 thread store 的 socket（`memory.ts:555-558` 注释"only a fetch implementation is required"）。
- **溯源/冲突消解/TTL**：`MemoryKind` 分了三类，但**未找到** TTL/老化/显式冲突消解；update 用 supersede（id 更换）承接"改"（`memory.ts:583-587`）。
- 跨会话召回：靠 `scope: user|project` + `recall` 的 RAG（`memory.ts:578-581`）。
- React 消费：`packages/react-core/src/v2/hooks/use-memories.tsx`（181 行）。

> 对我们 D1"记忆元画布"：`MemoryKind×MemoryScope` + `recall`/`supersede` 这个**数据模型**可直接借；但没有可视化画布（我们得自己做）。

---

## 8. 【D1–D5】界面（重点，最长）

### 8.1 技术栈
React 19 + TypeScript；样式 Tailwind（`cpk:` 前缀，见 `CopilotChatWorkSummary.tsx:78-81` 的 `twMerge`），无 CSS-in-JS；虚拟滚动 `@tanstack/react-virtual`（`packages/react-core/package.json`）；Markdown 流式渲染 `streamdown`（`CopilotChatAssistantMessage.tsx:5,661-683`）；滚动钉底 `use-stick-to-bottom`（`CopilotChatView.tsx:26-30`）；图标 `lucide-react`；基础控件 Radix（dropdown/popover/tooltip/slot，`package.json`）。

### 8.2 布局范式
纯"聊天列"，没有画布/时间线：
- 三种外壳都只是同一个 `CopilotChatView` 的容器：`CopilotSidebar.tsx`（侧边栏，可开合/受控 `open`）、`CopilotPopup.tsx`（浮窗）、`CopilotChat.tsx`（内联）。
- `CopilotChatView` 里是 **ScrollView（消息区）+ Input（输入区）+ SuggestionView** 的纵向三段，用 Slots 可换：`CopilotChatView.tsx:58-67`。
- 多会话靠 **ThreadsDrawer 抽屉**切换（`CopilotThreadsDrawer.tsx` 646 行），不是多工作区并排。
- 判定：**部分**（有侧栏/浮窗/抽屉，无可拖拽分栏、无画布、无多工作区）。对比我们 `WorkbenchScene.tsx` 的三视图+右侧对话，CopilotKit 只提供"右侧对话"这一块。

### 8.3 状态可见性：agent「正在做什么 / 花了多少 / 还差什么」（我们 D3 的痛）★

这是 CopilotKit 最值得抄的地方。它把一次回复的"工作过程"做成了**一条可折叠摘要 + 一排按状态渲染的工具行**，三层信息各有归属：

**(a) 一行总账 `CopilotChatWorkSummary`** — `CopilotChatWorkSummary.tsx`
- 运行中：`Working 4s`（`cpk-shimmer` 微光），`useNow` 每秒 tick（`:34-43`），`liveMs = elapsedMs + (now-workingSince)`（`:61-64`）。
- 完成后：`Worked for 9s · 7 tools`，另有 `N failed`（失败数，`:105-107`；主体 `:94-108`）。
- 折叠箭头，点开显示全部工作（`:110-116`）。
- **注意**：这就是"花了多少"的答案——**只有时长和工具数，没有 token/成本**。全仓搜索确认：`TokenUsage`/`aggregateTokenUsage` 只在 `external-reexports.ts:243,414`（从 `@ag-ui` 转出）和 `web-inspector` 的**线程配额**（`web-inspector/src/home-briefing.ts:233-250`），**聊天 UI 不展示 token/费用**。→ 我们做 D3 要**补这一块**。

**(b) 时长是怎么算的（关键：只算"在跑"的时间）** — `CopilotChatMessageView.tsx:751-775`
- `workTimesRef: Map<turnKey,{elapsedMs, workingSince}>`；`isRunning` 为真且新回合时记 `workingSince=now`（`:763-767`）；变 false 时 `elapsedMs += now-workingSince` 并清空（`:768-773`）。
- 注释点明："summed over its runs so time spent waiting between them (say, for an approval) doesn't count"（`:751-756`）。**中断等待/审批等待不计时**——这正是"还差什么"里最容易被做错的地方（我们把等待也算进去就会虚高）。

**(c) "还差什么"/"正在做什么"：tool-call 的 5 种呈现 + 折叠语义** — `tool-call-layout.ts`
- `CopilotChatToolCallDisplay = "grouped" | "line" | "stacked" | "turn" | "separate"`（`tool-call-layout.ts:20-25`）。
- `"turn"`：agent 干活时**敞开**（narrate + 一排 call），回复结束后**全部折进 "Worked for 9s"**（`tool-call-layout.ts:12-14` 注释；实现 `getTurnWork` `:212-302`）。
- `getTurnWork` 的切分逻辑：找出每个回复"调用过工具的最后一条消息"作为 work 的终点，把此后的 thinking/静默消息也并入 work，**停在第一段有正文的地方**（`:246-268`）——正文是答案，不算"工作"。这一段是"还差什么"的精髓：**已知的工作=折叠区；正文=已完成；正在流的那行=当前**。

**(d) 工具调用卡片本身：四态状态机 + 参数预览** — `CopilotChatToolCallGroup.tsx`
- `CallStatus = "running" | "done" | "failed" | "stopped"`（`:15-16`）；`entryStatus`：有结果→done/failed，无结果→running（active 时）否则 `stopped`（`:34-44`，注释"a call that never got a result after the run ended (Stop, an error) is stopped"）。
- `StatusIcon`：Loader2 旋转 / Check / X / Circle（`:119-140`）。
- `argumentPreview`：取第一个非空**字符串**参数当预览（命令/路径/查询），`partialJSONParse` 允许**流式半截 JSON**（`:54-64`）。
- `ToolCallRow`（可复用卡片）：状态图标 + 工具名（运行中带 shimmer）+ 参数预览 + 点开显示 `ToolCallPayloads`（Arguments/Result 两个 `<pre>`，`:184-216, 223-308`）。
- 组头三种外观：`card`（一张卡，`Used 3 tools` + 逐行）、`line`（一行文字）、`stack`（最新在顶、点开摊开成卡堆，`:448-566`）。

**(e) 思考过程（reasoning）独立成折叠块** — `CopilotChatReasoningMessage.tsx`
- 流式时展开、显示 "Thinking…" + 打字点；结束自动折叠成 `Thought for Ns`（`:74-123`，默认标签 `:123`）。
- 在 `turn` 模式里，agent 工作时**只保留最后一条思考**（前一条被 `supersededReasoning` 隐藏，`CopilotChatMessageView.tsx:796-802`），打开折叠时全部回来。

**(f) INTELLIGENCE 指示条**：brain/face 两段，状态 `"in-progress"|"finished"`，玻璃拟态胶囊 + 图标 arc→check 变形（`IntelligenceIndicatorView.tsx:6, 61-109`）。用于标记"这一回合用了 CopilotKit Intelligence"。

**(g) 输入框的"在跑"态**：`CopilotChatInput.tsx:521-545` 运行中把发送键换成 Stop（Square），且空输入时 Enter 才触发 stop（`:466-473` 注释，避免误停）。

### 8.4 流式与工具调用的渲染顺序怎么保证 ★

这是第二个可抄重点，靠**三条机制**叠加：

1. **消息级去重/合并（解决"同一 id 反复流式覆盖"）** — `CopilotChatMessageView.tsx:360-459`
   - `dedupeToolCalls`：同 id 保留"有参数"的那份（`:360-375`）。
   - `mergeToolCalls`：两次出现按 id 求并集，**保留 first-seen 顺序**，后到的有参数者胜（`:386-402`）。
   - `deduplicateMessages`：assistant 消息 `content` 用"非空回退"（空串=流式清空，不回退成空），toolCalls 合并（`:416-459`）。
2. **布局级分组（跨消息的 call 也能进同一组）** — `getToolCallLayouts`（`tool-call-layout.ts:116-175`）
   - 遍历全部消息，只有"opt-in grouping 的渲染器"画的 call 才进当前 open group；**中间出现 assistant 正文/user/reasoning/其他渲染器的 call 就把组关闭**（`:152-166`）。这样"文本→工具→文本→工具"的顺序被严格保留，不会因为分组打乱。
   - 每个 layout 带 `signature`（`:84-92`）供 memo，流式高频更新时避免无谓重排。
3. **行 key 稳定（解决流式期间行重挂载/滚动跳动）** — `CopilotChatMessageView.tsx:887-938`
   - `rowRenderKeys`（`createRowKeyStore`/`resolveRowRenderKeysById`）让后端中途改 message id 时行不 remount（`:887-916`，注释直指 "the HITL chat flash"）。
   - `rowKeys` 数组保持引用稳定（`:928-938`），喂给虚拟滚动的 `getItemKey`（`:1179-1182`）。

配套：`CopilotChatToolCallsView.tsx:132-188` 按 `segment.kind` 顺序渲染——`call` 段直接渲染，`group` 段按 display 分支（`turn` 用 Collapsible，`:143-174`；其余用 `CopilotChatToolCallGroup`，`:176-185`）。**顺序 = 数据顺序，不重排**。

### 8.5 组件清单（哪个文件干什么）

| 层 | 组件 | 文件 |
|---|---|---|
| 外壳 | 内联聊天 / 侧边栏 / 浮窗 | `CopilotChat.tsx` / `CopilotSidebar.tsx` / `CopilotPopup.tsx`（+各自 `*View.tsx`） |
| 视图骨架 | 消息区+输入区+建议 | `CopilotChatView.tsx`（Slots: `:58-67`） |
| 消息列表 | 行/分组/虚拟化/turn 编排 | `CopilotChatMessageView.tsx`（1822 行，核心） |
| 单条助手消息 | Markdown + 工具区 + 工具条 | `CopilotChatAssistantMessage.tsx`（顺序 `:647-653`） |
| 单条用户消息 | 附件/编辑 | `CopilotChatUserMessage.tsx` |
| 思考块 | "Thought for Ns" | `CopilotChatReasoningMessage.tsx` |
| 工具调用区 | 按 display 渲染 segments | `CopilotChatToolCallsView.tsx` |
| 工具组/卡片 | card/line/stack + 四态行 | `CopilotChatToolCallGroup.tsx`（`ToolCallRow:223-308`） |
| 工作摘要条 | "Working 4s"/"Worked for 9s·7 tools" | `CopilotChatWorkSummary.tsx` |
| 输入框 | 发送/停止/语音/附件 | `CopilotChatInput.tsx`（1302 行） |
| 建议词 | 药丸/列表 | `CopilotChatSuggestionView.tsx` / `SuggestionPill.tsx` |
| 会话抽屉 | 多 thread 切换 | `CopilotThreadsDrawer.tsx` |
| 附件 | 队列/渲染/录音 | `CopilotChatAttachmentQueue.tsx` / `AttachmentRenderer.tsx` / `AudioRecorder.tsx` |
| 工具条动作 | 复制/点赞/朗读/重生成 | `CopilotChatAssistantMessage.tsx:543-560` + `message-feedback.tsx` |
| 生成式 UI | 标准组件（图表/地图/表格/输入） | `react-core/src/v2/generative-ui/standard/{Chart,Map,data,inputs,layout,media}.tsx` |
| 调试 HUD | Inspector 浮层 | `CopilotKitInspector.tsx` + `packages/web-inspector` |
| 平台无关入口 | 只出 hooks/契约，不带 UI | `headless.ts` |

### 8.6 状态同步（前后端）机制
- 前端订阅 agent：`use-agent.tsx:377-429` 把 `onMessagesChanged/onStateChanged/onRunInitialized/...` 包成 **microtask 批量 forceUpdate**（`:388-400`，注释：避免流式时 #3499 的滚动跳动），并支持 `throttleMs`（`:44-49`）。
- 后端：AG-UI 事件经 SSE 下发（`sse-response.ts:76-120`），带 `keep-alive`（`:90-92`）和 `RUN_FINISHED/RUN_ERROR` 终结约束（`:97-100`）。
- 中断/审批：`interrupt-state.ts:1-56` 把 interrupt 决策分 `ignored/waiting/dismiss/expired/resume`，resume 时用 `buildResumeArray` 拼恢复项；`use-human-in-the-loop.tsx:23-58` 用 Promise 挂起"等用户点"。

### 8.7 主题 / 密度 / 多工作区
- 主题：CSS 变量 + `dark` 类/data-theme（`react-ui/src/hooks/use-dark-mode.ts`），v2 用 Tailwind token `cpk:*`（`CopilotChatWorkSummary.tsx:78-81`）。
- 密度：整体紧凑（`text-[13px]`、`py-0.5` 级），信息密度"高但克制的行内化"——把大量过程折叠成一行，是它最可取的设计取向。
- 多工作区：**未找到**（只有多 thread 抽屉）。

---

## 9. ⭐ 最值得抄的 3 条机制

### 机制 1：一行"工作总账"（Working/Worked for）+ 只算在跑时长
```
机制：把一次回复折叠成 "Working 4s" → "Worked for 9s · 7 tools · N failed" 一行，只在 isRunning 时累加时长，中断/审批等待不计。
位置：packages/react-core/src/v2/components/chat/CopilotChatWorkSummary.tsx:25-119（组件+formatDuration+useNow）
      packages/react-core/src/v2/components/chat/CopilotChatMessageView.tsx:751-775（elapsedMs/workingSince 记账）
为什么好：直接命中我们 D3「花了多少/还差什么」——它把"耗时"定义成纯执行时间，避免把人工审批等待算进去导致进度虚高；且有 failed 计数。
我们抄到哪：apps/vouch-web/src/web-ui/src/app/scenes/workbench/ 新建 components/AgentWorkSummary.tsx（进度视图用），
            记账逻辑放进对话/run 的 store（对应我们 useAgent 的 run 状态）。
```

### 机制 2：tool-call 的"分段布局 + turn 折叠"（已知工作折叠、正文=完成、当前行=进行中）
```
机制：getToolCallLayouts 把跨消息的连续工具调用切成 group/单 call 段，文字/用户/思考会切断分组；turn 模式下干活时敞开、结束后折进 "Worked for Ns"。
位置：packages/react-core/src/v2/components/chat/tool-call-layout.ts:116-175（分组）、:212-302（getTurnWork 切工作/正文）
      packages/react-core/src/v2/components/chat/CopilotChatToolCallsView.tsx:132-188（按 segment 顺序渲染）
      packages/react-core/src/v2/components/chat/CopilotChatToolCallGroup.tsx:34-52,223-308（四态行 + 参数预览）
为什么好：它给"正在做什么/还差什么"提供了严格的时间轴语义——不会把工具记录和正文穿插错乱，流式接入也不会乱序；这正是我们进度视图最缺的骨架。
我们抄到哪：apps/vouch-web/src/web-ui/src/app/scenes/workbench/ 的进度视图 + 新建 components/ToolCallCard.tsx（复用其 StatusIcon/四态/argumentPreview 三件套）。
```

### 机制 3：流式去重合并 + 稳定 row key（保证流式与工具调用渲染顺序/不闪烁）
```
机制：dedupeToolCalls/mergeToolCalls 按 id 取并集、保留先见顺序、后到有参数者胜；deduplicateMessages 空串回退；rowRenderKeys 让后端改 id 时不 remount。
位置：packages/react-core/src/v2/components/chat/CopilotChatMessageView.tsx:360-459（去重/合并）、:887-938（稳定行 key）
      packages/react-core/src/v2/components/chat/tool-call-layout.ts:84-92（signature 供 memo）
为什么好：流式场景下后端会重复发同一 message/同一 toolCall 的增量，不做这层就会重复渲染/参数闪断/行重挂载（它注释里点名的 "HITL chat flash"）。
我们抄到哪：apps/vouch-web/src/web-ui/src/app/scenes/workbench/ 的 message-store 层（若已有 reducer，补一个 dedupe/merge + 稳定 key 选择器）。
```

（**加抄一条可选**：`lib/slots.tsx:12-131` 的 Slots 机制——我们三视图要外部化定制 UI 时，用"组件/className/props 三态槽 + 统一 renderSlot"可省掉一堆 props 透传。）

---

## 10. 我们不该抄的

1. **别把 CopilotKit 当插件系统抄**：它的"plugin"只是 `.claude-plugin` 的 skill 分发（静态 manifest），运行期没有发现/装载/热插拔（第 3 段）。A12 想要插件生态，去看 openclaude/dify，不要在这浪费时间。
2. **不要抄它的巨文件组织**：`CopilotChatMessageView.tsx` 1822 行、`CopilotChatInput.tsx` 1302 行、`core/run-handler.ts` 2105 行、`memory.ts` 1593 行、`threads.ts` 1596 行——单文件体量已失控（B4）。我们抄"机制"要拆成小文件，别照搬单文件。
3. **不要抄"没有 token/成本"的缺口**：它的 WorkSummary 只给时长+工具数，没有 token/费用（8.3）；我们 D3 若直接照搬，仍然回答不了"花了多少"。要在这层之上补 token/成本。
4. **不要抄虚拟滚动的重度定制**：`CopilotChatMessageView.tsx:1049-1441` 那一大段 resize anchor / measured size / 双 observer 补偿，是为"聊天流式高度抖动"特调的，体量极大且很难维护；我们进度视图若不追求数千行虚拟滚动，别引入。
5. **不要抄 v1-deprecated / react-ui 旧组件**：`packages/react-core/src/v1-deprecated/`、`packages/react-ui/src/components/chat/` 是历史包袱，v2 才是主线（`react-core/src/v2/index.ts` 顶部注释与 `index.ts:25-27` 的 v1 兼容 re-export）。直接读 v2。
6. **不要抄它的运行时/后端**：`packages/runtime` 是 AG-UI 多框架适配器 + GraphQL，跟我们形态不匹配，A11 调度、C1 循环都不用看它。

---

### 附：本次未找到（诚实清单）
- 运行时插件发现/装载/热插拔：未找到（只有 `.claude-plugin` 静态 skill manifest）。
- MCP server 管理 UI（增删改/启停）：未找到。
- 定时/后台任务调度：未找到（所有 setInterval 均为 UI 计时/重试）。
- token/成本在聊天面展示：未找到（仅协议类型与 Inspector 线程配额）。
- 多工作区并排面板：未找到（仅多 thread 抽屉）。
