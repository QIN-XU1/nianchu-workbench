# DSH 与 openclaw 拆解

> 对象：`evidence\dsh-src`（DSH 0.2.2-rc.3，app.asar 解包）与 `D:\refs\openclaw\openclaw-main`（2026.11.3）
> 所有数字均由本次自行统计（`Get-ChildItem` / `rg`），未抄 README。
> 拆解时间：2026-11-15 ｜ 按 `research/拆解/标准.md`

---

# DeepSeek Harness (DSH)

## 一句话定位

**一个可整体替换插件树的 Cordis 插件宿主**：agent loop、工具注册表、会话日志、模型适配器全都是插件；产品是配置文件里的一棵插件树，不是写死的应用。

## 实测数据

| 指标 | 数值 | 证据 |
|---|---|---|
| 包总数 | **338** | `dsh/node_modules/@deepseek-ai/` |
| 前端包 | 70（`dsh-client-ui-*` 62 个） | 目录统计 |
| 工具包 | 29（`dsh-tool-*`） | 目录统计 |
| 唯一工具名 | **75** | `dsh-tools` catalog |
| 进程模型命中 | `child_process\|Worker(\|fork(` 在 334 包 src 中 **0 命中** | rg |
| 前端列宽常量 | `CENTER_MIN=400` / `SIDEBAR_MIN=264` / `MAX=420` / `COLLAPSED=56` / `RIGHTBAR_MIN=300` / `RIGHTBAR_MAX_RATIO=0.7` | `columns.ts:7-26` |
| 默认工具并行度 | **10**（硬编码） | `batch.ts:187` |
| 重试默认 | maxRetries=5，退避 500ms→10s，jitter 0.1 | `retry-policy.ts:15-25,84-109` |
| 测试文件 | **0**（production 安装，testkit 未装） | 全仓 rg |

## 底层架构

### 进程模型

单进程 + in-process 插件宿主。

subagent 只有两种 in-process 后端：`dsh-subagent-spawn-in-process`、`dsh-subagent-fork-in-process`（README 写明 "runs each delegated task in a fresh child agent that **shares this process**"）。

334 个包 src 中旧版搜索 `child_process|Worker(|fork(` 得 **0 命中**。
[证据: `dsh-subagent-spawn-in-process/README.md:13`；`dsh-subagent*` 共 3 个包]

**判断**：这是「插件树可整体替换」的必然选择 —— 跨进程会让 ctx 注入与事件分发失效。代价是所有工具共享一个事件循环。

### 包划分

按**能力 seam**（定义/实现/消费）与**客户端面**切分，不按功能模块。

`docs/cookbook/adding-a-package.md:31-52` 用一张 15 行表强制规定角色后缀：`Controller/Store/Registry/Runtime/Resolver/Engine/Policy/Executor/Gateway/Provider/Backend/Handle` —— 各自何时可用。

**判断**：用命名约定代替目录层级，好处是包名自解释，坏处是 338 个平级包要靠人记命名规则。

### 通信

Cordis 服务注入 `ctx.<key>` + 5 种类型化事件（`emit/waterfall/parallel/serial/bail`）。`waterfall` 是 around-middleware，listener 收到 `(...args, next)`。

浏览器侧唯一远程通道是 Typert 生成的 `ctx.remote.<namespace>`，Host 写 `window.__DSH_BOOT__`。
[证据: `docs/cordis-primer.md:15-31`；`docs/subsystems/web-client.md`]

### 状态真相

**append-only `SessionEvent` 日志**。原则写明（`docs/architecture.md:126,130`）：
> "**Model-visible means logged.** Every model request must be reconstructable from the log."

`deriveMessages()` 投影模型历史，fork/resume/transcript/telemetry 全派生自同一 durable settlement。
[`dsh-session/src/index.ts` 1463 行]

**判断**：这是 DSH 最强的设计 —— 单一真相 + 纯投影，让「模型看见了什么」永远可复算。

