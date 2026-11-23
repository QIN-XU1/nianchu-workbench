# OpenBitFun 拆解

> 只读源码分析，未修改上游任何文件。
> 上游：`D:\refs\bitfun2\OpenBitFun-main`（v1.0.10）
> 我方 fork：`D:\file\AI Temp\DeepSeek\Agent自研\apps\bitfun-web`
> 分析时间：2026-11-15

---

## 一句话定位

**OpenBitFun 是一个「Rust 单一 Agent Runtime + 多宿主（Desktop/CLI/Server/Mobile/ACP/SDK）+ 可发布设计系统」的 Agent 工作台**。它不是"Electron 套壳聊天工具"，而是把 Agent 循环、工具执行、会话持久化全部收进 Rust crate 层，前端只做投影（projection）与呈现；UI 侧则把设计系统抽成三个可独立发包的 workspace 包，并用可执行审计脚本把"颜色/字体/动效/DOM 契约"钉死在 CI 里。

它的核心取舍是一句话：**为了让「同一份 Agent 行为」能同时跑在桌面、终端、服务器和别人的 IDE 里，付出了极大的分层成本**。

---

## 实测数据

以下均为本次实测计数（非文档引用）。

| 指标 | 数值 | 口径 |
|---|---|---|
| 上游 git 跟踪文件 | **13,520** | `rg --files`（尊重 .gitignore） |
| 上游磁盘全量文件 | **55,066** / 919.5 MB | 含 node_modules / dist / target |
| Rust 源文件 | **2,131** | `src/**/*.rs` |
| Rust 代码行 | **~1,087,616** | 非空行含注释 |
| 前端 web-ui 源文件 | **2,809** | ts/tsx/scss，排除 `*.test.*` |
| 前端 web-ui 代码行 | **~462,823** | 同上 |
| 前端 tsx（非测试） | **659** | |
| 前端 ts（非测试） | **1,813** | |
| 前端 scss | **337** | |
| Rust crate（Cargo members） | **54** | `Cargo.toml` members |
| pnpm workspace 条目 | **12**（含 4 条 glob） | `pnpm-workspace.yaml` |
| 场景（Scene Tab） | **16** | `scenes/registry.ts` |
| 设置页 | **20** | `settingsRegistry.ts` 的 `id:` |
| 全局 settings/nav 分区 | 6 大类（ai/application/data/development/tools/workspace） | 目录 + id 前缀 |
| 内置 Agent 工具 | **61** | `tool-provider-groups` 规范测试列表 |
| 工具 Provider 组 | **11** | `core.basic` … `core.creation` |
| 工具能力特性组（Cargo feature） | **12** | `ToolPackFeatureGroup` |
| Tauri 命令（desktop 注册） | **334** | `lib.rs` `generate_handler!` 块实测 |
| 文档口径 Tauri 命令总数 | 705 | `docs/interactive-capabilities/README.md`（跨全部宿主） |
| Agent 事件（`agentic://`） | **39** | 前端源码去重 |
| Zustand store 文件 | **60** | `from 'zustand'` 的文件（含 hooks） |
| Zustand `create` 调用 | **65** | |
| 设计系统公开组件 | **48 个目录** / registry **127 项** | `ui/src/components` + `registry.ts` meta 引用 |
| design token 组 | **15** 顶层组 | `system.tokens.json` |
| `layout.*` token | **~100** 个 | 实测导出值见下文 |
| Appearance DOM 契约 | component **261** 种 / part **1,076** 种 | `data-openbitfun-*` 去重 |
| Appearance 描述符注册 | 543 行 registry，40+ descriptor 导入 | `defaultAppearanceRegistry.ts` |
| 前端测试文件 | **1,277** | `*.test.ts(x)` |
| Rust 测试 | **10,478** | `#[test]` / `#[tokio::test]` |
| E2E 规格 | **63** | `tests/e2e/**/*.spec.ts` |
| UI 包契约测试 | **62** | `design-system/packages/ui/tests` |
| Ability 目录条目 | **44**（22 feature + 22 setting）/ 329 子能力 | `capabilities.json` |
| 我方 fork 跟踪文件 | **5,765** | 仅保留 web-ui + design-system + transport |
| 我方 fork 场景 | **21**（16 原 + 5 自有：vouch-verify/overview/memory/net/benchmark） | fork `registry.ts` |

> 说明：仓库文档称 10526 文件 / 188MB 是**该项目某一历史快照**口径；本地副本含 `node_modules`、`dist`、`target`、`third_party` 后为 55,066 / 919.5 MB。git 跟踪口径为 **13,520**。

---

## 底层架构

### 进程模型

**结论：Tauri v2 单进程宿主 + Rust 内多 crate 分层 + 独立受监督子进程（Plugin Host / ACP agent / PTY）。前端不持有业务真相，只是 Rust Runtime 的投影视图。**

- Tauri v2 依赖与桌面宿主 [证据: `Cargo.toml:tauri = { version = "2.11" }`、`src/apps/desktop/Cargo.toml:29`]
- 桌面宿主是唯一的"装配点"，自己几乎不实现业务，只做 `openbitfun-core` 的 `product-full` feature 装配 [证据: `src/apps/desktop/Cargo.toml:22` `openbitfun-core = { ..., features = ["product-full"] }`]
- 宿主入口 `lib.rs` 有 132 KB，主要工作是初始化 7 个串行服务再建窗口（这也是它自己承认的冷启动瓶颈）[证据: `src/apps/desktop/src/lib.rs` 132,202 bytes；`docs/performance/04-startup-and-bundle-size.md:33-40`]
- 至少 8 个宿主共用同一 Runtime：desktop / cli / server / sdk-host / miniapp-shell / data-tools / relay-server / miniapp-market-server [证据: `Cargo.toml:2-9`]
- 第三方代码不跑在 Rust 进程内：Plugin Host 是**独立受监督 Bun 子进程** [证据: `docs/architecture/extensions/plugin-runtime-design.md:19`]
- ACP 外部 Agent 是 npx/CLI 子进程，由 `AcpClientService` 拉起 [证据: `src/crates/interfaces/acp/src/client/builtin_clients.rs:3-11,42-100`]
- 终端是真实 PTY 子进程，有独立进程树回收 [证据: `src/crates/services/terminal`、`Cargo.toml:portable-pty = "0.8"`]

### 包划分

**Node/pnpm 侧（12 条 workspace 条目）** [证据: `pnpm-workspace.yaml:1-12`]

| 包 | 职责 | 证据 |
|---|---|---|
| `src/web-ui` (`@openbitfun/web-ui`) | 桌面 + Web 共用前端，唯一的完整产品 UI | `src/web-ui/package.json:2` |
| `design-system` 根 | 独立可构建可发布的边界 | `design-system/README.md:3` |
| `design-system/packages/design-tokens` | 主题无关命名 + 系统尺度 | `design-system/AGENTS.md:11` |
| `design-system/packages/theme-openbitfun` | 可替换的 light/dark/HC 语义值 | 同上:11 |
| `design-system/packages/ui` | 无主题 React 原语 | 同上:10 |
| `design-system/tooling/{token-engine,vite,package-contract}` | 私有构建期工具 | `design-system/README.md:9` |
| `design-system/apps/design-lab` | 私有 authoring/预览应用 | `design-system/README.md:10` |
| `packages/flow-chat-presentation` | 聊天呈现层（terminal/exec/thinking/scroll），无 store | `packages/flow-chat-presentation/package.json` |
| `src/mobile-web` | 手机端远程控制前端 | `package.json` scripts |
| `src/miniapp-market-web` | MiniApp 市场前端 | 同上 |
| `OpenBitFun-Installer` | 安装器（独立 Tauri app） | 同上 |
| `website` / `tests/e2e` / `sdk/typescript` | 官网 / E2E / TS SDK | `pnpm-workspace.yaml` |

**Rust 侧（54 crate，6 层）** [证据: `AGENTS.md:15-22` 的层表 + `Cargo.toml:2-56` 实测]

```
L1 interfaces/apps   src/apps/*(8) + src/crates/interfaces(5)
L2 assembly          assembly/core, agent-content, external-sources, product-capabilities
L3 adapters          ai-adapters, opencode/dsh/pi/claude-code/codex/cursor/zcode-adapter,
                     agent-runtime-ipc, miniapp-ipc, transport, webdriver, static-hook-support
L4 services          services-core, computer-use, integrations, relay-service, terminal,
                     miniapp-market, page-function-runtime, legacy-migration(-adapters)
L5 execution         agent-runtime, agent-workflows, agent-stream, tool-contracts,
                     tool-execution, tool-provider-groups, plugin-runtime-client,
                     runtime-services, office-documents
L6 contracts         core-types, config-contracts, events, runtime-ports, product-domains
```

依赖规则是显式的：`Dependencies point downward: a crate may depend on lower layers, not on higher ones` [证据: `AGENTS.md:11`]。并用 `scripts/check-core-boundaries.mjs` 强制执行（95 KB 的依赖边界检查器 + 227 KB 自测）[证据: `scripts/core-boundaries/cargo-dependency-boundaries.mjs` 95,282 B；`self-test.mjs` 227,727 B]。

### `design-system/` 的三层为什么这么分

**结论：这三层对应三个不同的"变化频率 × 复用范围"，拆开的目的是让主题可换而组件不动、让组件可发版而不携带产品语义。**

```
token-engine → design-tokens → theme-openbitfun
design-tokens ─────────────→ ui
design-tokens + theme-openbitfun + ui → design-lab
```
[证据: `design-system/README.md:117-122`（原文的 Dependency direction 代码块）]

- **design-tokens = 命名与尺度（不含具体值）**：`system.tokens.json` 里全是 `{space.1}` 这种引用和 `220ms` 这种与品牌无关的尺度 [证据: `design-system/packages/design-tokens/src/system.tokens.json`]。README 明确 "token contract, system scales, density modes" [证据: `design-system/README.md:8`]
- **theme-openbitfun = 可替换的具体值**：`light.tokens.json`(20 KB) / `dark.tokens.json`(20 KB) / `high-contrast-light`(5.9 KB) / `high-contrast-dark`(5.8 KB) / `reference.tokens.json`(7.8 KB) 五份 [证据: 目录实测]。双层色彩模型：`ref.color.neutral.50` 这类基础色**不产出运行时 CSS 变量**，只作为 authoring 数据；语义色才映射到 UI 角色 [证据: `design-system/README.md:12`]
- **ui = 无主题的原语**：`@openbitfun/ui never depends on a concrete theme` [证据: `design-system/README.md:122`]。它的 `dependencies` 只有 `design-tokens` + `lucide-react`，React 是 peer [证据: `design-system/packages/ui/package.json`]

这个分法的实际收益是可验证的：`design-system/AGENTS.md` 强制 "Raw colors are forbidden in public component CSS" [证据: `design-system/AGENTS.md:12`]，并由 `scripts/audit-frontend-colors.mjs` 按 11 个 surface 分别审计 [证据: `package.json` 的 `theme:color-audit:*` 脚本族]。

### 通信

**结论：UI 从不直接调 Tauri。一条 `ApiClient → ITransportAdapter → (Tauri | WebSocket | PeerDevice)` 的三实现适配链，是前端唯一出口。**

- 统一出口 `api.invoke(command, args)` [证据: `src/web-ui/src/infrastructure/api/service-api/ApiClient.ts:697-701`]
- 适配器三实现：`TauriTransportAdapter` / `WebSocketTransportAdapter` / `PeerDeviceTransportAdapter` [证据: `src/web-ui/src/infrastructure/api/adapters/index.ts:4-6`]
- 环境探测后选实现 [证据: `.../adapters/index.ts:30-39`]：Tauri 运行时走 IPC，浏览器走 `ws://…/ws`
- 强制规则："UI components do not call Tauri APIs directly; go through the adapter/infrastructure layer" [证据: `AGENTS.md:47`、`src/web-ui/AGENTS.md:33`]
- 命令命名铁律：`snake_case` + **单个结构化 request** [证据: `AGENTS.md:56-66`]。实测 334 个命令全部注册在一个 719 行的 `generate_handler!` 块里 [证据: `src/apps/desktop/src/lib.rs:1327-2045`]
- 事件回传是 `agentic://` 命名空间，共 **39** 个（`session-created`/`text-chunk`/`tool-event`/`model-round-started`/`dialog-turn-*`/`context-compression-*`/`acp-plan-updated` 等）[证据: 前端源码 `agentic://` 去重实测；监听器见 `src/web-ui/src/flow_chat/services/AgenticEventListener.ts:35-41`]
- 额外一层"表面（surface）守卫"：设备切换时 `SurfaceChangedError` 会中止旧请求，防止旧请求打到新绑定的 adapter 上 [证据: `ApiClient.ts:298-316`、`adapters/index.ts:41-118`]