### 依赖方向

文档声明严格单向：
```
Host state → Remote → Client model → UI adapter → Conversation → Slots → React
```
并规定「a presentation component never receives Cordis `ctx`, a transport object, or another feature plugin's implementation」。

**但本 checkout 无 tsconfig 工程引用**（`"path"` 命中 0）—— 这是**文档级约束，不是编译期强制**。
[证据: `docs/subsystems/web-client.md`]

## 执行逻辑

### 任务链路

turn = 0..N step，step = 一次模型请求及其工具调用。

```
turn/start → claim → 装配 prompt+工具 → agent/pre-step → step/start
→ agent/request → prepareCall() → 冻结历史 → 流式
→ tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result*
→ step/end → turn/end
```

**retry 不重复** assembly / pre-step / user admission。
[证据: `docs/architecture.md:85-106,114`]

### 工具机制

三层 waterfall + 单调 guard。

guard 返回类型**故意没有 allow**（`docs/subsystems/tools.md:458`）：
> "`undefined` preserves the waterfall decision, while a returned reason or `ToolGuardDenial` can only reduce permission, so a later listener cannot undo it."

**判断**：把「策略不可被后注册者撤销」编码进**返回类型**，使这类事故在编译期不成立。这是全项目最值得抄的一条。

### 并发取消

并发分类 fail-closed，只认 `=== true`；抛异常或未声明一律 exclusive。

调度独占成 barrier、并行走有界滚动池，但 policy/result/context **始终按模型顺序提交**。

取消时**不抛弃已启动 body**：
> "a started promise reaches quiescence before its outcome becomes `ABORTED`"

分 `TOOL_ABORTED` / `TOOL_ABORTED_BEFORE_DISPATCH` 两档。
[`pipeline.ts:106-115,245-293,737`；`batch.ts:4-7,187`]

### 错误重试

策略归 provider，执行器是可选插件。

- `normal`：maxRetries=5，只重试 `EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT`
- `always`：无限
- 退避 500ms→10s、jitter 0.1
- 每次调度**先持久化再 cancellable wait**

[`dsh-llm/src/retry-policy.ts:15-25,84-109`；`dsh-llm-retry/src/index.ts:59-64,83-96`]

### 上下文

压缩是 seam，且 `compaction/*` 三事件全是 **log-only** —— `SurfaceEventType` deliberately NOT extended，摘要骑在带 `surfaceOp:{op:'replace'}` 的 `user/message` 上。
[`docs/subsystems/compaction.md:11`]

## 功能选取

### 有而我们没有

1. **整树可 patch 的 profile/bundle 组合**（`dsh-app-boot/src/profile*.ts`，`dsh --dump-config` 可打印整棵树）
2. **会话格式显式迁移链** `dsh-session-format-v0-to-v1 … v3-to-v4`，一跳一包
3. **PTC 模式**（`dsh-ptc-runtime` + `dsh-tool-executor-ptc`，`run_code` 保留名不可 shadow）
4. **workflow 引擎**（`workflow/*` 全 observe-only，`workflow/end` 故意不带 result 防 mutable alias）
5. **Agent Teams 共享任务板**
6. **Typert 严格生成管线**

### 刻意没做

1. **无内建 turn 预算** —— "tool calls or steering continue the current turn"，要限必须自己写 `agent/turn-stopping`
2. **并发分类是一元的**
3. root 关闭可能丢最后 `turn/end`
4. Approval 请求**故意不带工具参数**（避免第二份会漂移的副本）
5. 持久化不进 session 包
6. 不支持 OpenRouter 专属归因头

[`dsh-agent-loop/README.md` Known Limitations；`docs/subsystems/approval.md:53`；`session.md:1110`；`llm-streaming.md:314`]

### 插件形态

Cordis 插件对象（函数 + `inject` + `apply(ctx)`，或 `Service` 子类）。

铁律：「Registrations are reversible effects」「Every registration should have a disposer」。

`plugin_manager`/`plugin_market` 工具支持 npm 安装并校验 `engines.dsh`。

## 界面

有独立前端，React 18，62 个 `dsh-client-ui-*` 包。

### 信息架构

三列 grid，slot 树驱动。`AppFrame.tsx` 注册进唯一内建 `root` slot，子 slot 为 `sidebar|main|rightbar|shell.bottom|shell.overlay|shell.leading`。

**列宽求解而非 CSS 断点**（`columns.ts:7-26,53-62`）：右栏先收缩再丢轨道，中心才允许跌破最小。
[`AppFrame.tsx:2-6,273-326`]

**判断**：求解式布局比断点更适合「用户可拖拽的桌面壳」，且纯函数可单测。

### 状态呈现

会话事件**节点化** —— `conversation-nodes/` 下 `retry.ts`/`turn-error.ts`/`turn-max-tokens.ts`/`compaction.ts`/`fallback.ts` 等 22 个独立节点，错误与重试**不是塞进 assistant 气泡**。

统计用 `step/end`（非 `assistant/message`）作计数权威，理由写在文件头。
[`conversation-nodes/` 目录；`dsh-session-stats/src/projection.ts:1-20`]

**判断**：这是 DSH 界面层最值得学的 —— 错误/重试/压缩都是一等公民节点，天然可追溯。

### 成本：没有

全仓 `*/src/**/*.ts|tsx` 搜 `usd|dollar|pricing` **0 命中**；模型 catalog 不带价格字段。
[`dsh-llm-deepseek/src/models.ts:8-24`]

## 优势（可验证）

1. **「无特权内核」真的消除了 patch 面** —— 换 provider 或工具不必 fork 包，只需换 bundle 行，且 `--dump-config` 可验证。
   [证据: `architecture.md:9-11,57-65`]

2. **guard 只能单调收缩权限** —— 把「策略不可被后注册者撤销」编码进返回类型，使该类事故在编译期不成立。
   [证据: `tools.md:458`；`pipeline.ts:191,302,343`]

3. **取消不抛弃已启动 body** —— 避免半写状态且无人知情，下游拿到「确定被中断」而非「不知道」。
   [证据: `pipeline.ts:254-293`]

4. **并发判定 fail-closed** —— 默认独占只慢一点，默认并行会带来偶发难复现的写冲突。
   [证据: `pipeline.ts:106-115`]

5. **压缩不改写 surface 语义** —— 复用既有 `replace`，UI/transcript/token-meter 消费者零改动。
   [证据: `compaction.md:11`]

6. **slot 未声明即注册失败** —— 把「注册了没人渲染的静默无效」提前到激活期。
   [证据: `docs/subsystems/slots.md`]

## 缺点（可验证）

1. **完全没有成本或计价**。
   出问题场景：接第三方 provider 做长任务无法回答「这轮花了多少」，无会话级预算控制。
   验证：`rg "usd|dollar|pricing"` 在 `*/src/**/*.ts|tsx` **0 命中**。对照 openclaw manifest 内嵌 `cost.input/output/cacheRead/cacheWrite`。

2. **无内建 turn 预算**。
   出问题场景：工具反复失败或 steering 持续注入时，默认配置下 turn 可无限跑。
   验证：`dsh-agent-loop/README.md` Known Limitations 明写「tool calls or steering continue the current turn」。

3. **并发分类一元**。
   出问题场景：3 个 edit 改同一文件不同段落这类「单独安全、一起竞态」无法表达，整批退化为串行，长 batch 延迟明显。
   验证：`pipeline.ts:106-115` 只认 `=== true`，无资源键声明。

4. **root 关闭可能丢最后一帧**。
   出问题场景：CI 里跑 headless 后立刻退出会产生悬空 turn，下游需各自处理（`dsh-session/src/repair.ts` 195 行即为此）。
   验证：`session.md:1110`。