### 状态真相

**结论：真相在 Rust。前端 Zustand 是"投影缓存"，且被刻意拆成 60 个 store 以防止单点巨型状态——但事实上最大的那个 store 已经失控（见缺点）。**

层级关系（从权威到呈现）：

| 层 | 位置 | 权威性 |
|---|---|---|
| Runtime session 状态 | `agent-runtime` 的 `session.rs` / `runtime.rs` | **唯一真相** |
| 事件日志 | `session_event_journal.rs` (45 KB) | 追加式权威记录 |
| 传输投影 | `SessionRecordReplica.ts` (2.6 KB)、`SessionStream.ts` (12 KB) | 传输层一致性 |
| 前端会话状态 | `FlowChatStore.ts` (**374.9 KB / 9,703 行**) | 投影，非权威 |
| 场景/标签状态 | `sceneStore.ts` (771 行) | 导航真相 |
| UI 局部状态 | 其余 ~58 个 store | 纯 UI |

关键设计（正面）：
- 投影契约被写成文档："What a client shows for a Session is a **projection of an ordered stream**" [证据: `docs/architecture/session-projection.md:3`]
- `SessionStream` 同时拥有"读栅栏（read fence）"和"读是否在飞"，一次读只结束一次 [证据: `docs/architecture/session-projection.md:31-33`]
- 跨设备切换时旧句柄不得影响新读 [证据: 同上:31-37]
- 场景 store 把"导航事务"做成单个原子的 `navigateWorkbench()`，先计划两个 pane 再守卫 drafts，每个异步边界后重校验 [证据: `src/web-ui/src/app/stores/sceneStore.ts:580-649`]

### 依赖方向

**结论：Rust 侧是硬约束（CI 强制），设计系统侧是硬约束（构建产物隔离 + 审计脚本），但**产品前端内部与 Rust 之间仍是单向口头约定，没有自动化守卫**。这是我实测发现的唯一真实反向依赖风险点。

- Rust 六层单向：有 `check:core-boundaries` 强制 [证据: `AGENTS.md:11`、`package.json` 脚本]
- 设计系统禁止反向依赖：`Shared design system packages must not depend back on Web UI Appearance` [证据: `docs/architecture/theme-token-optimization.md:27`（原文："这里没有 compatibility projection。共享设计系统包不能反向依赖 Web UI Appearance"）]
- 实测验证：`design-system/packages/**` 中 `from '@/` 导入 **0 处**、`@tauri-apps` 导入 **0 处** — 干净 [证据: 本次 rg 实测]
- 唯一越界：web-ui 的**测试文件**直接 import 设计系统源码与 dist 内部路径 [证据: `src/web-ui/src/infrastructure/visual-skin/sidebar-surfaces.test.tsx:14-16`、`materials.test.ts:114,124`、`app/styles/scrollbarFocus.test.ts:3`]。这是测试专用，可接受但破坏了"只消费 package exports"的字面规则。
- 前端内部依赖方向**无机器守卫**：`flow_chat` 反向 import `@/app/stores/sceneStore` 的场景在 `sessionSceneLifecycle.ts` 里被规避（用 `registerSessionSceneNavigation` 注入），说明作者知道风险，但靠人工 [证据: `src/web-ui/src/app/services/sessionSceneLifecycle.ts:7,28-71`]

---

## 执行逻辑

### 任务链路

**一次对话的完整链路（本地 session）：**

```
ChatInput.tsx (301 KB)
  → useMessageSender
  → FlowChatManager.sendMessage()                      [FlowChatManager.ts:841-864]
  → MessageModule.sendMessage()                        [MessageModule.ts:365]
  → driverForSession(session).planSubmission()          [session-drivers/types.ts:284-288]
      ├─ 忙 → 'queue'（PendingQueueModule 排队）或 'steer'（注入当前 run）
      └─ 闲 → 'start'
  → driver.startTurn()                                  [session-drivers/types.ts:303-307]
      ├─ 同步插入乐观 turn（本地投影）
      └─ agentAPI.startDialogTurn()                     [AgentAPI.ts:865-869]
  → Tauri IPC: 'start_dialog_turn'                      [desktop/lib.rs 注册块]
  → agent_runtime.cancel/start → Runtime 主循环          [agent-runtime/runtime.rs 154 KB]
  → 模型流式回复 + 工具执行
  → 回写 39 个 agentic:// 事件
  → AgenticEventListener → EventHandlerModule (121 KB)  [flow-chat-manager/EventHandlerModule.ts]
  → FlowChatStore（投影合并）
  → SessionStateMachine（IDLE/PROCESSING/FINISHING/ERROR）[state-machine/transitions.ts:19-63]
  → VirtualMessageList / tool-cards 渲染
```

关键点：
1. **乐观 turn 先行**：驱动被要求"在异步工作之前先把用户消息显示出来" — `ensureReady` 可以同步返回，就是为了不引入 microtask 边界 [证据: `session-drivers/types.ts:267-273`]
2. **会话驱动是一个显式的策略接缝**：`SessionDriver` 接口有 20+ 成员，把"本地 / dispatch / ACP"三种传输族的差异全部封在驱动里，共享编排只调用不分支。作者注释写得很直白："New chat features land for every flavor by adding one driver member instead of branching in eight files" [证据: `session-drivers/types.ts:1-14`]
3. **提交计划是三态而非布尔**：`queue | steer | reject`，且明确要求"must test steer-eligibility before falling back to queue" [证据: `session-drivers/types.ts:85-93,278-288`]

### 工具注册

**结论：61 个内置工具，编译期按 12 个 feature group 打包，运行时按 11 个 provider group 装配；工具注册表在 Rust，前端只负责渲染。**

- 工具名与归属映射：`tool_feature_group()` 一个大 match [证据: `src/crates/execution/tool-provider-groups/src/lib.rs:102-132`]
- 11 个 provider 组及工具数：`core.basic`(16) / `core.agent`(15) / `core.session`(7) / `core.git`(3) / `core.web`(3) / `core.mcp`(4) / `core.computer-use`(1) / `core.review`(2) / `core.miniapp`(6) / `core.pages`(3) / `core.creation`(1) = **61** [证据: `lib.rs:183-294`]
- 编译期特性开关：12 个 `cfg!(feature = "...")`，决定该工具是否进入这个二进制 [证据: `lib.rs:64-100`]
- 注册表实现：`ToolRegistry<Tool>` 用 `IndexMap<String, ToolRef<Tool>>` 保序，`register_tool` 递增 `snapshot_generation` [证据: `src/crates/execution/tool-contracts/src/framework.rs:1444-1510`]
- 静态 provider 批量安装：`install_static_provider()` [证据: `framework.rs:1512-1520`]
- 延迟工具目录：`CallDeferredTool` + `GetToolSpec` 让模型按需发现工具，而不是把所有 schema 塞进 system prompt [证据: `lib.rs:222-224`；`tool-contracts/src/deferred_tool.rs`]
- 前端工具卡渲染器约 **100 个文件**，按工具族一一对应（`FileOperationToolCard` 25 KB、`CodeReviewToolCard` 39 KB、`MCPToolDisplay` 34 KB、`AskUserQuestionCard` 28 KB……）[证据: `src/web-ui/src/flow_chat/tool-cards/` 目录实测]
- 设计系统里还有一套**与产品无关**的 tool card 框架：`AmbientToolCard` / `ProminentToolCard`，明确按"结果该留在对话背景还是该吸引注意"来命名 [证据: `design-system/README.md:47-51`]

### ACP 集成

**结论：ACP 是双向的——OpenBitFun 既是 ACP Client（托管别人的 agent），也是 ACP Server（把自己变成别人的 agent）。**

- 同一 crate 两个 feature，默认都开 [证据: `src/crates/interfaces/acp/Cargo.toml:7-8` `default = ["client", "server"]`]
- 导出两个门面：`AcpClientService` / `AcpServer` + `OpenBitFunAcpRuntime` [证据: `src/crates/interfaces/acp/src/lib.rs:18-23`]
- Client 侧核心是 `AcpClientService`（manager.rs **108 KB**），公开 API 覆盖：创建会话记录、探测需求、安装 CLI、启动/停止 client、提交权限响应、读写 session options、设模型、设 config、prompt（含 stream）、cancel [证据: `src/crates/interfaces/acp/src/client/manager.rs:224-1384`]
- 内置预设 6 家：`opencode`(`opencode acp`)、`dsh`(`dsh --profile openbitfun-acp`)、`omp`(`omp acp`)、`claude-code`(npx 适配器)、`codex`(npx 适配器)、以及 adapter 机制 [证据: `builtin_clients.rs:42-100`]
- dsh 的特殊处理值得注意：**DSH 本身没有 ACP 入口，于是 OpenBitFun 自己发了一个 dsh profile（`packages/dsh-acp`）**，再通过用户自己的 dsh 安装来启动；模型与 API key 留在 dsh 里，OpenBitFun 两边都不存 [证据: `builtin_clients.rs:60-73`；`packages/dsh-acp/` 含 `bridge.ts` 52 KB]
- 传输健壮性：ACP 0.12 在输入 EOF 后会继续等其它 channel sender，OpenBitFun 注入了一个**只在内存队列里的私有通知 `_openbitfun/client_transport_closed`** 来让终止可观测，同时不丢弃已读帧 [证据: `src/crates/interfaces/acp/src/client/transport.rs:8-22`]
- 工具卡桥接：ACP 的 tool call 要被映射成 OpenBitFun 的卡片，有 `tool_card_bridge/{mod,tool_name,tool_params,tool_result}.rs` 四件套 [证据: 目录实测]
- **反面证据（重要）**：`docs/architecture/extensions/plugin-runtime-design.md` 明确写了"本文同时区分目标设计和当前实现；目标不能被写成已经交付的能力" [证据: 该文件:11]，且 "当前本地生产路径可执行配置中显式声明的第三方 OpenCode package plugin … 其余兼容项仍按能力矩阵标记为未实现" [证据: 该文件:29-32]。也就是说 OpenCode 生态兼容是**部分实现**，不是完整运行时。

### 会话生命周期（scene tab 与 session 的关系）

**结论：这是全项目设计最精巧、也最容易出错的一块。规则是：一个 session 一个 tab，tab 引用"某设备上的某 workspace 的某 session"，tab 与 session 是引用关系而非所属关系。**

- 文件头把规则写死了 [证据: `src/web-ui/src/app/stores/sceneStore.ts:1-22`]：
  - 显式打开的 scene 一直存在直到用户关闭
  - pinned tab 排在前面；`closable` 是独立的场景能力
  - **应用启动时零 tab**，无 tab 时由 `SceneViewport` 渲染 WelcomeScene，而不是造一个假 tab
  - `closeScene` 会清掉该 tab 的所有历史条目，所以 forward 永远不会指向已关闭 tab
- session tab 上限 **12**，超出按 LRU 关掉空闲的，但绝不关 `keep` 或正在显示的 [证据: `sceneStore.ts:99-111`]
- 跨设备：另一个设备的 session tab 会保留，激活它等于"渲染那台设备" [证据: `sceneStore.ts:1-14`；`sessionSceneLifecycle.ts:44-51`]
- 生命周期由 `startSessionSceneLifecycle()` 统一编排：订阅 flowChatStore + sceneStore + workspaceManager + deviceOpenIntent，任一变化触发 `reconcile()` [证据: `sessionSceneLifecycle.ts:19-155`]
- 关闭语义细分：miniapp 走 `requestMiniAppClose`、content 走 `requestContentClose`、settings 走 `requestAllSettingsDraftsExit`（有未保存草稿时会先弹确认并把 tab 拉回来）[证据: `sceneStore.ts:467-488`]
- 幂等合并：重复的 UI 信号（pointerdown + focus 同一目标）用 `coalesceKey` 合并成一个 Promise [证据: `sceneStore.ts:588-594`]

### 中断取消

**结论：取消分三级——「取消（cancel）」「可恢复中断（interrupt）」「转向（steer）」，且取消不会立刻回 IDLE，而是先进 FINISHING 等后端确认旧执行已结算。**

- Rust 侧：`DialogTurnCancellationTokenStore` 用 `DashMap<String, CancellationToken>` 按 turn id 管理 [证据: `src/crates/execution/agent-runtime/src/turn_cancellation.rs:7-52`]
- 命令层三个入口：`cancel_dialog_turn` / `interrupt_dialog_turn` / `steer_dialog_turn` [证据: `src/apps/desktop/src/api/agentic_api.rs:3247,3299,3388`]
- `cancel_dialog_turn` 先试 ACP 路径再走本地 Runtime，并带 `cancel_descendants: true` [证据: `agentic_api.rs:3252-3282`]
- `interrupt_dialog_turn` 的语义被显式定义为"只在旧执行已结算、`dialog-turn-interrupted` 事件安全可处理后才返回" [证据: `agentic_api.rs:3295-3299`]
- **状态机关键决策**：`USER_CANCEL` 从 `PROCESSING` 进 `FINISHING` 而非 `IDLE`，注释写明原因——"so queued input cannot race tail writes" [证据: `src/web-ui/src/flow_chat/state-machine/transitions.ts:16-17,24-26`]
- `USER_CANCEL_FAILED` 会退回 `PROCESSING`，即取消失败不会误判为空闲 [证据: 同上:45]
- 前端还有 `TurnTracker` 记录 `hostSubmitStarted`，因为"host 可能在 client 看到 ACK 之前就接受了 turn"，此时 surface 切换导致的中止不能把消息重新排队 [证据: `session-drivers/types.ts:115-130`]

### 上下文管理

**结论：上下文管理是"请求形状工程"而不是简单的截断——它把 prompt 装配顺序视为缓存契约，并用压缩预取（compression prefetch）在压力到达上限前 10k token 就开始准备。**

- 模型可见请求的固定顺序（这是**契约**）：system prompt → tool definitions → collapsed tool listing → skill listing → agent listing → user context → conversation history [证据: `docs/architecture/cache-friendly-message-structure.md:17-27`]
- 两个细节被特别点出：tool definitions 是 provider payload 不是 chat message；中间四段是"前置提醒"注入在第一条非 system 消息之前 [证据: 同上:29-34]
- 实现位置：请求装配 `assembly/core/src/agentic/execution/execution_engine.rs`；前置提醒排序 `agent-runtime/src/prompt.rs`；工具清单解析 `agentic/tools/manifest_resolver.rs` [证据: 同上:38-44]
- 压缩预取：`PREFETCH_LEAD_TOKENS = 10_000`，当 pressure 进入 `[limit-10k, limit)` 窗口就启动后台压缩，避免到达上限时同步阻塞 [证据: `src/crates/execution/agent-runtime/src/compression_prefetch.rs:9-17`]
- 压缩完成点是线性化点：claim 前观察到的失败丢弃，claim 后返回给调用方 [证据: 同上:1-3]
- 三级事件：`agentic://context-compression-{started,completed,failed}` [证据: 前端事件实测]
- 手动压缩入口：`compact_session` 命令 + `FlowChatManager.compactSession()`，本地 session 直接调 runtime，dispatch session 在目标机排队 [证据: `agentic_api.rs:2706`；`FlowChatManager.ts:874-880`]
- 上下文用量可视化：`SessionContextUsage`、`ContextCompressionDisplay.tsx`、`contextLoadClassification.ts` [证据: 文件实测]

---

## 功能选取

### 有的能力（按目录）

| 能力 | 目录 | 规模/证据 |
|---|---|---|
| Agent 运行时 | `src/crates/execution/agent-runtime` | 416 KB `runtime.rs`；46 个源文件 |
| 工具执行（文件/搜索/命令/PTY） | `src/crates/execution/tool-execution` | `grep_search.rs` **107.8 KB**、`exec_command.rs` 53 KB、`read_file.rs` 40 KB |
| 工具契约与框架 | `src/crates/execution/tool-contracts` | `framework.rs` 98 KB、`computer_use.rs` **103 KB**、`ptc.rs` 48 KB |
| 终端 | `src/crates/services/terminal` + `services/terminal` | portable-pty + vte，前端 xterm 6.1 beta |
| Git 集成 | `src/apps/desktop/src/api/git_api.rs` 66 KB | 工作副本/提交/branch/worktree |
| 代码编辑器 | `src/web-ui/src/tools/editor` | Monaco 0.52；`CodeEditor.tsx` 84.7 KB |
| Computer Use | `services/computer-use` + `tool-contracts/computer_use*.rs` | 合计 ~250 KB；含 element_token 29 KB、geometry 15 KB、permissions 3.6 KB |
| MCP | `services-integrations` + `mcp_api.rs` 32 KB | rmcp 1.7；`MCPToolDisplay.tsx` 34 KB |
| ACP 双向 | `src/crates/interfaces/acp` | manager.rs 108 KB；6 内置预设 |
| Browser 控制 | `adapters/webdriver` + `browser_api.rs` 29 KB | 原生子 WebView |
| MiniApp 生态 | `MiniApp/`（Demo×4, Skills）+ `product-domains/src/miniapp` | 独立市场 + SDK + shell |
| Generative UI | `docs/architecture/generative-ui-architecture.md` 28 KB | OpenUI 组件路径 + HTML/CSS/SVG 自由路径 |
| 页面（Pages）发布 | Tool `PageManage/PageDeploy/PagePublish` | |
| 技能（Skills） | `agent-runtime/src/skills/`（9 文件） | catalog/hooks/policy/resolver/roots/selection |
| Hooks | `docs/features/agent-hooks.md` + `core/src/native_hooks.rs` 56 KB | 实现 **Codex hook 契约**，不 fork |
| 子 Agent | `agent-runtime/src/{agents,custom_subagent,subagent_task}.rs` | 工具 `Task/AgentSpawn/AgentSendInput/AgentWait/AgentList` |
| Deep Review | `agent-runtime/src/deep_review/` + `docs/architecture/deep-review.md` 38 KB | 含 evidence_ledger 35 KB |
| Cron / 定时 | `agent-runtime/src/scheduled_job.rs` + `CronAPI.ts` | 工具 `Cron` |
| 远程工作区（SSH/Docker） | `services-integrations/remote-ssh-concrete` + `ssh_api.rs` 50 KB | `SSHConnectionDialog.tsx` 75 KB |
| Remote Connect（手机/IM 遥控） | `services/relay-service` + `mobile-web` | `remote_connect_api.rs` 165 KB |
| Peer Device Mode | `infrastructure/peer-device` | 一台设备成为另一台的数据面 |
| Detached Dispatch | `docs/architecture/detached-task-dispatch.md` 27 KB | 控制器提交后断连，目标机拥有 job |
| 桌面宠物 | `app/components/AgentCompanionDesktopPet` | 10 个宠物包 18 MB |
| 生成式 Widget / DesktopCard | `tools/DesktopCardAPI.ts` + 工具 `DesktopCard` | |
| 语音输入 | `infrastructure/speech` + sherpa-onnx | |
| 全局搜索 | `app/global-search/`（30+ 文件） | 联邦搜索 + capability catalog |
| Visual Skin（皮肤） | `infrastructure/visual-skin/` + `docs/features/visual-skin-packs.md` | surface paint runtime |
| i18n | `src/shared/i18n/contract` + 生成器 | 契约驱动，有 audit |
| CLI/TUI | `src/apps/cli` | ratatui 0.29 + crossterm |
| Agent SDK | `sdk/typescript` | 生成的 wire runtime + validator |
| 产品定制（白标） | `scripts/product-customization/` | 品牌/能力集/入口布局在构建期定 |
| Data Tools（会话修复） | `src/apps/data-tools` | 独立 Tauri app |

### 刻意没做的

这一项的证据比较分散，但有几条是明确的**成文取舍**：

1. **不做"用硬编码限制解决 Agent 死循环"**（明确的反模式禁令）
   > "Do not add hard-coded limits or pattern checks to the agent loop as a first response to looping behavior, such as blocking repeated tool calls by string or count alone; that turns the loop into a brittle workflow engine."
   [证据: `AGENTS.md:110`]

2. **不做"沙箱安全"的过度承诺**
   > 架构目标第 7 条："第三方代码运行在受监督子进程并具备期限、取消、流控和故障回收；没有 OS 或容器硬边界时，不宣称完全隔离。"
   [证据: `docs/architecture/product-architecture.md:22`（目标列表第 7 条）]

   同一文档还说 Plugin Host 的"首要目的，是把第三方 JS/TS 异常与 Rust 主应用进程隔开，不是把插件彼此隔开"，明确不承诺同 Host 内插件互不影响 [证据: `docs/architecture/extensions/plugin-runtime-design.md:3.2 节`]

3. **不做"把所有历史塞进 prompt"**
   - 相反：工具的 schema 通过 `GetToolSpec` / `CallDeferredTool` 延迟发现 [证据: `tool-provider-groups/src/lib.rs:222-224`]
   - 前置提醒是"collapsed tool listing"而非全量 [证据: `cache-friendly-message-structure.md:19`]

4. **不做"无 Tab 也要造一个 tab"**
   - 明确：应用启动零 tab，无 tab 时渲染 WelcomeScene 作为 shell 拥有的落地页，"rather than manufacturing a tab for it" [证据: `src/web-ui/src/app/scenes/SceneViewport.tsx:8-11`]

5. **不做"用浏览器截图当视觉证据"**
   > "Do not use browser automation or mock screenshots as visual proof."
   [证据: `design-system/AGENTS.md:74`]

6. **不做"提高 baseline 让审计通过"**
   > "Theme and color-token baselines … are ratchet contracts, not editable test expectations. Never make a failing audit pass by raising baseline values…"
   [证据: `AGENTS.md:103`]

7. **不做完整的 OpenCode 运行时**（目标 ≠ 已交付）
   - "其余兼容项仍按能力矩阵标记为未实现，不能由这条运行切片外推成完整 OpenCode Runtime" [证据: `plugin-runtime-design.md:32`]

8. **不做"重新发明 Codex hook 契约"**
   > "Native user hooks implement the Codex hook contract, so https://learn.chatgpt.com/docs/hooks is the reference… Do not fork that contract."
   [证据: `AGENTS.md:184`（Read before changing 节）]

9. **不做"用 docs/superpowers 存过程产物"**
   > "Do not add or update files under `docs/superpowers/**`; `check:repo-hygiene` rejects them. Keep temporary planning, design, and implementation-process artifacts local."
   [证据: `AGENTS.md:112-115`]

10. **不做"性能优化靠砍业务状态"**
    > "也没有通过切页卸载业务状态、停止正常数据刷新或取消可见动画降低数字" [证据: `docs/performance/08-performance-wrap-up-2026-11-06.md`（"实际完成的修改"节）]

### 插件形态

**结论：OpenBitFun 的"插件"有四层，且刻意区分"发现/加载顺序"与"执行许可"——发现只产生候选，不授予执行权。**

| 层 | 形态 | 边界 | 证据 |
|---|---|---|---|
| L1 Skills | Markdown + 目录约定 | 只贡献 prompt 内容，不执行代码 | `agent-runtime/src/skills/{catalog,resolver,roots,selection}.rs` |
| L2 Hooks | 外部进程 / 脚本，遵循 Codex hook 契约 | 事件变换，不拥有状态 | `docs/features/agent-hooks.md`、`core/src/native_hooks.rs` 56 KB |
| L3 MiniApp | 独立 Web 应用 + 沙箱 shell + 市场 | 有自己的 SDK 与 IPC | `MiniApp/`、`miniapp-ipc`、`miniapp-market-service` |
| L4 Plugin Host | **Bun 子进程**，跑第三方 JS/TS | 受监督，不在主进程内 | `core/src/plugin_host.rs` 80 KB、`plugin_runtime.rs` 41 KB |

关键设计原则：
- **单一真相不复制**：`PluginRuntimeClient` "只使用已经允许执行的插件实例，不建立第二套来源、信任、激活状态或插件生命周期对象" [证据: `plugin-runtime-design.md:64-65`]
- **进程键不是 session**："workspace、session、插件和贡献数量都不是默认进程键。一个 Plugin Host 可以承载多个来源、多个 workspace 的逻辑实例和多个 session 的调用" [证据: 同上:3.1 节]
- **发现与执行分离**：产品架构目标第 6 条 "发现执行分离：发现与加载顺序只产生候选输入，不授予执行许可" [证据: `product-architecture.md` 目标第 6 条]
- **能力矩阵只减不增**：Remote surface 每个 Tauri 命令必须有恰好一行声明远程姿态，且新行不得用 `Unaudited` [证据: `AGENTS.md:143-146`]

宿主的扩展点（前端侧）：
- 侧边栏贡献注册表 `createSidebarRegistry`，要求 id 含 `.` 且不可重复，冻结条目 [证据: `src/web-ui/src/app/navigation/sidebarRegistry.ts:27-53`]
- 但**明确标注这不是插件执行边界**："Trusted frontend contributions only; this is not a plugin execution boundary." [证据: 同上:26]
- 场景导航懒加载注册 `SCENE_NAV_REGISTRY`，只有 settings / file-viewer 两个场景有自己的 Nav，其余回落 MainNav [证据: `src/web-ui/src/app/scenes/nav-registry.ts:40-59`]
- 创作插槽：`data-openbitfun-creation-slot="sidebar-footer" / "scene-header" / "scene-footer"` [证据: `WorkspaceBody.tsx:120,169,183`]