5. **默认 10 并发 + 单进程**。
   出问题场景：50 并发 grep 或需真并行编译的任务撞天花板，且无「把工具丢另一个进程」的现成 seam。
   验证：`batch.ts:187` 硬编码 10。

6. **本 checkout 无测试文件**（诚实标注：分发形态限制，非设计缺陷）。

## 可照搬的

| 模块 | 照搬什么 | 为什么 |
|---|---|---|
| `dsh-tools/src/batch.ts`（285 行） | batch settlement：`commitReady()` 只沿连续模型顺序推进、`startCall` 先记 seq 再 dispatch、`skip()` 合成 `ABORTED_BEFORE_DISPATCH` 保 replay 有效 | 自己写极易漏掉第三点 |
| `fuseToolSignals()`（`pipeline.ts:737-764`，35 行） | 解决「wrapper 替换 signal 后 caller 取消失效」，并避免嵌套 `AbortSignal.any` 泄漏 listener | 短小但易错 |
| `columns.ts` 三列求解（全文 65 行） | 纯函数、可单测，比 CSS 断点更好断言 | 界面层可复用 |
| `session-stats/projection.ts` | 「用 `step/end` 计数」的结论 | 统计口径正确性 |
| `adding-a-package.md:31-52` | 15 行角色命名表 → 转成 lint/评审规则 | 包治理 |
| `dsh-session-format-vN-to-vN+1` | 一跳一包 + committed generation 永不 rename/replace/delete | 格式演进 |

## 必须超过的

| 能力 | DSH 现状 | 怎么验证我们超过了 |
|---|---|---|
| **成本可见性** | 完全无（0 命中） | 会话结束给出可复算金额，同会话两次展示一致，换模型后历史金额不重算 |
| **turn 预算熔断** | 明确不做 | 必然失控场景下步数/秒数/金额任一触顶即终止，而 DSH 默认能复现「不终止」 |
| **并发从一元升级到声明式资源互斥** | 一元 | `mutexKeys(args)` 相交则串行，3 edit 同文件必串行、3 不同文件必并行且耗时显著更低 |
| **崩溃安全尾部** | root 关闭可能丢帧 | turn 中 SIGKILL 100 次，100% 可分类为 completed/interrupted/failed，零 unclassified |
| **四块硬回归** | 无测试可见性 | 故意改坏 `fuseToolSignals`/`commitReady` 测试必须红 |

---

# openclaw

## 一句话定位

**以 Gateway 为唯一状态所有者的多通道个人/团队助手守护进程**：一个长驻 WebSocket Gateway 持有 20+ 聊天渠道的消息面和会话状态，模型与 agent harness 是可替换插件。

## 实测数据

| 指标 | 数值 | 证据 |
|---|---|---|
| 总文件 | 63766 文件 / 713.5MB | 统计 |
| 扩展插件包 | **188** | `extensions/` |
| 共享库包 | 25 | `packages/` |
| `src/` 功能域目录 | 77 | 平铺 |
| `src/agents` 顶层 .ts | **2270** | 平铺 |
| `src/gateway` 顶层 .ts | **2953** | 平铺 |
| core 工具 | **73** 可解析名（66 定义 + 7 runtime-only） | `core-tool-facts.ts:51-165,174-179` |
| 并发 lane | 11 静态 + 动态 `subagent:<session>` + lane group | `lanes.ts:1-32` |
| 前端路由 | **56** 条，侧栏只 11 项 | `app-route-paths.ts:44-107` |
| 测试文件 | **22233** 个 `.test.ts`（**42.6%**） | src 42.5% / ui 49.3% / ext 39.1% |
| gateway-protocol schema | 274 个非测试 | `packages/gateway-protocol/src` |
| Rust crate | 4 个（32 个 `.rs`） | 统计 |
| `session-controller*.ts` | **82** 个同级（63 非测试） | `src/sessions/` |

## 底层架构

### 进程模型

单 Gateway 守护进程 + 多客户端 + worker/沙箱子进程。

> "One Gateway per host. It is the only place that opens a WhatsApp session."

控制面与设备节点（`role: node`）连同一 WS 端口（默认 `127.0.0.1:18789`）。

确实多进程：174 个非测试文件含 `spawn(|fork(`；`src/worker/worker-process.ts` 定义 worker 启动协议；`packages/worker-runtime` 有完整 task pool。
[证据: `docs/concepts/architecture.md:10-21,38-44,172`；`src/worker/worker-process.ts:22,26-50`]

### 包划分

按**部署单元**——`extensions/` 188 个可独立发布插件包、`packages/` 25 个共享库、`src/` 77 个功能域目录的单体核心。

**但 `src/` 是平铺的**：`src/agents` 2270 个顶层 `.ts`、`src/gateway` 2953 个，靠文件前缀而非目录表达归属。
[证据: `pnpm-workspace.yaml:1-7`；`extensions/deepseek/package.json:18-35`]

### 通信

单一 WS JSON 协议，首帧必须 `connect`；`{type:"req"}`/`{type:"res"}`/`{type:"event"}`；有副作用 method 要求 idempotency key。

**「Events are not replayed.」**

协议 TypeBox → JSON Schema → Swift。
[证据: `docs/concepts/architecture.md:77-96,119-123,174`]

### 状态真相

Gateway 唯一 owner，持久层 SQLite（硬规则：「SQLite, not new JSON/JSONL/sidecar stores」）。

并发正确性靠 **writer claim**：每次 append 带 `expectedWriterRunId`，同步提交事务校验匹配 ——
> "A superseded run therefore cannot commit stale transcript data."
[证据: `AGENTS.md`；`docs/concepts/agent-loop.md:82`]

**判断**：这是 openclaw 最强的机制 —— 把 restart 场景的经典 bug 变成「不可能提交」。

### 依赖方向

单向，且用 `*.import-boundary*.test.ts`（`src/` 下 17+ 个）**强制成 CI 红线**，而非文档约定。
[证据: `src/**/*import-boundary*.test.ts`]

## 执行逻辑

### 任务链路

```
agent RPC → 立即返回 {runId, acceptedAt}
→ agentCommand 解析 model/skills
→ runEmbeddedAgent（先预留 session controller turn 再进 global capacity）
→ subscribeEmbeddedAgentSession 桥接成 tool/assistant/lifecycle 三流
→ agent.wait 等终态
```
[证据: `docs/concepts/agent-loop.md:20-24,78`]

### 工具机制

分层 policy pipeline（profile/provider/agent/group/sender，每层带 provenance）+ **Tool Search**。

core 工具 **73 个可解析名**，11 个 section、4 个 profile。
[证据: `src/agents/core-tool-facts.ts:51-165,174-179,9-11`；`tool-policy-pipeline.ts:1-50`；`docs/tools/tool-search.md`]

### 并发取消

11 个静态 lane + 动态 `subagent:<session>` 前缀 lane + **lane group**（共享预算 + 预留槽位，如 `cron-hooks` 给 hooks 预留 1）。

priority 有**有界抢先**（前台 15s、后台 30s），之后 FIFO；「running turns are never preempted」。

默认 `main = max(8, CPU*4)`、subagent 8、Swarm 32。

取消分三档：普通 `steer` 不中断 tool、Send now 中断支持的 tool、`/queue interrupt` abort 整个 run；被跳过调用**补合成配对 error result**。
[证据: `src/process/lanes.ts:1-32`；`src/gateway/server-lanes.ts:20-24,56-74`；`docs/concepts/queue.md:21,47,146-150`]

### 错误重试

按 HTTP 请求而非多步流程。