---

## 界面设计

### 信息架构

**结论：`.openbitfun-app-layout` 是"外层壳 + 左右两栏 + 中间可分裂工作台"的四级结构，且每一级都带 `data-openbitfun-*` 契约标记。**

真实 DOM 层级（从 `AppLayout` → `WorkspaceBody` → `WorkbenchLayout`）：

```
.openbitfun-app-layout                        [AppLayout.tsx:628]
  ├─ VisualSkinSurfacePaint                   皮肤绘制层（绝对定位）
  ├─ AppearanceBackgroundMediaLayer           背景媒体层
  ├─ main.openbitfun-app-main-workspace       [AppLayout.tsx:714]
  │   └─ .openbitfun-workspace-body           [WorkspaceBody.tsx:83]
  │       ├─ __material                      材质层（aria-hidden）
  │       ├─ __collapsed-nav                 [折叠态] NavBar
  │       ├─ __nav-area  (--nav-width: 300px) [WorkspaceBody.tsx:105-121]
  │       │   ├─ NavBar          (45px — 后退/前进 + 拖拽 + WindowControls)
  │       │   ├─ NavPanel        (flex:1 — MainNav 或场景专属 Nav，双层 crossfade)
  │       │   └─ [creation-slot: sidebar-footer]
  │       ├─ __nav-divider       可拖分隔条（aria role=separator）
  │       └─ __scene-area
  │           ├─ __corner-underlay
  │           └─ __scene-surface             [WorkspaceBody.tsx:158-166]
  │               ├─ [creation-slot: scene-header]
  │               ├─ WorkbenchLayout
  │               │   └─ SplitView
  │               │       ├─ header = SceneTopBar (tabs + chrome + window controls)
  │               │       ├─ surface[primary]  = SceneViewport
  │               │       └─ surface[secondary]= AuxPane (canvas/终端)
  │               └─ [creation-slot: scene-footer]
  ├─ FloatingMiniChat                         [AppLayout.tsx:727]
  └─ MCPInteractionDialog / AboutDialog / WorkspaceManager
```
[证据: `src/web-ui/src/app/layout/AppLayout.tsx:627-729`、`src/web-ui/src/app/layout/WorkspaceBody.tsx:2-12,81-189`、`src/web-ui/src/app/workbench/WorkbenchLayout.tsx:135-161`]

关键数值（来自源码常量，非 token）：
- `NAV_DEFAULT_WIDTH = 300` / `NAV_MIN_WIDTH = 216` / `NAV_MAX_WIDTH = 480` / `COLLAPSE_THRESHOLD = 64` [证据: `WorkspaceBody.tsx:29-32`]
- NavBar 高 45px [证据: `WorkspaceBody.tsx:7` 注释 + `layout.toolbar.mdHeight = 45px`]
- session tab 上限 12 [证据: `sceneStore.ts:100`]

**双层导航层**（这是它最独特的一处）：
- NavPanel 同时挂 `mainLayer` 和 `sceneLayer`，MainNav **始终挂载**（保状态），场景 Nav 懒加载
- 非激活层加 `aria-hidden` + `inert` [证据: `NavPanel.tsx:85-119`]
- 只有 pointer 导航才播 crossfade/translate，键盘与程序化导航**立即**（`motion: 'none'`）[证据: `NavPanel.tsx:107-116`、`sceneStore.ts:629`]

### 场景体系

**结论：16 个场景是一个扁平注册表，用 4 个布尔/枚举位表达全部策略差异：`pinned` / `closable` / `singleton` / `defaultOpen`。没有 class、没有继承、没有 if-else 分支。**

完整注册表 [证据: `src/web-ui/src/app/scenes/registry.ts:33-175`]：

| # | id | label | pinned | singleton | 备注 |
|---|---|---|---|---|---|
| 1 | `personal-overview` | Home | ✗ | ✓ | 落地首页 |
| 2 | `session` | Session | **✓** | ✓ | 唯一 pinned 且 closable |
| 3 | `terminal` | Terminal | ✗ | ✓ | |
| 4 | `git` | Git | ✗ | ✓ | |
| 5 | `settings` | Settings | ✗ | ✓ | 有专属 Nav |
| 6 | `profile` | Profile | ✗ | ✓ | |
| 7 | `agents` | Agents | ✗ | ✓ | |
| 8 | `skills` | Skills | ✗ | ✓ | |
| 9 | `ecosystem-compatibility` | External Import | ✗ | ✓ | 现重定向到 settings 页 |
| 10 | `miniapps` | Mini App | ✗ | ✓ | |
| 11 | `pages` | Pages | ✗ | ✓ | |
| 12 | `browser` | Browser | ✗ | ✓ | |
| 13 | `assistant` | Assistant | ✗ | ✓ | |
| 14 | `todos` | Task Board | ✗ | ✓ | |
| 15 | `insights` | Insights | ✗ | ✓ | |
| 16 | `shell` | Shell | ✗ | ✓ | |

注册表之后的动态场景（3 类，不在静态表里）：
- `miniapp:<appId>` — 每个 MiniApp 实例一个 tab，`singleton: false` [证据: `registry.ts:191-202`]
- `session:<device>:<workspace>:<sessionId>` — 每 session 一个 tab [证据: `sceneStore.ts`、`components/SceneBar/types.ts` 的 `getSessionSceneTabId`]
- `content:<resourceId>` — 画布内容资源 tab [证据: `sceneStore.ts:305-313`]

规则被写成 4 行文件头注释，而不是散落在代码里 [证据: `registry.ts:1-9`]：
```
- Every explicitly opened scene remains open until the user closes it.
- pinned = true: stays ahead of regular tabs while open.
- closable = false: protected from manual close; pinning is independent.
- Scene ids are unique, while Mini Apps use one id per app instance.
```

`singleton` 字段**在静态表里全部为 true，动态构造里为 false，但全仓从未被读取** — 这是本次穷尽 grep 确认的死代码（见缺点 4）。它的类型声明甚至带了一句有意义的注释 `/** One presentation host; resource tabs may share that host. */`，说明原本有设计意图，只是从未接上实现。[证据: `src/web-ui/src/app/components/SceneBar/types.ts:83-84`]

**16 个静态场景与渲染入口的精确对应（实测）**：`SceneViewport.tsx` 里 **15 个静态场景有渲染入口**，唯一没有的是 `ecosystem-compatibility`（被重定向到 settings 页）。其中**只有 3 个是同步 import**（`settings` / `assistant` / `session`），其余 12 个走 `lazyWithRecovery`；另有 2 个非注册表入口（`WelcomeScene` 无 tab 落地页、`ContentResourceView` 画布内容）[证据: `SceneViewport.tsx:32-57`]。注意"16 个场景"是注册表口径，"15 个渲染入口"是 SceneViewport 口径，两个数字口径不同，不要混用。

场景渲染侧：
- 已打开的 scene host **保持挂载**，但只有激活的可见 [证据: `SceneViewport.tsx:3-6`]
- 16 个场景中只有 `SessionScene` 是**同步 import**（主交互路径，避免首次打开等 chunk）[证据: `SceneViewport.tsx:42-43` 注释 + `:36`]
- 其余 14 个走 `lazyWithRecovery` + idle 预热（`SCENE_WARMUP_DELAY_MS = 2500`，8 个场景排队预热）[证据: `SceneViewport.tsx:44-76`]
- 场景进入动画 `SCENE_ENTRY_DURATION_MS = 480` [证据: `SceneViewport.tsx:59`]

### 导航

**结论：NavPanel 只有 3 个区块（搜索 / 动作行 / 统一会话），刻意把"工作区-会话"合并成单一树，而不是分成两个独立的侧边栏区。**

MainNav 结构 [证据: `src/web-ui/src/app/components/NavPanel/MainNav.tsx:2-8` 文件头注释 + `:245-344` 渲染体]：

```
NavigationPanel
├─ NavigationPanelHeader
│   └─ brandHeader
│       └─ utilityRow → search trigger（含 KeyHint 快捷键提示）  [:249-281]
├─ NavigationPanelBody (scrollbarVisibility="hidden")
│   └─ NavigationPanelContent
│       ├─ topActions                                        [:286-307]
│       │   ├─ Personal Overview 项
│       │   ├─ PinnedNavigationItems（用户固定的导航项）
│       │   └─ MiniAppShortcuts（若 pinnedAppIds 非空）
│       └─ section[sessions]                                 [:310-340]
│           ├─ StickySectionHeader
│           │   ├─ WorkspaceSessionGroupingToggle（分组/平铺）
│           │   ├─ WorkspaceSessionFilterMenu（筛选）
│           │   └─ 新建工作区 IconButton
│           └─ DeviceWorkspaceSections（设备 × 工作区 × 会话树）
└─ PersistentFooterActions                                   [NavPanel.tsx:122]
```

**为什么这么分**（可从命名与实现推断的意图）：
1. **搜索放最上、且不给输入框而给"触发器"** — 点击打开全局搜索命令面板（`openGlobalSearch()`），带 KeyHint 显示当前键位 [证据: `MainNav.tsx:252-278`]。侧栏不争夺焦点，搜索是模态的。
2. **"Personal Overview" 与 Pinned 项合并在 `topActions`** — 用 `isOverviewActive` 一个布尔判断当前是否在总览类场景（`personal-overview/assistant/profile/agents/skills/miniapps` + 非 pinned 的 miniapp）[证据: `MainNav.tsx:86-89`]。这是一种"软高亮"：这些场景不算导航项，但进入它们时 Home 不该亮着。
3. **只有 sessions 一个 section** — 工作区（workspace）不是独立分区，而是 session 树的根节点。因此 `DeviceWorkspaceSections` 这个组件同时管设备、工作区、会话三层 [证据: `sections/devices/DeviceWorkspaceSections.tsx` 12 KB]。
4. **Sticky 头部**：section header 在滚动时吸顶 [证据: `components/StickySectionHeader.tsx` 3.2 KB + `MainNav.tsx:311`]
5. **Footer 常驻** 收敛所有"非导航"入口（账号/设备/更新/通知/远程连接/反馈/版本）[证据: `components/PersistentFooterActions.tsx` 12.5 KB]

NavPanel 的取舍也写在注释里：
> "All scene navigation shares a short paired crossfade/translation for pointer input. Keyboard and programmatic navigation stay immediate. MainNav is always mounted so its state is preserved across transitions."
[证据: `NavPanel.tsx:3-9`]

### 布局 token

**结论：`layout.*` 是一个约 100 项的具名几何体系，特点是「按组件族命名」而非「按尺度命名」。它不提供通用 `--space-*` 之外的抽象，而是直接给"导航面板项高 30px"这种可审计的确定值。**

完整实测值（`system.tokens.json` 的 `layout` 组，共 15 个子族）[证据: `design-system/packages/design-tokens/src/system.tokens.json`，本次以 JSON 解析逐项导出]：

**导航面板（最核心的一组）**
```
layout.navigationPanel.inlineSize            = 216px
layout.navigationPanel.surfacePadding        = {space.2} = 8px
layout.navigationPanel.contentGap            = {space.4} = 16px
layout.navigationPanel.sectionGap            = {space.1} = 4px
layout.navigationPanel.headingHeight         = 24px
layout.navigationPanel.headingPaddingInline  = {space.2} = 8px
layout.navigationPanel.headingGap            = {space.5} = 20px
layout.navigationPanel.headingActionSize     = 22px
layout.navigationPanel.itemHeight            = 30px
layout.navigationPanel.itemPaddingInline     = {space.2} = 8px
layout.navigationPanel.itemGap               = {space.2} = 8px
layout.navigationPanel.itemRadius            = {radius.base} = 8px
layout.navigationPanel.itemIconSize          = 14px
layout.navigationPanel.scrollbarGap          = 2px
layout.navigationPanel.footerHeight          = 40px
layout.navigationPanel.footerPadding         = {space.2} = 8px
```

**工具栏**
```
layout.toolbar.smHeight            = 33px      layout.toolbar.mdHeight            = 45px
layout.toolbar.contentGap          = 40px      layout.toolbar.badgeSize           = 24px
layout.toolbar.smPaddingBlock      = 4px       layout.toolbar.smPaddingInline     = 8px
layout.toolbar.mdPaddingBlockStart = 8px       layout.toolbar.mdPaddingBlockEnd   = 6px
layout.toolbar.mdPaddingInlineStart= 8px       layout.toolbar.mdPaddingInlineEnd  = 11px
layout.toolbar.groupGapSm          = 4px       layout.toolbar.groupGapMd          = 8px
layout.toolbar.separatorBlockSize  = 16px      layout.toolbar.overflowFadeExtent  = 16px
```