- 限流类 **16 次**总尝试、其他瞬态 **8 次/90s**
- 退避 ~1s 指数，cap 60s/30s
- **provider `retry-after`/`RetryInfo` 优先**
- 429 无显式时间用 bucket reset
- 计费/认证/拒绝**不重试**
- 空 body 不构成 4xx 可重试理由

[证据: `docs/concepts/retry.md:11-16,32-50`]

### 上下文

`contextEngine` 插件槽可整体接管 ingest/assembly/compaction，引擎有 `ownsCompaction` 声明。

硬约束是 **prompt prefix 稳定性**，由 `agent-tools.prefix-stability.test.ts` 守着。
[证据: `docs/plugins/architecture-internals.md:23,89`；`AGENTS.md`]

## 功能选取

### 有而我们没有

1. **20+ 真实渠道**（whatsapp/telegram/slack/discord/signal/imessage/matrix/msteams/feishu/line/irc/nostr/twitch/zalo/…）
2. **多用户 multiplayer**（owner 分层、world-readable links、People cards、mentions inbox、turn attribution）
3. **成本与用量追踪**（`src/agents/usage.ts` + `auth-profiles/usage-*` + manifest 内嵌单价 + `/usage full` 可定制 footer）
4. **记忆分层 + dreaming 离线巩固**（tier/provenance/consolidation gates + LanceDB）
5. **Swarm 并行专家 lane**（并发 32）
6. **Tool Search 三模式**（约 30 个 `tool-search-*.ts`）
7. **OTel/Prometheus/审计账本**

### 刻意没做

1. **不做配置兼容别名**（「升级即断」）
2. **不为理论性竞态加复杂度**（「Name an accepted edge case in a comment or the PR. Do not write code for it.」）
3. 不预抽单次 helper
4. 不因「新集成」扩大核心工具面
5. 事件不重放
6. 不为旧 Bun 版本做兼容

[证据: `VISION.md`；`AGENTS.md`；`docs/concepts/architecture.md:174`]

### 插件形态

**manifest-first** —— `openclaw.plugin.json` 承载 `providers/contracts/modelCatalog(含单价)/configSchema/uiHints/configGroups`，core 不加载运行时代码即可发现能力（`activation.onStartup:false` 可延后）。

两套 hook：内部 `HOOK.md` 脚本 + 插件 typed `api.on(...)` 14 个；`{block:true}` 终止且不可被后续清除，`{block:false}` 是 no-op 也不清除。
[证据: `extensions/deepseek/openclaw.plugin.json`；`docs/plugins/tool-plugins.md:14-16`；`docs/concepts/agent-loop.md:98-135`]

## 界面

有独立前端 `openclaw-control-ui`，**SolidJS**（`@solidjs/web` 2.0.0-rc.18）+ Vite。

`ui/src` 下 pages 2361 / components 1193 / lib 813 / app 410 / i18n 162 个 ts/tsx。

### 信息架构

`APP_ROUTE_DEFINITIONS` 定义 **56** 条路由，但 `SIDEBAR_NAV_ROUTES` 只 **11** 项（templates/dashboards/usage/cron/sessions/systems/activity/meetings/plugins/apps/portals）。

收敛规则写在注释里：Skills/Workshop 从 Plugins hub 进、Worktrees 是 Sessions 的 tab、Workboard 由插件 descriptor 进。

侧边栏是**用户可编排 zone**（`route|plugin|session|person` 四型，默认空）。
[证据: `ui/src/app-route-paths.ts:44-107`；`ui/src/app-navigation.ts:15-33,52-60,63-110`]

**判断**：56 路由 → 11 侧栏项，这个收敛比是界面信息架构的关键决策，值得学。

### 状态呈现

进度/流式/成本三分：
- `progress-drafts.md`：mode/labels/detail/commentary lane/line limits/tool log 一整套可配开关
- `streaming.md`：startup status、block streaming、chunking bounds、coalescing、**human-like pacing**、preview modes
- `usage-tracking.md`：account-scoped quotas 与 cost history