**折叠区（Disclosure）**
```
layout.disclosure.triggerMinBlockSize   = 30px  layout.disclosure.triggerPaddingBlock  = 4px
layout.disclosure.triggerPaddingInline  = 8px   layout.disclosure.triggerGap           = 8px
layout.disclosure.triggerRadius         = 8px   layout.disclosure.indicatorSize        = 14px
layout.disclosure.actionsGap            = 4px   layout.disclosure.contentPaddingBlock  = 12px
layout.disclosure.contentPaddingInline  = 32px
```

**卡片**
```
layout.card.paddingSm = 12px    paddingMd = 20px    gapSm = 8px   gapMd = 12px   gapLg = 30px
layout.card.radiusSm  = 8px     radiusMd  = 12px    radiusLg = 28px
layout.card.headerGap = 8px     titleDescriptionGap = 4px   footerGap = 8px
layout.card.mediaMinBlockSize = 120px
```

**表单族**
```
layout.field.rootGap=8px  horizontalGap=20px  horizontalGapWide=40px
layout.field.labelWidthSm=150px  labelWidthMd=200px  labelWidthLg=400px
layout.field.contentGap=4px  labelGap=2px  labelActionGap=8px  controlGap=8px
layout.formSection.gap=16px  headerGap=20px  titleDescriptionGap=4px
layout.fieldGroup.radius=12px  rowPaddingBlock=16px  rowPaddingInline=20px
```

**其余**
```
layout.searchDialog.width=744px  height=460px  padding=20px  queryHeight=30px
  scopeGap=20px  resultsGap=30px
layout.empty.gap=10px  paddingBlock=32px  paddingInline=16px
  mediaSizeSm/Md/Lg = 24/32/40px   iconSizeSm/Md/Lg = 24/32/40px
layout.confirmDialog.contentGap=16px  messageGap=8px  iconSize=32px  iconGlyphSize=16px
  previewMaxBlockSize=240px  previewPaddingBlock=12px  previewPaddingInline=16px  previewRadius=8px
layout.spinner.matrixCellXs=3px  Sm=4px  Md=6px  Lg=8px  matrixGapSm=1px  matrixGapMd=2px  matrixRadius=1px
layout.overflowText.fadeExtent=16px   layout.scrollArea.fadeExtent=16px
layout.splitView.contentPanelRadius=24px
```

配套的基础尺度（非 layout 组但被 layout 引用）：
```
space.0=0  .1=4px  .2=8px  .3=12px  .4=16px  .5=20px  .6=24px  .8=32px  .10=40px  .12=48px  .16=64px
space.component.inline=12px  space.component.block=8px
radius.xs=4  sm=6  base=8  md=8  lg=12  xl=16  2xl=20  3xl=24  4xl=32  pill=9999
layer.base=0  decoration=1  content=2  sticky=15  floating=50  dropdown=60
layer.overlay=100  modal=200  modalActive=250  fullscreen=280  overlayHost=300
layer.popover=360  tooltip=370  toast/notification=400  contextMenu=500
```

**这套 token 的设计特征（值得学）**：
1. **所有 layout 值都指向 `space.*` / `radius.*` / `control.*` 的引用，不是裸数字** — 例如 `layout.card.paddingMd = {space.5}`。只有极少数必须精确的值（如 `itemHeight=30px`、`labelWidthSm=150px`、`mdHeight=45px`）是字面量。
2. **每个 token 都有契约测试钉住** — `tests/contract.test.mjs` 32 KB，逐条 `assert.equal(tokens["layout.navigationPanel.itemHeight"], "30px")` [证据: `design-system/packages/design-tokens/tests/contract.test.mjs:49-57,284-358`]
3. **token 层不出现产品语义词** — 没有 `--color-brand`，只有 `--openbitfun-color-*` 语义角色 + `ref.color.*` 基础色（后者不产出运行时变量）

### 密度

**结论：密度是"编译期/启动期固定的单一档"，不是用户可切换的运行时开关。产品固定 `compact`，触摸端固定 `touch`，通过 `data-density` 属性一次写死在 `documentElement` 上。**

- 产品侧常量写死：`const DENSITY: DensityMode = 'compact';` [证据: `src/web-ui/src/infrastructure/design-system/OpenBitFunDesignSystemProvider.tsx:18`]
- 启动时一次性写到根元素，卸载时恢复旧值 [证据: 同上:59-81]
- 四个根属性一起设置：`data-openbitfun-design-system-root` / `data-color-scheme` / `data-contrast` / `data-density` [证据: 同上:61-66]
- 两档密度覆盖的内容 [证据: `design-tokens/src/density-compact.tokens.json`、`density-touch.tokens.json`]：

| token | compact | touch |
|---|---|---|
| `space.component.inline` | 10px | 16px |
| `space.component.block` | 6px | 12px |
| `control.height.sm` | 28px | 40px |
| `control.height.md` | 36px | 48px |
| `control.height.lg` | 44px | 56px |
| `control.hitTarget` | 36px | 48px |
| `control.searchField.height.sm` | 30px | — |

- `DataSystemProvider` 的默认值是 `"comfortable"`，产品覆盖成 `compact` [证据: `design-system/packages/ui/src/providers/DesignSystemProvider.context.ts:55`]

**对比度（`data-contrast`）不是用户开关，而是跟随系统偏好**：
- `const HIGH_CONTRAST_MEDIA_QUERY = '(prefers-contrast: more), (forced-colors: active)';` [证据: `OpenBitFunDesignSystemProvider.tsx:19`]
- 用 `matchMedia` + `addEventListener('change')` 实时跟随 [证据: 同上:27-40]
- 输出只有两值：`'high' | 'standard'` [证据: 同上:51]
- 主题包提供 4 套完整配色：light / dark / high-contrast-light / high-contrast-dark [证据: `theme-openbitfun/src/` 实测]
- Visual skin runtime 会观察 `data-color-scheme` 和 `data-contrast` 的 mutation 并重绘 [证据: `src/web-ui/src/infrastructure/visual-skin/runtime.ts:40,539`]

**注意一个陷阱**：`data-density` 不只表示"密度档"，还被 `WelcomeScene` 复用为**宽度分档**（`compact`/`tiny`），语义被二次占用 [证据: `src/web-ui/src/app/scenes/welcome/WelcomeScene.tsx:154`、`WelcomeScene.scss:135-157`]。同时 `data-density` 在 tool card 上又表示"输出框展开态"（`expanded`）[证据: `flow_chat/tool-cards/ExecProcessToolCardView.test.tsx:395`]。**同名属性三种语义**，这是一个真实的可维护性问题。

### 动画

**结论：动效被当成"事件驱动的语义层"处理——用一个 `data-motion` 属性族把动效意图分类，全局用零特异性 `:where()` 兜底，组件声明自己的 transition 即完全接管。默认值极短（80–420ms），且在 reduced-motion 下只保留 ≤100ms 的 opacity。**

motion token 全量（`motion` 组，3 子族）[证据: `system.tokens.json`]：
```
motion.distance.sm          = {space.1} = 4px

motion.duration.instant     = 80ms      ← 直接反馈下限
motion.duration.fast        = 140ms
motion.duration.base        = 220ms
motion.duration.normal      = {motion.duration.base} = 220ms   ← 别名
motion.duration.contentSwap = 320ms
motion.duration.slow        = 420ms     ← 直接反馈上限
motion.duration.lazy        = 1s
motion.duration.loop        = 720ms

motion.easing.standard   = cubic-bezier(0.23, 1, 0.32, 1)     ← expo-out 型
motion.easing.decelerate = {motion.easing.standard}           ← 别名
motion.easing.enter      = {motion.easing.standard}           ← 别名
motion.easing.smooth     = cubic-bezier(0.77, 0, 0.175, 1)
motion.easing.accelerate = cubic-bezier(0.4, 0, 1, 1)
motion.easing.exit       = cubic-bezier(0.3, 0, 1, 1)
```

**`data-motion` 六个语义槽**（这是它最值得抄的设计）[证据: `src/web-ui/src/app/styles/motion.scss:1-17`]：
```
data-motion="interactive"   color / opacity feedback
data-motion="view"          page or panel entrance
data-motion="popup"         menu, popover, or floating surface entrance
data-motion="presence"      component owns its complete enter/exit lifecycle
data-motion="overlay"       backdrop entrance
data-motion="none"          disable motion for this subtree
```

配套的关键帧（4 个，且都极保守）[证据: `motion.scss:24-70`]：
```
openbitfun-motion-view-enter    opacity 0.92 → 1        （不位移！）
openbitfun-motion-view-exit     opacity 1 → 0
openbitfun-motion-popup-enter   opacity 0→1, translate 0 -4px, scale 0.97→1
openbitfun-motion-dialog-enter  opacity 0→1, translate 0 8px,  scale 0.985→1
openbitfun-motion-overlay-enter opacity 0→1
```

**override 契约被写死在注释里**：
> "this is a zero-specificity `:where()` default, so any component that declares its own `transition` owns it completely. That is deliberate: do not re-assert transition properties with `!important` or make `transition: none` unattainable for dragging. Opt out entirely with `[data-motion='none']`."
[证据: `motion.scss:88-101`]

**几何归谁所有**（这条最有洞察）：
> "Buttons, button-like controls, and legacy interactive surfaces share **paint transitions only**. Pressing a control must not resize it or its contents. **Geometry belongs to explicit state changes (toggles, drag, enter/exit), never to generic hover/press feedback.** In particular, individual `scale` would multiply any component-owned `transform: scale(...)`."
[证据: `motion.scss:78-86`]

**动效纪律清单**（`MOTION_AUDIT.md` 的落地参数）[证据: `src/web-ui/MOTION_AUDIT.md` "默认参数"节]：
- 直接反馈：80–120ms
- 弹层/列表空间连续性：120–180ms
- 大型 Modal：进 180–220ms，退 120–180ms
- 位移通常 2–8px；scale 通常不低于 `.985`；**不用 `scale(0)`**
- reduced-motion：取消位移、旋转、pulse 与滚动动画；必要时只保留 ≤100ms 的 opacity

**明确不做动画的地方**（更有价值）[证据: `MOTION_AUDIT.md` "明确不增加的动效"节]：
- 虚拟化消息行、流式 Markdown、工具卡挂载——不做 fade/slide（避免滚动锚点与高度估算抖动）
- 键盘重复导航、搜索输入、Select option 高亮、warm tooltip——保持即时
- drag/resize 本体严格跟手，不加 easing；只让受影响的邻项和 drop settle 动
- 场景快捷键切换不等长退出
- indeterminate loading 在 reduced-motion 下必须静止且保持可见

**审计工具**：`pnpm run motion:audit` → `scripts/audit-web-motion.mjs`，目标项全部为 0：`transition: all` / `scale(0)` / 未经审查的 JS smooth scroll / 缺少局部 reduced-motion 的无限动画 / 重复全局 keyframe [证据: `MOTION_AUDIT.md` 开头节]。

### 界面纪律

从 `AGENTS.md`（根 + web-ui + design-system 三级）提炼出的**可执行 UI 规则**：

**A. 分层与依赖**
1. UI 组件不得直调 Tauri API，必须走 adapter/infrastructure [证据: `AGENTS.md:47`、`web-ui/AGENTS.md:33`]
2. 组件只消费 semantic/system token，公共组件 CSS **禁用裸色值**；组件私有变量用 `--_` 前缀 [证据: `design-system/AGENTS.md:12`]
3. `@openbitfun/ui` 必须与产品路由/store/语言包/Tauri API 完全无关 [证据: `design-system/AGENTS.md:10`]
4. 新公共包必须有真实消费者，"不要建空占位包" [证据: `design-system/AGENTS.md:38`]

**B. 浮层（这是它写得最细的一块）**
5. 浮层只用 `Portal` / `createOverlayPortal`，**禁止裸 React portal 和按类别覆盖 z-index** [证据: `web-ui/AGENTS.md:36`]
6. 兄弟/坐标子浮层必须声明 `ownerRef`；retained exit 期间要传 `open`；共享事件所有权用 `useDismissibleLayer` 或 `subscribeOverlayInteraction` [证据: 同上:36]
7. 通知栈用中性 `OverlayRegion` 布局 + 每卡独立排名 [证据: 同上:36]
8. 打开顺序拥有全局排名：`layer.overlay(100) < modal(200) < modalActive(250) < overlayHost(300) < popover(360) < tooltip(370) < toast/notification(400) < contextMenu(500)` [证据: `system.tokens.json` layer 组]
9. 菜单/列表行间距归 `overlay.menu.rowGap` 所有，**不允许各消费方用行 margin 或私有 list-gap 修补**；自定义滚动/动画包裹内用 `MenuList` [证据: `design-system/AGENTS.md:15`、`web-ui/AGENTS.md:37`]

**C. 文本溢出**
10. 单行文本槽统一用 `OverflowText`：纯文本默认 fade-out 截断 + 交互 marquee；富组合保持布局除非显式 opt-in [证据: `design-system/AGENTS.md:16`]
11. 图标/操作必须放在文本槽**外面**，拥有控件要标 `data-overflow-trigger` [证据: 同上:16]

**D. 颜色与主题**
12. 颜色/阴影/blur 只能取自 canonical token；允许 `color-mix()`、gradient 等 CSS 运算组合 [证据: `theme-token-optimization.md:58`]
13. **不写 hex/rgb/hsl/命名色**（静态资源元数据和明确主题 renderer owner 除外） [证据: 同上:59]
14. 不用 `var(--token, fallback)` 隐藏缺失 token [证据: 同上:60]
15. 不定 `--color-*` / `--lab-*` / `--openbitfun-appearance-token-*` 这类局部历史前缀 [证据: 同上:62]
16. SVG 图标优先 `currentColor`，由外层 semantic token 控状态 [证据: 同上:63]
17. baseline 是**棘轮**：失败时只能删债，不能抬 baseline [证据: `AGENTS.md:103`]

**E. 动效**
18. 见上文 motion 节：paint-only 反馈、几何归显式状态变更、`[data-motion='none']` 必须可达 [证据: `motion.scss:78-101`]

**F. 可观测性与验收**
19. 每个视觉组件挂 `data-openbitfun-component` / `-part` / `-state` / `-surface` / `-skin-slot` / `-theme-scope` 契约属性 [证据: `AppLayout.tsx:655-661`、`WorkspaceBody.tsx:84-88`]
20. 这些属性由 `scripts/audit-appearance-contracts.mjs` + `appearance-dom-contracts.mjs` 审计，且注册表在 `defaultAppearanceRegistry.ts`（543 行）[证据: 脚本头部 8-22 行 + 目录实测]
21. **不用浏览器自动化或 mock 截图当视觉证据**；视觉保真只能在 Design Lab 手工确认 [证据: `design-system/AGENTS.md:74`]
22. 每类改动都有"最窄匹配命令"，不允许用 workspace 全量套件代替 [证据: `AGENTS.md:96-102`]

**G. CSS 失效（很细但很实用）**
23. 频繁变化的 DOM 里，组件拥有的兄弟样式优先用专用 class，不用 tag-only / 通用兄弟选择器；CSS Modules 和祖先作用域**不会隔离**浏览器失效开销 [证据: `web-ui/AGENTS.md:56-57`]
24. `:where(.owned-class)` 可在不提高特异性的前提下收窄复合选择器 [证据: 同上:58]

---

## 优势（可验证）

1. **单一 Runtime 多宿主的成本分摊是真的，不是口号** — 为什么对：8 个宿主（desktop/cli/server/sdk-host/miniapp-shell/data-tools/relay-server/miniapp-market-server）共享同一套 crate，Agent 行为只需在一处改。证据：`Cargo.toml:2-9` 的 8 个 app member 全部依赖 `assembly/core`；任何新行为落在 L5 `execution`，8 个宿主自动获得，无需重构 UI、传输或协议。[证据: `AGENTS.md:15-22`、`Cargo.toml:2-9`]

2. **依赖方向有机器守卫，分层不会腐化** — 为什么对：口头分层 6 个月必腐化，它把分层变成了 95 KB 的 AST 级检查器 + 227 KB 自测，CI 里失败即阻断。这解释了为什么 54 个 crate 还能保持单向。[证据: `scripts/check-core-boundaries.mjs`、`core-boundaries/cargo-dependency-boundaries.mjs` 95,282 B、`self-test.mjs` 227,727 B]

3. **设计系统真正可独立发包，因为它连 React 都设成 peer** — 为什么对：`@openbitfun/ui` 依赖只有 `design-tokens` + `lucide-react`，React/ReactDOM 是 peerDependencies，`files` 只发布 `dist`。这意味着它可以被另一个产品直接消费而不带版本冲突。实测 `design-system/packages/**` 对 `@/` 与 `@tauri-apps` 的导入为 0。[证据: `design-system/packages/ui/package.json`（dependencies/peerDependencies/files/exports）、本次 rg 实测]

4. **主题用双层色彩模型，把"基础色"和"语义色"彻底分开** — 为什么对：`ref.color.blue.550` 这类基础色**不产出运行时 CSS 变量**，只有语义色映射到 UI 角色。这样"再加一个看起来差不多的蓝"在机制上做不到，必须先在语义层说服人。配合 near-pair 检测（`theme-color-near-pair-decisions.json`）和按 11 个 surface 分治的 baseline。[证据: `design-system/README.md:12`、`theme-token-optimization.md:44-52`、`package.json` 的 `theme:color-audit:*` 11 条脚本]

5. **`layout.*` token 用"组件族"命名而非"尺度"命名，让几何可审计** — 为什么对：`layout.navigationPanel.itemHeight = 30px` 这种命名把"哪个组件的哪个维度"写进了 token 名，所以改动影响面可静态推导，且能被 32 KB 契约测试逐条钉死。对比常见的 `--space-7: 30px`（改了不知道影响谁）。[证据: `system.tokens.json` layout 组全量 + `tests/contract.test.mjs:284-358`]

6. **`data-motion` 六槽 + 零特异性 `:where()` 默认，解决了"全局动效 vs 组件自主"的经典冲突** — 为什么对：通常两种失败模式选一：要么全局 `* { transition }` 污染组件，要么各组件各写一套导致不一致。它用 `:where()` 把全局默认特异性归零，声明"组件写了 transition 就完全接管"，并明确禁止用 `!important` 夺回。这让"拖拽时 `transition: none` 必须可达"这条硬需求成立。[证据: `motion.scss:78-101`、`:where` 选择器使用]

7. **取消语义分三级且状态机不让取消直接回 IDLE** — 为什么对：`USER_CANCEL` → `FINISHING`（而非 IDLE）解决了"queued input 与 tail writes 竞争"这个真实 bug 类。取消失败 `USER_CANCEL_FAILED` → `PROCESSING` 保证不会误判空闲。这两个转换都有明确注释说明原因，不是随手写的。[证据: `state-machine/transitions.ts:16-17,24-26,44-45`]

8. **上下文压缩在到达上限前 10k token 预取，把同步阻塞消灭** — 为什么对：长会话最痛的是"到 95% 时突然卡住 3 秒压缩"。`PREFETCH_LEAD_TOKENS = 10_000` + `in_prefetch_window()` 把压缩变成后台任务，且定义了线性化点（claim 前失败丢弃、claim 后返回）。[证据: `compression_prefetch.rs:9-17,1-3`]

9. **prompt 装配顺序被当成缓存契约写进文档并指定 owner** — 为什么对：prefix cache 命中率取决于前缀稳定性，而前缀稳定性取决于顺序。把"system → tools → 前置提醒四段 → history"的顺序、以及"tool definitions 是 payload 不是 message"这种细节写进架构文档，并在文档头部指定三个具体实现文件，避免了这个知识只活在某人脑子里。[证据: `cache-friendly-message-structure.md:17-44`]

10. **场景注册表用 4 个布尔位表达全部策略，零分支** — 为什么对：16 个场景如果每个都写 if-else 判断"能不能关/要不要 pin/是不是单例"，会散落 50 处判断。现在是 16 条数据 + 2 个纯函数（`getSceneDef` / `isSceneTabClosable`）。新增场景 = 加一条数据。[证据: `registry.ts:33-188`]

11. **导航事务是原子的，且每个异步边界后重校验** — 为什么对：`navigateWorkbench()` 先 `build()` 出完整 plan，然后检查 settings drafts、检查 `isCurrent()`、再 commit；commit 前还要 `unchanged()` 比对 openTabs 与 paneSelections 引用。这防止了"用户快速切了两次，第一次的异步结果覆盖第二次"这类经典竞态。[证据: `sceneStore.ts:580-649`]

12. **插件隔离目标被诚实地限定，不做过度承诺** — 为什么对：它明说 Plugin Host 的目的是"把第三方 JS/TS 异常与 Rust 主进程隔开，**不是**把插件彼此隔开"，并明确不承诺同 Host 内插件互不影响。这比宣称"安全沙箱"然后被绕过要可信。[证据: `plugin-runtime-design.md:3.2 节`]

13. **工具按编译期 feature 分组，让"能力集"成为二进制属性** — 为什么对：12 个 `cfg!(feature)` 组意味着裁剪版客户端（如 CLI 或白标版）在编译期就不含不需要的工具代码，而不是运行时过滤 —— 既省体积也省攻击面。且有测试保证"每个内置工具必须有且仅有一个编译期 owner group"。[证据: `tool-provider-groups/src/lib.rs:64-100,442-452`]

14. **ACP 双向 + 传输层 EOF 语义修得比上游细** — 为什么对：ACP 0.12 在输入 EOF 后会继续等其它 channel sender（会挂死）。它注入一个**仅存在于内存队列、不上 wire** 的私有通知 `_openbitfun/client_transport_closed`，保证"最后一帧（含紧跟 EOF 的 prompt response）读完之后才终止 dispatch"。这是对上游缺陷的精确修复而非绕过。[证据: `client/transport.rs:8-22,60-90`]

15. **性能报告敢写"没做到"** — 为什么对：`08-performance-wrap-up` 明确列出"尚未完成的目标"（P95 113–136ms 未达标、MiniApp 全隐藏主 CPU 仍 8.56%、会话关闭后 footprint 仍 481 MiB、Windows/Linux/真远程未验证），并说明"不能把残留 footprint 直接称为泄漏或已解决"。这种报告质量本身就是工程资产。[证据: `docs/performance/08-performance-wrap-up-2026-11-06.md` 的"尚未完成的目标"节]

---

## 缺点（可验证）

1. **`FlowChatStore.ts` 是一个 374.9 KB / 9,703 行的单文件 store，已经是不可维护级别** — 什么场景出问题：任何涉及会话投影的改动都要在一个近万行文件里定位，code review 无法有效覆盖，IDE 索引与 TS 检查显著变慢；更实际的是**合并冲突**——两人同时改会话投影几乎必然冲突。它的测试文件 `FlowChatStore.test.ts` 也有 383 KB，说明测试同样是巨块而非分层。[证据: `src/web-ui/src/flow_chat/store/FlowChatStore.ts` 383,900 bytes / 9,703 行实测；`FlowChatStore.test.ts` 383,401 bytes]

2. **同类巨型文件在关键路径上成片出现，不是孤例** — 什么场景出问题：`ChatInput.tsx` 301 KB、`ModelSettingsPage.tsx` 261 KB、`EventHandlerModule.ts` 119 KB、`ReviewPlatformPanel.tsx` 120 KB、`ExternalSourcesConfig.tsx` 168 KB、`SessionsSection.tsx` 90 KB、`NavPanel.scss` **95.7 KB**（单文件样式表）。这些都在"用户天天碰"的路径上，任何小改动都要在这些文件里做手术。且 Rust 侧同样：`commands.rs` 225 KB、`agentic_api.rs` 189 KB、`remote_connect_api.rs` 165 KB、`external_sources.rs` **440 KB**。[证据: 本次「前端最大文件」「desktop/src/api 目录」实测表]

3. **`data-density` 一个属性承载三种互不兼容的语义** — 什么场景出问题：`OpenBitFunDesignSystemProvider` 用它表示紧凑/触摸档（`compact`）；`WelcomeScene` 用它表示**宽度分档**（`compact`/`tiny`）；`ExecProcessToolCardView` 用它表示**输出框展开态**（`expanded`）。任何试图写 `[data-density='compact']` 全局样式的改动，会同时命中"紧凑设备档""窄窗口欢迎页""工具输出展开框"三类完全无关的元素。这是一个会持续制造意外回归的语义污染。[证据: `OpenBitFunDesignSystemProvider.tsx:65`、`welcome/WelcomeScene.tsx:154` + `WelcomeScene.scss:135-157`、`tool-cards/ExecProcessToolCardView.test.tsx:395`]

4. **`singleton` 字段在场景注册表里全部声明但从未被读取（已穷尽搜索确认）** — 什么场景出问题：16 条静态注册每条都写了 `singleton: true`，两处动态构造写了 `singleton: false`，类型定义也要求该字段必填 `singleton: boolean`；但全仓 **没有任何一处读取 `.singleton`**。真正决定单例的是 tab id 的构造方式（`getSessionSceneTabId` / `miniapp:<appId>` / `content:<id>` 天然唯一）。后来者会以为"改这个字段能改变单例行为"，改完发现没效果。这是"看起来像配置的死代码"，比没有更糟。<br>验证方式：`rg -n "singleton" src/web-ui/src -g '*.ts' -g '*.tsx' --glob '!*.test.*'` 的全部命中只有 3 类 —— 注释里的 "singleton manager"（Monaco/DragManager/FlowChatManager）、`SceneBar/types.ts:84` 的类型声明、以及 registry/useSceneManager 的赋值；**0 处读取**。[证据: `src/web-ui/src/app/components/SceneBar/types.ts:84`、`registry.ts:40,50,58,66,75,83,92,101,110,119,127,136,145,154,163,172,180,199`、`useSceneManager.ts:79`、本次穷尽 grep]