### 密度节奏

「Human-like pacing between blocks」与 `typing-indicators.md`（入队即打 typing）被列为一等设计项。

## 优势（可验证）

1. **manifest-first 让 188 个扩展仍能守住启动时间** —— 发现与执行分离，未激活插件零运行时成本。
   [证据: `tool-plugins.md:14-16`；`activation.onStartup:false`]

2. **writer claim 让「旧 run 不能提交新数据」成为事务级保证** —— 把 restart 场景的经典 bug 变成「不可能提交」。
   [证据: `agent-loop.md:82`]

3. **lane + 有界抢先同时解决「别互相踩」与「前台别被饿死」** —— 只做优先级会永久饥饿，只做 FIFO 交互不可接受，这是中间解且数字可调。
   [证据: `server-lanes.ts:20-24,56-74`]

4. **Tool Search 把「工具多」从线性成本变可选成本，并专门保护 KV-cache**（确定性渲染、限 18k 字符、隔离不可信输入、置于 cache boundary 之上）。
   [证据: `tool-search.md`]

5. **重试预算按失败类别分配** —— 一个全局 maxRetries 要么对限流太短、要么对认证错误太长。
   [证据: `retry.md:11-16,32-50`]

6. **import-boundary 用测试强制** —— 在 30014 个非测试文件规模下，结构性测试是唯一守得住架构的东西。
   [证据: `src/**/*import-boundary*.test.ts`]

## 缺点（可验证）

1. **`src/` 平铺，定位成本极高**。
   出问题场景：`src/sessions/` 下 **82** 个 `session-controller*.ts` 同级文件，必须靠前缀猜；`server-plugin-reload*` 同类 20+ 个。
   验证：`(Get-ChildItem src\sessions -Filter "session-controller*.ts").Count`。对比 DSH 338 包分治，这是明显组织债。

2. **事件不重放 + 客户端自修复**。
   出问题场景：移动端切后台 10 分钟后回来事件全丢，每个客户端必须完整实现 gap 检测与全量刷新；`ui/` 2361 个 page 文件里大量需各自处理，任何一处遗漏即界面停在旧态且无法自愈。
   验证：`architecture.md:174` 明写「Events are not replayed.」

3. **无配置兼容别名是双刃剑**。
   出问题场景：升级即断，无渐进窗口；对非技术用户是硬门槛。
   验证：`VISION.md`。

4. **42.6% 测试占比意味着改动成本高**。
   出问题场景：改一个被广泛引用的模块需同步调整的测试可能是两位数；`AGENTS.md` 已用「PR 超 5000 行仅例外评审」限制改动规模，这是测试规模的直接后果。
   验证：`(Get-ChildItem -Recurse -Filter *.test.ts).Count` = 22233。

5. **Gateway 侧职责过载**。
   出问题场景：`src/gateway/` 2953 个顶层文件含 cron/plugins/reload/restart-sentinel/auth/http/lanes/maintenance/methods；`server-plugin-reload*` 一个功能就有 20+ 个测试支撑文件，说明耦合已到需靠测试网兜住的程度。
   验证：目录统计。

6. **三段 codegen 链路是单点**。
   出问题场景：TypeBox → JSON Schema → Swift，改一个核心帧要重生两侧，Swift 生成物未同步会静默不兼容（首帧硬校验会 close 但错误面窄）。
   验证：`architecture.md:119-123`；274 个 schema。

## 可照搬的