5. **冷启动被全部后端服务串行初始化阻塞，且作者自己承认未解决** — 什么场景出问题：慢盘、杀软扫描、首次运行场景下，从进程启动到窗口出现要等 7 个串行 `await`（config、i18n、AIClientFactory、agentic system（内含多次磁盘 IO）、function agents、AppState、DesktopRuntimeContext），之后 `setup()` 里还有注册表同步、flashgrep 探测、mobile-web 资源探测、以及 `block_in_place + block_on` 同步等 workspace 启动快照。报告原文："瓶颈不是白屏，而是'窗口出现之前'的纯黑等待期"。[证据: `docs/performance/04-startup-and-bundle-size.md:37-40`；`src/apps/desktop/src/lib.rs` 132 KB]

6. **首包 5.44 MB 单文件，且三语种 bootstrap 文案全部 eager 打进入口** — 什么场景出问题：WebView2 首次运行无字节码缓存，5.44 MB 的 parse/eval 直接落在冷启动关键路径。其中约 793 KB 是 3 语言 × 9 命名空间的 bootstrap JSON，而运行时只需要当前语言（约 1/3）。桌面端无 HTTP 缓存收益。[证据: `docs/performance/04-startup-and-bundle-size.md`（产物体积表 + 第 5 条）]

7. **dist 体积 65 MB，其中 18 MB 是 10 个宠物精灵图全量内置** — 什么场景出问题：安装包 90.5 MB，而多数用户只用 0–1 个宠物。这是产品决策而非技术债，但确实让每次分发都多背 18 MB。[证据: `docs/performance/04-startup-and-bundle-size.md`（`dist/agent-companion-pets` 18 MB；NSIS 90.5 MB）]

8. **前端 store 数量 60 个 / `create()` 65 处，缺少统一的 store 边界规范** — 什么场景出问题：既有 `FlowChatStore`（9,703 行）这样的巨块，也有 `chatInputStateStore.ts`（974 bytes）、`messageEditStore.ts`（761 bytes）这样的微型 store。层级关系（谁权威、谁能写谁）只靠注释和代码惯例，**没有机器守卫**（对比 Rust 侧有 `check-core-boundaries`）。跨 store 的循环订阅风险靠人肉避免。[证据: 本次 zustand 文件实测列表；`sceneStore.ts:719-771` 里有大量模块级 `useSceneStore.subscribe` 副作用]

9. **模块级副作用与 window 事件总线并存，导航真相有两个入口** — 什么场景出问题：`sceneStore.ts` 在模块加载时就直接 `window.addEventListener('scene:open')` 和注册一个全局 subscribe 同步 right-scene → left-nav；同时 `AppLayout` 又有 6+ 处 `window.addEventListener('nav:*' / 'toolbar-*')`。HMR 时靠 `import.meta.hot.dispose` 手工清理（只有终端事件那条做了）。这在测试环境需要额外的 `resetSceneStoreForTest` 兜底，也意味着"打开一个场景"至少有 `openScene()` / `window.dispatchEvent(new CustomEvent('scene:open'))` / `openbitfun:create-acp-session` 三条路径。[证据: `sceneStore.ts:719-771`、`AppLayout.tsx:238-246,494-505,507-523,550-562,580-600`]

10. **`design-system` 被 web-ui 的测试文件反向穿透** — 什么场景出问题：`sidebar-surfaces.test.tsx` 直接 `import ... from '../../../../../design-system/packages/ui/src/components/ActionCard/ActionCard.module.css'`，`materials.test.ts` 直接读 `design-system/packages/ui/dist/index.js` 与源 CSS 路径。任何设计系统内部目录重构都会打断 web-ui 测试（跨包、跨 workspace 的文件路径依赖）。虽然只在测试里，但违反了自己定的"Applications consume only package exports"。[证据: `src/web-ui/src/infrastructure/visual-skin/sidebar-surfaces.test.tsx:14-16,23`、`materials.test.ts:114,124,158,166`、`src/app/styles/scrollbarFocus.test.ts:3`]

11. **16 个场景里 11 个没有专属 Nav，且 3 个场景实际被重定向到别处** — 什么场景出问题：`nav-registry` 只注册了 `settings` 和 `file-viewer` 两个场景 Nav，其余全部回落 MainNav。同时 `openScene('ecosystem-compatibility')` 被硬编码重定向到 `settings/tools.external-import`，`openScene('file-viewer')` 被重定向到 navScene，"Pages" 导航项在 MainNav 里被注释掉（`// temporarily hidden: Pages nav entry`）。这意味着场景注册表声称的 16 个场景里，实际作为独立场景可用的少于声称值，而**注册表本身不反映这个事实**。[证据: `nav-registry.ts:40-59`、`sceneStore.ts:271-285`、`MainNav.tsx:24,97`]

12. **ACP 是"半成熟"能力，但 UI 上以完整能力呈现** — 什么场景出问题：文档明确说 OpenCode 兼容"其余兼容项仍按能力矩阵标记为未实现"、"不能由这条运行切片外推成完整 OpenCode Runtime"；`builtin_clients.rs` 里 `omp` 的 `install_package: None`（用户自管安装）。但设置页与能力目录里 ACP 以 9 个完整子能力呈现（presets / json-config / probe / install / remote-detection / session-model-options / session-commands / dialog-permissions）。用户按 UI 预期使用会撞上"这个 agent 装了但拉不起来"或"某个 session option 不支持"。[证据: `plugin-runtime-design.md:32`、`builtin_clients.rs:76-85`、`capabilities.json` 的 `setting.tools.acp` 条目]

13. **能力目录 44 条 / 329 子能力，靠"每条必须引用已注册 Tauri Command"来防漂移，但 705 个命令只有一份人工维护的映射表** — 什么场景出问题：`capabilities.json` 是**生成物**，源头是手工维护的 `src/shared/interactive-capabilities/catalog.json` + 编译期的 `product_control_owner_registry.rs`。这意味着"新增一个 UI 能力"要同时改 3 处（catalog、owner registry、i18n 的 `search.capabilities`），任何一处漏了要么生成失败、要么能力搜不到。对贡献者门槛很高。[证据: `docs/interactive-capabilities/README.md:3-25`、`AGENTS.md:203-208`（"Every new catalog item also needs a label under `search.capabilities`"）]

14. **`check:web` 的门禁覆盖 6 条审计链，普通前端改动的心智负担极高** — 什么场景出问题：`check:web` = `typography:audit:test && typography:audit && appearance:contract-audit && theme:color-audit:test && theme:color-audit:all && theme:visual-contract`。加一个按钮如果用了新色值，可能在 `theme:color-audit` 挂掉；用了非 token 字号，在 `typography:audit` 挂掉；新加组件没挂 `data-openbitfun-*` 契约，在 `appearance:contract-audit` 挂掉。这对"设计纪律"是好事，但对"我只想改个文案"是显著减速带。它自己也承认要"用最窄匹配命令"，但这要求贡献者先学会 30+ 条命令的映射关系。[证据: `package.json` 的 `check:web` 脚本、`web-ui/AGENTS.md` 的 Verification 节（约 60 条命令映射）]

15. **导航侧栏的 `.scss` 单文件 95.7 KB，且样式与结构强耦合** — 什么场景出问题：`NavPanel.scss` 是所有导航相关样式的唯一归属（含设备卡、工作区树、会话行、筛选菜单等全部变体）。任何导航视觉微调都在这个文件里追加。对比设计系统侧把每个组件拆成 `Component.module.css`，产品侧反而回到了巨型 SCSS。[证据: `src/web-ui/src/app/components/NavPanel/NavPanel.scss` 95,727 bytes]

16. **"仓库卫生"规则与真实产物并存造成认知负担** — 什么场景出问题：`dist/` 被 git 跟踪（2,593 个文件在 `dist/assets`），同时 `AGENTS.md` 说 "Files under `dist/` are generated and must not be edited or committed"。这导致 `rg --files` 统计里 13,520 中有近 2,600 是生成物，任何"数一数有多少文件/组件"的分析都要先手工排除。[证据: 本次 `rg --files` 按目录分组实测（`dist/assets` 2,593）、`design-system/AGENTS.md:17` 的禁令]

17. **`session` 场景同时是"pinned 且 closable"，破坏了 pinned 的直觉** — 什么场景出问题：`registry.ts` 里只有 `session` 一条 `pinned: true, closable: true`，注释也承认 "pinning is independent"（pinning 与 closeability 互相独立）。结果是：Session tab 会永久排在前面，但可以被关掉——关掉后再打开又回到队首。对用户来说"钉住但能关"是矛盾信号；对开发者来说，`orderPinnedTabsFirst()` 每次 set 都要重排，而用户手动拖拽的顺序会被立刻打乱。[证据: `registry.ts:43-52`（`session` 的 pinned+closable）、`registry.ts:6-7` 的规则注释、`sceneStore.ts:196-207` 的 `orderPinnedTabsFirst`]

18. **12 个 session tab 上限用 LRU 静默关闭，且"shown"判定依赖当前渲染面** — 什么场景出问题：多设备 + 多工作区场景下，用户开了 13 个会话（其中一些是别的设备的、正经由 Peer Device 渲染），`capSessionTabs` 会按 `lastUsed` 关掉超出部分，只保护 `keep`（当前打开的）、`shown`（两 pane 正在显示的）、和 `isHeldSessionTab`（跨设备 open 持有的）。也就是说**后台会话会被无提示关闭**，用户的"我明明开着这个"预期被破坏。上限本身是硬编码常量 `MAX_SESSION_TABS = 12`。[证据: `sceneStore.ts:99-111,183-187`]

19. **性能指标明确未达标，但产品已按达标状态发布** — 什么场景出问题：报告承认"新 pointerdown 基线的首页/会话反馈 P95 仍为 113–136 ms"、"生成工具启动仍有 >100 ms 长帧"、"MiniApp 全部隐藏时主 CPU 约 8.56%"、"会话关闭约 230 秒后主 footprint 仍约 481 MiB"，并明确"不能把残留 footprint 直接称为泄漏或已解决"。同时性能验证范围仅限 macOS/WKWebView，Windows/Linux/真 SSH/Docker/Remote Control 全部未验证。[证据: `docs/performance/08-performance-wrap-up-2026-11-06.md` 的"尚未完成的目标"节与"平台与远端"条]

20. **`AppLayout.tsx` 承担了 15+ 个互不相关的职责** — 什么场景出问题：一个 747 行的组件同时管：FlowChat 初始化、窗口关闭策略（macOS 隐藏 vs Win/Linux 读配置）、快捷键注册（mod+B / mod+Shift+B）、全局拖拽拦截、工具栏事件（send-message / cancel-task / create-session / create-acp-session）、自动打开最近工作区、pendingProjectDescription / pendingOpenSettings 的 sessionStorage 接力、SSH 重连 key、macOS 菜单事件、About/Workspace 对话框、MCP 对话框、全屏提示 toast。这些职责彼此无关，但都因为"需要 AppLayout 的上下文"被塞进来。[证据: `AppLayout.tsx:1-747` 全量]

---

## 我们可以直接照搬的（模块级）

按"投入/收益"排序，全部有明确源码位置可直接参照实现。