| 模块 | 照搬什么 |
|---|---|
| `src/process/lanes.ts` + `command-queue.capacity-groups.ts` | 「命名 lane + lane group 共享预算 + 预留槽位」三件套（对应交互/编排/后台记忆巩固） |
| `extensions/*/openclaw.plugin.json` | manifest-first 插件发现（能力/模型/单价/config schema/UI 提示全前置） |
| writer claim（`expectedWriterRunId`） | 事务级校验，直接套场景数据管线与记忆写入 |
| `agent-limits.ts` | 并发 floor（`MIN_AGENT_MAX_CONCURRENT=8`、`DEFAULT_SUBAGENT_MAX_CONCURRENT=8`）及「IO-bound agent 并发不能只按 CPU 算」 |
| `defineToolPlugin` + `plugins init/build/validate` | 三段式工具脚手架 + CI 校验 generated metadata 是否 stale |
| `AGENTS.md` | 「接受边界必须命名」规则 |

## 必须超过的

| 能力 | openclaw 现状 | 怎么验证我们超过了 |
|---|---|---|
| **可定位性**（对抗平铺债） | `src/sessions/` 82 个同级文件 | 任意功能名 ≤3 跳从入口到实现，由 lint 强制（同目录 >60 文件报警）；同一任务两边各做一次定位并比较跳数 |
| **配置演进要兼容** | 刻意不做 | 保留最近两 minor 可读 + doctor 报弃用 + 旧配置真实启动测试作门禁 |
| **测试成本可承受** | 22233 测试 / 42.6% | 四块硬回归各自能失败；反向指标为单次改动测试同步修改 ≤5 文件 |
| **成本会话级可解释且不依赖用户配单价** | 有成本但依赖 manifest 单价 | 自带主流单价表 + 可覆盖 + 金额幂等 + 换模型不重算 |
| **崩溃安全 + 可解释恢复** | writer claim 但事件不重放 | SIGKILL 100 次后 100% 三态可分类，零 unclassified |

---

# 横向对照

| 维度 | DSH | openclaw |
|---|---|---|
| 形态 | Cordis 插件树，产品即配置 | Gateway 守护进程 + 188 扩展 + 多客户端 |
| 组织 | 338 包，按 seam 角色命名 | `src/` 平铺 2270+2953 文件 + 188 extension 包 |
| 通信 | Cordis 注入 + 5 种事件分发 | 单一 WS JSON 协议 + TypeBox codegen |
| 状态真相 | append-only SessionEvent 日志 | Gateway owner + SQLite + writer claim |
| 并发 | 单进程，fail-closed 并行池（默认 10） | 11 lane + lane group + 有界抢先 + 子进程 |
| 取消 | 不抛弃已启动 body，两档 ABORTED | steer 不中断 / Send now 中断 / interrupt abort |
| 重试 | provider-owned，5 次默认 | 按 HTTP 请求，分类预算（16/8） |
| 成本 | **无**（实证 0 命中） | manifest 内嵌单价 + usage kernel + footer |
| 前端 | React 18，62 ui 包，三列求解 | SolidJS，56 路由/11 侧边栏项 |
| 测试可见性 | 0（生产安装，testkit 未装） | 22233 个 `.test.ts`，42.6% |

---

# 诚实边界（读不到 / 不能断言）

1. **DSH 测试覆盖无法评估**：production 安装，`dsh-agent-loop-testkit`/`dsh-tool-testkit`/`dsh-llm-mock-server`/`dsh-llm-replay`/`dsh-loader-smoke` 在 devDependencies 中声明但**未安装**，全仓 0 个 `.test./.spec.`。只能写「从这个产物无法验证」，**不能**写「DSH 没测试」。
2. **DSH 依赖方向无编译期强制证据**：无 tsconfig 工程引用，属文档+约定级约束；要看强制机制需源码仓。
3. **openclaw 运行时未实测**：结论来自源码与 docs。docs 中大量「实现细节即文档」的强断言（writer claim、15s 有界抢先、lane 预留）与代码文件存在性一致，但**没有运行** openclaw 验证运行时行为。
4. **openclaw 5493 文件未逐行审计**：按文件名与 docs 交叉验证主要模块，复杂度判断基于结构统计与文档密度。
5. **成本对比是结构性的**：DSH 无成本代码（确定）、openclaw 有（确定），真实会话金额未测量。