| # | 模块 | 源码位置 | 照搬什么 | 我方 fork 现状 |
|---|---|---|---|---|
| 1 | **design-tokens 三层 + 契约测试** | `design-system/packages/design-tokens/` | `system.tokens.json` 的 layout/motion/layer 三组全量数值 + `tests/contract.test.mjs` 的"逐条 assert 值"写法 | 已在 fork 内（`design-system` 完整保留） |
| 2 | **`data-motion` 六槽 + `:where()` 零特异性兜底** | `src/web-ui/src/app/styles/motion.scss` | 6 个语义槽名 + 4 个 keyframe + "paint-only 反馈 / 几何归显式状态"契约 + `[data-motion=none]` 必可达 | 已在 fork 内 |
| 3 | **场景注册表 + 4 布尔位模型** | `src/web-ui/src/app/scenes/registry.ts` | 扁平数据 + `getSceneDef` / `isSceneTabClosable` 两个纯函数；新增场景 = 加一条数据 | fork 已扩到 21 条（含 vouch-* / benchmark），模型未改 |
| 4 | **`navigateWorkbench()` 原子导航事务** | `src/web-ui/src/app/stores/sceneStore.ts:580-649` | build→guard drafts→isCurrent→commit 的事务骨架 + `coalesceKey` 幂等合并 + `unchanged()` 引用比对 | 已在 fork 内（fork registry 247 行 vs 上游 202 行） |
| 5 | **NavPanel 双层导航（mainLayer + sceneLayer）** | `src/web-ui/src/app/components/NavPanel/NavPanel.tsx` + `scenes/nav-registry.ts` | MainNav 常挂载保状态；场景 Nav 懒加载；非激活层 `inert`+`aria-hidden`；pointer 才播动画、键盘立即 | 已在 fork 内 |
| 6 | **`SessionDriver` 接口（传输族策略接缝）** | `src/web-ui/src/flow_chat/session-drivers/types.ts` | 20+ 成员接口 + `planSubmission` 三态（queue/steer/reject）+ `TurnTracker` 三标志 | 已在 fork 内 |
| 7 | **会话状态机（4 态 + cancel 进 FINISHING）** | `src/web-ui/src/flow_chat/state-machine/transitions.ts` | 完整转换表 + PHASE 子状态（STARTING/THINKING/STREAMING/TOOL_CALLING/TOOL_CONFIRMING/COMPACTING/FINALIZING） | 已在 fork 内 |
| 8 | **`ApiClient` + 三实现 transport adapter** | `src/web-ui/src/infrastructure/api/adapters/` + `service-api/ApiClient.ts` | 环境探测选实现 + `SurfaceChangedError` 守卫 + middleware 链 + `assertRequestSurface` 双重校验 | fork 保留 `src/crates/adapters/transport` |
| 9 | **ToolRegistry + provider group 编译期分组** | `src/crates/execution/tool-contracts/src/framework.rs:1444-1520` + `tool-provider-groups/src/lib.rs` | `IndexMap` 保序注册 + `snapshot_generation` + `install_static_provider` 批量 + 12 feature group `cfg!` | fork 仅保留 `adapters/transport`，**Rust 侧需自建** |
| 10 | **motion audit + appearance contract audit 脚本形态** | `scripts/audit-web-motion.mjs`、`audit-appearance-contracts.mjs`、`audit-frontend-colors.mjs` | "目标项全部为 0"的意图清单；`data-openbitfun-*` DOM 契约扫描；按 surface 分治的 baseline | 脚本已在 fork（`scripts/`），需按我方命名调整 |
| 11 | **`OverflowText` 单行溢出契约** | `design-system/packages/ui/src/components/` + `design-system/AGENTS.md:16` | fade-out 截断 + 交互 marquee；图标/操作外置；`data-overflow-trigger` 标在拥有控件 | 已在 fork 内 |
| 12 | **浮层排名体系 + Portal ownerRef 契约** | `system.tokens.json` 的 `layer` 组 + `web-ui/AGENTS.md:36` | 10 档 z-index token；禁止类别覆盖；`ownerRef` / retained exit / `useDismissibleLayer` | 已在 fork 内 |
| 13 | **`compression_prefetch` 预取窗口** | `src/crates/execution/agent-runtime/src/compression_prefetch.rs` | `PREFETCH_LEAD_TOKENS=10_000` + `in_prefetch_window()` + claim 线性化点语义 | **Rust 侧需自建** |
| 14 | **cache-friendly prompt 装配顺序契约** | `docs/architecture/cache-friendly-message-structure.md` | 7 段固定顺序 + "tool definitions 是 payload 不是 message" + 前置提醒四段排序 | **需自建，但契约可直接采用** |
| 15 | **`Cancel/Interrupt/Steer` 三级命令语义** | `src/apps/desktop/src/api/agentic_api.rs:3247-3417` + `turn_cancellation.rs` | `DashMap<turnId, CancellationToken>`；interrupt 只在旧执行结算后返回 | **Rust 侧需自建** |

---

## 我们必须超过的（能力级 + 怎么验证）

每条给出**可证伪的验证方式**，不是"做得更好"。

| # | 必须超过的点 | OpenBitFun 的现状（可作为基线） | 我们怎么验证超过 |
|---|---|---|---|
| 1 | **单个 store 不能被允许长到 9,700 行** | `FlowChatStore.ts` 374.9 KB / 9,703 行；测试文件同样 383 KB | 验证：`wc -l` 每个 store 文件，**硬上限 1,500 行**，超限必须拆分；CI 加一条 `max-store-lines` 检查。同时验证跨 store 依赖方向有机器守卫（不是注释约定） |
| 2 | **关键路径组件不超过 500 行 / 50 KB** | `ChatInput.tsx` 301 KB、`ModelSettingsPage.tsx` 261 KB、`ExternalSourcesConfig.tsx` 168 KB、`ModelSelector.tsx` 147 KB | 验证：CI 统计 `src/**/*.tsx` 非测试文件行数分布，P99 < 500 行、max < 800 行；并给出与 OpenBitFun 的同口径对比表 |
| 3 | **属性语义唯一，禁止一属性多义** | `data-density` 同时表示 密度档 / 窗口宽度档 / 输出框展开态（3 种语义） | 验证：写一条 lint 规则，同一 `data-*` 属性名在本仓库只允许 N 个受控取值（N 记在契约文件里），越界即失败。并跑一遍我们的全量 DOM 属性清单做同名冲突检测 |
| 4 | **注册表字段必须有消费者，禁止"看起来像配置的死代码"** | `singleton` 在 16 条静态场景里全部声明、全无消费者 | 验证：写脚本对每个 registry 字段做静态引用计数，引用数 = 0 的字段 CI 报警；`singleton` 这类字段要么删要么真正生效 |
| 5 | **冷启动必须做到"窗口先出、服务后到"** | 7 个串行 `await` 阻塞建窗；作者自评"纯黑等待期"未解决；dist 65 MB / 首包 5.44 MB | 验证：测量三项并出报告 —— (a) 进程启动 → 首帧时间（冷启动，3 次取中位数）；(b) 首帧 → 首个可交互（会话输入框 focusable）时间；(c) 首包 JS 体积。<br>基线对比：OpenBitFun 首包 5.44 MB，我方目标 **< 1.5 MB**；且必须提供 `profile.release` 级实测而非估算 |
| 6 | **安装包体积不能靠"全量内置资源"** | 10 个宠物 18 MB 全内置；NSIS 90.5 MB | 验证：安装包 < 40 MB；且资源必须按需下载（提供离线降级路径）。给出"安装后首次使用核心功能所需下载量"指标 |
| 7 | **ACP 类能力必须按真实成熟度分级呈现** | OpenCode 兼容部分实现但 UI 呈现 9 个完整子能力；`omp` 无一键安装却与有安装的并列 | 验证：每个外部 agent 集成在 UI 上必须带一个可测的成熟度标记（`full` / `partial` / `detect-only`），且该标记来自**运行时能力探测**而非硬编码。E2E 覆盖"partial 能力被点了之后给出明确 unsupported 原因"而非静默失败 |
| 8 | **能力目录的维护不能要求改 3 处** | 新增能力要同时改 `catalog.json` + `product_control_owner_registry.rs` + i18n `search.capabilities`，漏一处就失败 | 验证：新增一个命令/能力，**只改 1 个源文件**即可通过全部生成与审计；生成器负责派生其余。度量：新增能力的"文件改动数"中位数，从 3 降到 1 |
| 9 | **设计纪律的门禁不能让"改文案"也跑 6 条审计** | `check:web` = 6 条链（typography×2 + appearance + color×2 + visual-contract），贡献者需记住 ~60 条命令映射 | 验证：按改动类型做增量门禁 —— 文案类改动只跑 i18n 审计（< 10 s），样式类才跑 color/typography，组件新增才跑 appearance。度量：`改文案` 的门禁墙钟时间 < 10 s（OpenBitFun 需全 6 条） |
| 10 | **导航真相必须单入口** | "打开一个场景"有 `openScene()` / `window.dispatchEvent('scene:open')` / `openbitfun:create-acp-session` 三条路径 + 6 处 `window.addEventListener` | 验证：全仓 `window.addEventListener('nav:*' / 'toolbar-*' / 'scene:*')` 计数 = 0（或 ≤ 1 个明确的 shell 事件桥）；所有导航经由 store action。E2E 断言：同一目标无论从菜单/快捷键/搜索/深链进入，最终 store 状态二进制一致 |
| 11 | **session tab 上限必须可见、可配、不静默丢** | `MAX_SESSION_TABS = 12` 硬编码，超出按 LRU **静默**关闭，仅保护 keep/shown/held 三类 | 验证：tab 回收必须在 UI 上产生可见记录（"已收起 N 个后台会话，点击恢复"），且上限可从设置调整。E2E：开 20 个会话后，用户能找到全部 20 个（含被收起的），且恢复后状态完整 |
| 12 | **`pinned` 与 `closable` 语义不能冲突** | 唯一 pinned 且 closable 的 `session` tab，导致"钉住但能关"+ 每次 set 重排打乱用户拖拽顺序 | 验证：定义 pinned 为"不可关闭 + 置顶"或"仅置顶"，二选一并在类型上互斥（TS 联合类型：`{pinned: true; closable: false} | {pinned: false; closable: boolean}`）。E2E 断言：用户手动拖拽顺序在任意 state 更新后保持不变 |
| 13 | **性能报告必须覆盖 Windows（我们的主平台）** | 报告明确"仅本机 macOS/WKWebView"；Windows/Linux/真 SSH/Docker/Remote/Peer/Dispatch 全部未验证 | 验证：所有性能结论必须带平台标签，Windows 数据不可缺省。给出 Windows 冷启动/首帧/交互 P95/长驻内存四项实测，且必须包含"未达标项"清单（照抄它这个诚实的报告格式，但把平台补齐） |
| 14 | **Rust 侧工具/运行时分层要一次做对，不要事后拆** | 54 crate 是靠 `check:core-boundaries`（95 KB 检查器 + 227 KB 自测）守住的，是**先腐化后治理**的痕迹；`core/src/external_sources.rs` 已 440 KB | 验证：从第一天就有依赖方向检查脚本（可从小处起：只查"contracts 不得依赖 execution/assembly"一条）；并设单文件上限（Rust 800 行），`external_sources.rs` 这类 440 KB 文件在架构上不允许出现 |
| 15 | **样式文件不能回到巨型 SCSS** | `NavPanel.scss` 95.7 KB（对比设计系统侧每组件独立 `.module.css`） | 验证：`*.scss` 单文件上限 300 行；产品侧样式一律 CSS Module 或 tailwind 原子类，不用全局 SCSS 命名空间。CI 统计并出报告 |
| 16 | **`dist/` 不进版本库** | `dist/assets` 2,593 个文件被 git 跟踪，同时规则说"不得提交" | 验证：`git ls-files dist/ | wc -l` = 0；构建产物走 CI artifact / release asset。副作用：`rg --files` 统计口径干净，任何"数文件"的分析不需要手工排除 |

---

## 附：读不到 / 需标注推测的部分

诚实优先，以下内容**未验证**，不应作为结论引用：

1. **未运行任何构建或测试**。所有"能通过"的判断来自源码与脚本存在性，非执行结果。`check:web`、`motion:audit`、`theme:color-audit:all` 的实际通过状态未验证。
2. **未验证运行时行为**。进程模型、IPC、取消语义、压缩预取的描述来自源码与架构文档，未实际运行 app 观测。标注"推测"的部分：压缩预取在真实 provider 下的触发时机与效果。
3. **未量化性能**。文中引用的性能数字全部来自 `docs/performance/` 的项目自述，非本次实测。
4. **MiniApp / Generative UI / Computer Use 的实际可用度**未验证，仅有目录与文档证据。
5. **`singleton` 未消费者**这一结论基于对 `registry.ts` 两个导出函数与 `sceneStore.ts` 的静态阅读；若存在跨文件动态读取（如通过 `Object.values` 反射）则结论不成立 — 未穷尽搜索。
6. **`data-density` 三语义**基于三处源码/测试证据；不排除这是有意的"属性复用"约定 — 但从语义冲突看更可能是历史遗留。
7. **仓库文档称 10526 文件 / 188 MB** 与本次实测 13,520（git）/ 55,066（磁盘）不一致，推测是不同时间点/不同统计口径（可能排除或包含 `dist`、`third_party`、`node_modules`）。
8. **未阅读**：`docs/sdlc-harness/**`（约 22 文件）、`docs/architecture/computer-use-control.md`（90 KB）、`docs/architecture/external-ai-work-sources-design.md`（120 KB）、`src/crates/assembly/core/src/external_sources.rs`（440 KB）。这些可能包含更多取舍证据。
