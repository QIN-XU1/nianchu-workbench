# openclaw 剖析

> 对象：`D:\refs\openclaw\openclaw-main`（`openclaw/openclaw` v2026.11.3，从部分下载的 tarball 解压）
> 实测：**63,769 文件 / 714 MB**。`src/` 29,750 文件、`extensions/` 13,042、`ui/` 6,573、`scripts/` 3,412、`apps/` 3,271、`test/` 2,718、`packages/` 1,620、`docs/` 1,490、`crates/` 74。
> 缺失说明：`docs/gateway/security.md` 不存在（实际是 `docs/gateway/security/` 目录），属路径差异而非缺文件；`CHANGELOG/` 140 个文件齐全（含 2026.11.3.md）。未发现实质性尾巴缺失。
> 本文所有结论给 `文件:行号` 或目录文件数；DSH 侧事实引自同目录 `vs-dsh.md`（解包 asar 所得），不臆测。

---

## 一句话定位与核心用例

**OpenClaw 是一个"跑在你自己机器上、住进你已有聊天软件里"的多通道 AI 助手网关**：一个常驻 `Gateway` 进程把 28 个消息通道、几十家模型供应商、多种可替换 agent 运行时（自家 loop / Codex / Copilot / Claude CLI / ACP）、会话、工具、审批、密钥、记忆全部收进同一套控制平面，再用一条 WebSocket 协议统一暴露给 CLI、Control UI、macOS/iOS/Android 原生 App 与"设备节点"。

- 产品描述：`package.json:24` —— `"Multi-channel AI gateway with extensible messaging integrations"`；版本 `package.json:3`；CLI 入口 `package.json:36`（`bin.openclaw -> openclaw.mjs`）。
- 一句话自我定位：`VISION.md:3` —— "OpenClaw is the AI that actually does things. It runs on your devices, in your channels, with your rules."
- 形态描述：`README.md:18` —— 开源 AI 助手，跑在你自己的电脑上，在 Discord / iMessage / Slack / Teams / Telegram / WhatsApp 及 20+ 通道和你见面，另有 macOS/iOS/Android/Windows/Linux 原生 App；**一个 Gateway 既是笔记本上的 personal claw，也是共享的 multiplayer claw，差别只是配置**。
- 架构不变量：`docs/concepts/architecture.md:10-17` —— "A single long-lived Gateway owns all messaging surfaces… One Gateway per host. It is the only place that opens a WhatsApp session." 默认 `127.0.0.1:18789`。

**核心用例**（按代码里真实存在的面）：

1. 个人/团队助理：通道私聊、群聊、配对审批（`src/channels/pairing.ts`、`src/channels/direct-dm.ts`）。
2. 远程执行体：`node`（macOS/iOS/Android/headless）连同一 WS，声明 caps/commands，提供 `camera.*`、`screen.record`、`location.get`、`canvas.*`（`docs/concepts/architecture.md:38-47`）。
3. 自动化：cron 调度（`src/cron/` 670 文件）、heartbeat、standing intents。
4. 云端 worker：把会话的编码工作丢到一次性云机器（`docs/gateway/cloud-workers.md`，`src/gateway/worker-environments/` 805 文件）。
5. 多 agent / subagent / ACP 外部 agent（`src/agents/subagents/` 484、`src/acp/` 174）。
6. 有意排除：**不是多租户**。`docs/gateway/security/trust-model.md:13-14` 明确"支持：一个 Gateway 一个信任边界（单 operator 或互信团队）；不支持：互不信任/对抗性用户共用一个 Gateway"。`SECURITY.md:5` 同口径。

> 坐标意义：DSH 是"单用户编码 harness（Cordis 插件树 + 浏览器第二实例）"；OpenClaw 是"**一个人/一个团队的消息中枢 + 远程执行体编排器**"。两者都插件化，但 OpenClaw 把所有"外设"（聊天软件、手机、另一台电脑、云机器、外部 agent CLI）都变成了可挂载对象。

---

## 规模实测表（目录 → 文件数 → 职责）

| 目录 | 文件数 | 职责（证据） |
|---|---|---|
| `src/` 合计 | **29,750** | 主 TypeScript 核心；其中 **14,670 是 test/test-support，占 49.6%** |
| `src/agents` | 5,508 | agent 装配与运行：`embedded-agent-runner/` 807（`run/` 468）、`subagents/` 484、`tools/` 422、`sessions/` 261、`harness/` 241、`sandbox/` 164、`worktrees/` 188、`cli-runner/` 162 |
| `src/gateway` | 5,664 | 控制平面：`server-methods/` 1,331、`worker-environments/` 805、`server/` 149、`openclaw-id/` 124、`talk/` 112、`agent-turn/` 69 |
| `src/infra` | 3,346 | 进程/文件/网络/sqlite/锁/更新/诊断等底座 |
| `src/config` | 1,958 | 配置 schema、加载、迁移、sessions 配置 |
| `src/plugins` | 1,697 | 插件加载器、runtime、contracts、compat |
| `src/commands` + `src/cli` | 1,559 + 1,400 | CLI 命令面与交互 |
| `src/auto-reply` | 1,118 | 消息 → 回复管线：`reply/` 1010（触发、去抖、流式、命令鉴权） |
| `src/state` | 894 | SQLite 状态库：`openclaw-state-schema.sql` **103 KB**、state/agent 两套库、备份与完整性 |
| `src/plugin-sdk` | 799 | 插件公共契约（每个能力一个子路径）+ `packages/plugin-sdk` |
| `src/cron` | 670 | 定时：isolated agent、cron store、webhook |
| `src/channels` | 536 | **通道抽象层**（非通道实现）：类型、registry、allowlist、pairing、ingress 排空、草稿流、typing |
| `src/shared` | 345 | 共享工具 |
| `src/node-host` | 232 | 节点运行时：连接、invoke、worker supervisor、workspace 传输、自更新 |
| `src/secrets` | 238 | SecretRef、共享密钥库、出网代理、审计/apply |
| `src/skills` | 232 | 技能发现/快照/沙箱同步（另有 `skills/` 51 个技能包共 77 文件） |
| `src/process` / `src/tui` | 263 / 184 | 进程与终端 UI |
| `src/acp` | 174 | Agent Client Protocol 外部 agent 接入 |
| `src/security` | 91 | 安全审计：`audit.ts` 44 KB + `audit-*` 系列 |
| `src/mcp` | 23 | MCP 桥（真正的 MCP 客户端在 node-host/插件里） |
| `src/memory` | **4** | 仅 `MEMORY.md` 路径解析 + 产物溯源（详见机制四） |
| `extensions/` | **13,042** | ~180 个随包插件：25 个通道插件 + 67 个模型供应商 + 16 语音 + 6 记忆 + 5 agent-runtime + … |
| `ui/` | 6,573 | Control UI（**Solid.js 2.0-rc，不是 React**） |
| `apps/` | 3,271 | macOS 833 / iOS 691 / Android 908 / Linux 168 / shared 605 |
| `docs/` | 1,490 | 文档站源：`plugins/` 382、`gateway/` 162、`channels/` 110、`providers/` 104 |
| `packages/` | 1,620 | 26 个可发布包：`gateway-protocol`、`gateway-client`、`plugin-sdk`、`agent-core`、`memory-host-sdk`… |
| `crates/` | 74 | 4 个 Rust crate（详见机制六） |
| 其他重文件 | — | `package.json` **156 KB（约 1000 个 script）**、`pnpm-lock.yaml` 641 KB、`taxonomy.yaml` 731 KB、`maturity/scorecard.md` 230 KB、`AGENTS.md` 19.6 KB |

**规模结论**：这是"产品级 + 组织级"仓库，不是个人项目。49.6% 的测试占比说明一半工程投入在验证；同时也意味着**任何模型/新人想整体理解它，成本极高**——这本身是第一短板，也是我们的机会。

---

## 核心机制一：多通道抽象（支持平台全表 + 统一接口）

### 1. 通道不是 core 代码，是插件

`src/channels/**` 只有抽象与公共管线（`src/channels/AGENTS.md:3`——"core channel implementation" 指共享实现，不指具体平台）。真实平台在 `extensions/`，每个通道一个完整插件包（telegram 一个目录 **541 文件**）。

**bundled 通道全表（28 个，来自自动生成的 `src/channels/bundled-channel-ids.generated.ts`）**：

| # | id | 别名 | # | id | 别名 |
|---|---|---|---|---|---|
| 1 | `discord` | — | 15 | `synology-chat` | — |
| 2 | `slack` | — | 16 | `zalo` | `zl` |
| 3 | `telegram` | — | 17 | `zalouser` | `zlu` |
| 4 | `whatsapp` | — | 18 | `sms` | — |
| 5 | `imessage` | `imsg` | 19 | `nostr` | — |
| 6 | `signal` | — | 20 | `tlon`（Urbit） | — |
| 7 | `msteams` | `teams` | 21 | `twitch` | `twitch-chat` |
| 8 | `googlechat` | `gchat`,`google-chat` | 22 | `x` | — |
| 9 | `matrix` | — | 23 | `a2a`（agent-to-agent） | — |
| 10 | `feishu` | `lark` | 24 | `buzz` | — |
| 11 | `line` | — | 25 | `clickclack` | — |
| 12 | `irc` | `internet-relay-chat` | 26 | `raft` | — |
| 13 | `mattermost` | — | 27 | `reef`（兼 agent 编排） | — |
| 14 | `nextcloud-talk` | `nc`,`nc-talk` | 28 | `qa-channel`（自测） | — |

> 口径差异（重要）：28 个是"配置/路由层 id"，其中 25 个插件在 manifest 声明 `categories:["channels"]`；`reef`（agent-orchestration）、`qa-channel`（developer-tools）等跨类复用通道能力。**"能列出 28 个"≠"28 个都被 QA 到同等水平"**（见短板四）。

### 2. 统一接口：30+ 个可选 adapter 槽位（组合，不是继承）

`src/channels/plugins/types.plugin.ts:69-129` 定义 `ChannelPlugin`：一个 `Omit<ChannelSetupPlugin,"config">` 加 30+ 个可选槽位：

```
config / configSchema / pairing / security / groups / mentions / outbound / status /
gatewayMethods / gatewayMethodDescriptors / gateway(Adapter V1|V2) / auth / identityLink /
approvalCapability / elevated / commands / lifecycle / secrets / allowlist / doctor /
bindings / conversationBindings / streaming / threading / message / messaging /
agentPrompt / directory / resolver / actions / heartbeat / agentTools / reload / defaults
```

关键设计取舍（可直接抄）：

- **能力缺失即降级**，不是抽象基类强制实现。只有 `config` 必需，其余每个平台按能力实现；文件头注释还专门解释泛型用 `any` 是为了让回调参数可变性允许具体实现（`types.plugin.ts:67-68`）。
- **适配器即所有权边界**：`src/channels/AGENTS.md:7`——"Core owns shared message tools, action vocabulary, dispatch; channels own account, security, conversation, transport contracts."
- **入站是持久化排空队列，不是回调**：`src/channels/AGENTS.md:13-30` 给了完整契约——完成的行 `complete()` 墓碑化而非 delete；turn 被 adoption 时才算完成（不是 settle）；单一重试策略（attempt floor 8 + age gate 24h）；claim 心跳 `claimLeaseMs/3`；瞬时失败绝不允许"静默完成"。
- **多账号与热重载**：`ChannelPlugin.reload.accountScopedRestart` 让"只重启变化的那一个账号"成为可选项，且注释写明前提（`types.plugin.ts:81-92`）。

### 3. 懒加载入口契约（冷启动预算的关键）

`extensions/telegram/index.ts:5-30`：

```ts
export default defineBundledChannelEntry({
  id: "telegram", name: "Telegram", importMetaUrl: import.meta.url,
  plugin:  { specifier: "./channel-plugin-api.js", exportName: "telegramPlugin" },
  secrets: { specifier: "./secret-contract-api.js", exportName: "channelSecrets" },
  runtime: { specifier: "./runtime-setter-api.js",  exportName: "setTelegramRuntime" },
  accountInspect: { specifier: "./account-inspect-api.js", exportName: "inspectTelegramReadOnlyAccount" },
  registerFull: (api) => { registerTelegramMiniApp(api); registerTelegramWidgetPresenter(api); },
});
```

即**入口文件只持有字符串引用，直到需要才 `import()`**。配套规则在 `src/channels/AGENTS.md:30-32`：热路径文件（`channel.ts`/`shared.ts`/`gateway.ts`/`outbound.ts`）绝不静态拉入 send/monitor/probe/login 等重面。

### 4. 出站体验也在一等公民里

`src/channels/` 顶层有 `progress-draft-*`（进度草稿合成、diffstat、工具行、工作计数器）、`draft-stream-*`（草稿流式分块、循环）、`typing-lifecycle.ts`、`ack-reactions.ts`、`thread-bindings-*`、`status-reactions.ts`。这就是"在 WhatsApp/Telegram 里看起来像个正常人"的工程量。

> 与 DSH 的差异：DSH 没有"通道"这一层（交互面是自身 GUI/CLI）；OpenClaw 把消息投递语义（去抖、进度、typing、回执、配对、群策略、线程绑定）全部抽象化，这是它最大的一块差异化资产。

---

## 核心机制二：agent 核心与执行循环

### 1. 目录坐标

`src/agents`（5,508）中真正的执行器是 `embedded-agent-runner/`（807 文件，其中 `run/` 468）。主循环入口：`src/agents/embedded-agent-runner/run-loop.ts:67` 的 `runPreparedEmbeddedLoop()`；周边 `run-entry.ts`、`run-orchestrator.ts`、`runs.ts`（41 KB）。

`run-loop.ts` 前 140 行就已把"这一轮到底是什么"说清——它不是 `while(tool_calls)`，而是：

```
runtime 准备(鉴权/模型/transport) → admittedRunContext(准入上下文)
→ attempt 归一化 → provider rate-limit retry deadline → 失败分类/failover
→ 上下文溢出检测 → compaction runtime → terminal resolution(终结判定)
→ usage 累计 → settle(结算) → post-compaction loop guard
```

### 2. 与 hermes / DSH 的 agent loop 的本质不同（4 条）

| 维度 | OpenClaw | DSH / 常见 agent harness |
|---|---|---|
| **谁在执行 loop** | **可插拔 agent runtime**：内置 `openclaw`，外加 plugin harness `codex`/`copilot`/`muse`，以及 CLI backend `claude-cli`（`docs/concepts/agent-runtimes.md:20-33` 的四层表与运行时家族） | loop 本身是产品核心，由自身 Service/模块实现（DSH：`dsh-agent-loop`，见 `vs-dsh.md`）；外部 CLI 是"后端"，不是平级 runtime |
| **输入是什么** | **通道事件 + 队列模式**：channel 选 `steer/followup/collect/interrupt` 之一，与 native 生产者共用同一有序输入选择器（`docs/concepts/agent-loop.md` 队列一节；`channels/AGENTS.md:7`） | 以"用户消息 → 一次 turn"为主，插话是特例 |
| **写入正确性** | **转录写入带 writer-claim fence**：准入后记录 `activeWriterRunId`，每次 append/rewrite 必须带 `expectedWriterRunId` 并在同一事务校验；SQLite writer 队列按 agent 排序；状态目录锁防第二个 Gateway（`docs/concepts/agent-loop.md` "Queueing and concurrency"） | 无同级别 fencing（本地单进程会话日志） |
| **结束的定义** | **显式终结状态机**：`terminalReply`、`NO_REPLY` 静默语义、投递证据（delivery proof）与"结果必需"内会话（`src/agents/AGENTS.md:36-38`；`run/terminal-resolution.ts`） | "loop 返回即完成" |

第三层差异同样重要：**prompt 前缀稳定性是一条硬契约**。`AGENTS.md:71`——同一会话内工具定义/系统提示/历史只依赖会话与配置事实、历史只追加；任何影响 provider 请求的改动必须保持 `src/agents/agent-tools.prefix-stability.test.ts` 绿。`AGENTS.md:72` 进一步要求每个 cache/memo/in-flight join 都按"会改变答案的全部输入"（agent/account/credential/session/workspace + 请求形状）设键。这是把 prompt caching 当契约而非优化技巧。

### 3. 上下文与工具

- 压缩：`compact.ts` 28 KB、`compact.queued.ts` 30 KB、`compaction-session-execution.ts` 33 KB；溢出恢复 `run.overflow-context-recovery`；工具结果截断 `tool-result-truncation.ts` **43 KB**。上下文引擎本身也插件化（`src/context-engine/`、`run/context-engine-admission.ts`）。
- 工具：`src/agents/tools/` 422 文件（扁平）；执行审批/沙箱是独立子系统（`bash-tools.exec-approval-*.ts`、`sandbox/` 164、`docs/tools/exec-approvals.md`）。审批语义是"最严者胜"：`tools.exec.*` 与 approvals 默认值取更严的一方，审批只能收紧不能放宽（`docs/tools/exec-approvals.md:26-32`）。
- 子代理：`subagents/` 484；`harness/` 241 负责"外部 agent 运行时"的宿主能力（host-capability、native-hook-relay、gateway-question、context-engine-lifecycle）。

> 结论：OpenClaw 的 loop 工程重心**不在"更聪明的编排"，而在"多入口一致性 + 永不丢消息 + 永远能恢复"**。同一 model resolver 服务所有入口（turn / `/model` / spawn / 单发补全 / `agent --local` / `sessions.create`），`src/agents/AGENTS.md:30`。

---

## 核心机制三：gateway 协议

### 1. 它是什么

`src/gateway`（5,664）＝**一个进程内的控制平面 + RPC 服务器 + 事件总线 + 节点管理 + 云 worker 编排**。分层：

- `src/gateway/methods/core-descriptors.ts:19-20`——**append-only 核心方法表** `CORE_GATEWAY_METHOD_SPECS`，实测 **549 行方法规格**（其中 426 个是带点的 `域.方法` 名），每行 `[name, family, scope, since, policy]`。注释说明这张表是"列出、鉴权、启动可用性、写限流"的唯一事实源。
- `src/gateway/server-methods/core-handlers.ts:14-140`——**约 125 个 lazy handler family**，每个 family 一个 `() => import("./x.js")`，启动时只有元数据，首次调用才加载（`:1` 注释："Lazy core handler families keep gateway startup metadata-only until first use."）。
- `src/gateway/server/`（149）——WS 连接、origin policy、hooks、event-loop health。
- `src/gateway/worker-environments/`（805）——云端/远程 worker 环境。
- `src/gateway/openclaw-id/`（124）——设备/账号身份与隧道发布。

### 2. 协议

- **传输**：WebSocket，文本帧 JSON。首帧必须 `connect`；之后 `{type:"req",id,method,params}` → `{type:"res",id,ok,payload|error}`，以及 `{type:"event",event,payload,seq?,stateVersion?}`（`docs/concepts/architecture.md:75-96`；`packages/gateway-protocol/src/frame-guards.ts:31-52` 给出零依赖帧判别）。
- **版本**：`packages/gateway-protocol/src/version.ts:2-8`——`PROTOCOL_VERSION = 4`，`MIN_CLIENT_PROTOCOL_VERSION = 4`，`MIN_NODE_PROTOCOL_VERSION = 3`，`MIN_PROBE_PROTOCOL_VERSION = 3`。即 **client 必须 v4，node/probe 可吃 N-1**（滚动升级窗口）。
- **schema 单一事实源**：TypeBox 图 → 生成 validator；`packages/gateway-protocol/README.md:40-62` 把入口按"是否需要 TypeBox"切成两半：`frame-guards`/`client-info`/`connect-error-details`/`version` 是 **TypeBox-free**，供浏览器 bundle 只做信封分发；根入口与 `schema` 才拉全图。`:192-199` 还明确 `hello-ok.features.methods` 是"保守发现"而非全量枚举。
- **角色与鉴权**：`connect` 时声明 role + scope（operator / node / probe / worker）；设备身份 + `connect.challenge` 随机数签名（v3 还绑 platform/deviceFamily）；新 deviceId 需配对审批，Gateway 发 device token（`architecture.md:98-118`）。副作用方法（`send`、`agent`）**必须带幂等键**，服务端有短期去重缓存（`architecture.md:75-96`）。
- **进程内捷径**：Gateway 内部 agent 工具**直接走自己的 router**，不另开 WS，但保留 method scope / approval authority / deadline / cancellation（`docs/gateway/protocol.md:16-20`）。
- **HTTP 面**：同端口还提供 OpenAI 兼容 `/v1`、OpenResponses、`tools.invoke`、canvas widget 文档（`docs/gateway/openai-http-api.md` 26 KB、`openresponses-http-api.md` 21 KB、`tools-invoke-http-api.md` 12 KB）。

### 3. 与 DSH gateway 对比

| | OpenClaw Gateway | DSH api-gateway（据 `vs-dsh.md`） |
|---|---|---|
| 形态 | 独立长驻进程，可被远程/手机/其他机器连（默认 `127.0.0.1:18789`，可 tailscale/反代/SSH/iroh） | 桌面/Host 进程内的控制平面，UI 是**浏览器里的第二个 Cordis 实例** |
| 协议 | WS + req/res/event 帧 + 549 行方法规格 + role/scope + 设备配对 | HTTP + SSE（`/plugins/events`）+ Typert Remote 控制器 |
| 客户端 | CLI / TUI / Control UI / macOS / iOS / Android / node / headless / 第三方 SDK | 主要是自家 Web UI + SDK profile |
| 独有概念 | `node`（远程执行体）、`worker`（云机器）、`device token`、`hello-ok` 发现、N-1 协议窗 | Cordis Service 隔离域、Slot 合并树 |

> 可直接继承的不是"用 WS"，而是**一张表管住方法的名字/族/scope/since/启动可用性 + 按族懒加载**。DSH 已有 Typert 控制器，引入"方法表 + scope 列 + since 列"几乎零成本，却能一次性解决发现、鉴权、文档、限流四件事。

---

## 核心机制四：记忆（4 个文件的真相）

### 1. `src/memory` 为什么只有 4 个文件

因为它**只做两件事**：

- `src/memory/root-memory-files.ts:6-24`——定义规范文件名 `MEMORY.md`、历史名 `memory.md`、修复目录 `.openclaw-repair/root-memory`，并提供解析/存在性/跳过辅助路径的工具函数；`:39-58` 还要求"必须是真文件、不是符号链接"。
- `src/memory/memory-artifact-provenance.ts`（8 KB）——记忆产物溯源。

**这不是空壳，而是架构选择：core 不拥有记忆语义。** `VISION.md:117`——"Memory is a special plugin slot where **only one memory plugin can be active at a time**." 真正的记忆在插件里：

| 插件 | 文件数 | 角色 |
|---|---|---|
| `extensions/memory-core` | **541** | 默认记忆实现（文件 + SQLite 索引 + dreaming） |
| `extensions/knowledge` | 445 | 知识库方向 |
| `extensions/memory-wiki` | 120 | Obsidian/wiki 方向 |
| `extensions/memory-lancedb` | 51 | 向量库方向 |
| `extensions/active-memory` | 36 | 主动回忆方向 |
| `src/memory-host-sdk` + `packages/memory-host-sdk` | 14 + — | 宿主给记忆插件的**契约层**（含 `dreaming.ts` 17 KB 报告类型、`event-store.ts` 12 KB） |

### 2. 分层模型（`docs/concepts/memory-architecture.md:57-61`）

| 层 | 载体 | 谁写 | 何时进上下文 |
|---|---|---|---|
| Instructions | `AGENTS.md` + 工作区指令文件 | 仅人类 | 会话开始，永远 |
| Curated core | `MEMORY.md`、`USER.md` | dreaming 整合；用户显式要求 | 会话开始（provenance 合格时，有预算） |
| Episodic | `memory/YYYY-MM-DD.md`、会话转录 | agent 工作中 / memory flush / 转录捕获 | 召回时，不在会话开始 |
| Prospective | standing intents（SQLite）+ cron | `intent` 工具、定时任务 | 仅触发时 |
| Review | `DREAMS.md` + dreaming 报告 | dreaming 各阶段 | 永不进上下文，供人读 |

### 3. 五条设计原则（`memory-architecture.md:32-45`，逐条原文可查）

1. **无隐藏状态**：模型只记得"写进工作区文件的东西"，每个记忆面都能用文本编辑器查看和修改。
2. **写入才是难点**：检索做得好不难，难的是写入时的策展；所以把策展移出回复热路径，交给后台专门的 pass（引用 LongMemEval, arXiv:2410.10813）。
3. **写入路径即安全边界**：内容级扫描抓不住被投毒的事实，所以在**写入时**强制 provenance，在**结构上**把关晋升，而不是事后检测坏记忆。
4. **固定代码规则内嵌模型判断**：打分、阈值、资格、匹配、生命周期都用固定代码规则；模型只在真正需要语言判断处介入，且被代码规则约束。
5. **失败永不阻塞回复**：回复路径上每个记忆步骤都有超时或降级；记忆子系统挂了只是召回质量下降，绝不吃掉一个 turn。

### 4. 溯源（provenance）是字段，不是提示词

`memory-architecture.md:76-92`：内存索引的每条都带 SQLite 列（模型无法用散文写入）：

- **Origin class**（闭集）：`owner`（受信通道由所有者键入）/ `agent`（从 owner 内容推导）/ `untrusted`（网页、工具输出、群里非所有者参与者推导）/ `system`（heartbeat、cron 前言等运行时指令）。
- **Session kind**：interactive / cron / heartbeat / sub-agent。
- **观察时间戳 + supersession key**：让新事实取代旧事实而不是并列堆积。

分类是保守的："无法判定的按来源算 untrusted，含运行时指令的算 system，**永不默认 owner**"。并明确 session-kind 门控：cron/heartbeat/sub-agent 会话不参与自动捕获——因为"生产审计发现绝大多数自动捕获的记忆是运行时指令的复述、heartbeat 噪声和召回反馈循环"。

### 5. Dreaming：默认开启的后台整合

- `docs/concepts/dreaming.md:11`——"Dreaming is the background memory consolidation system in `memory-core`"；**默认开启**（`:13-19`）。
- 三阶段 **light → REM → deep**，由 cron 驱动，可配 `frequency`、`model`，每阶段 `enabled/lookbackDays/limit/minScore/minRecallCount/recencyHalfLifeDays`（`extensions/memory-core/openclaw.plugin.json` 的 `dreaming` schema）。
- 产物：SQLite 机器状态（recall store / phase signals / ingestion checkpoints / locks）、改写前像（preimages）、`DREAMS.md`、可选 `memory/dreaming/<phase>/YYYY-MM-DD.md`。
- **关键护栏**：`maxPriorEntryLossFraction`——一次整合改写允许删掉 `MEMORY.md` 旧条目的最大比例，超了就拒绝并走 append-only 回退；晋升条目带 `<!-- trigger: ... -->` 与 `<!-- importance: 1..10 -->` 注释。
- 工具面：plugin manifest `contracts.tools: ["intent","memory_get","memory_search"]`；另有独立 `memory-search` RPC（`core-handlers.ts:69`）。

> 判断：**"记忆 4 文件"是核心洞察而非缺陷线索**——OpenClaw 把 memory 当成"可换引擎 + 一个文件契约 + 一个 RPC + 一个槽位"，core 只保证"有一份人类可读的 MEMORY.md"。对我们最有价值的一点是：**记忆的价值 80% 在写入路径与晋升闸门，而非索引技术**。

---

## 核心机制五：插件系统与 SDK

### 1. 三层结构

| 层 | 体量 | 职责 |
|---|---|---|
| `extensions/` | 13,042 文件 / ~180 插件 | 随包实现：25 通道、67 模型供应商、16 语音、10 开发工具、10 基础设施、9 web、8 安全、7 agent 编排、7 媒体、6 记忆、5 agent-runtime、4 文档、… |
| `src/plugins/` | 1,697 | 加载器、runtime、`contracts/` 61、`compat/` 35 |
| `src/plugin-sdk/` + `packages/plugin-sdk` | 799 + — | 公共契约：**每个能力一个子路径**，不做大桶 barrel |
| `src/plugin-state/` | 64 | 插件自己的持久状态：SQLite 命名空间、blob store、operation epoch、publication/receipt、worker 隔离 |

### 2. 插件清单 = 声明式能力 + 声明式 UI + 声明式迁移

`openclaw.plugin.json` 是旗舰设计。以 `extensions/memory-core/openclaw.plugin.json` 与 `extensions/telegram/openclaw.plugin.json` 为证：

- 身份与分类：`id` / `name` / `categories` / `kind`（memory）/ `channels`（telegram）。
- 能力契约：`contracts.tools`（memory-core 暴露 `intent/memory_get/memory_search`）、`toolMetadata`（`replaySafe`、profile 可见性）。
- **配置即 UI**：`configSchema`（JSON Schema）+ `uiHints`（每字段 label/help/placeholder）+ `configGroups`（分组与顺序）→ 设置页自动生成。
- 插件自带 UI：`controlUi.entry` + `activation:"settings-only"` + `settingsViews:[{section:"memory",panel:"overview"}]`。
- 命令：`cliCommands` + `commandAliases`（`dreaming` 别名指向 `memory` CLI）。
- **迁移契约**：`doctorContract.stateMigrations` 逐条列出（`memory-core-host-events-jsonl-to-sqlite`、`memory-core-dreams-json-to-sqlite`、`memory-core-dreaming-cron`（`phase:"after-session-repair"`）…）；`configRepair`；telegram 的 `telegram-update-offsets`、`telegram-json-ingress-spool`。
- 生命周期：`activation.onStartup: false`（默认懒激活）、`generationOverlap`、`recommendedPrompts`。

### 3. 边界纪律（写进 AGENTS.md 的规则）

- `src/plugin-sdk/AGENTS.md:24-31`：新 surface 必须是"小的版本化 host/kernel 缝 + 窄的、有文档的子路径"，禁止宽 barrel；禁止把 `src/channels/**`、`src/agents/**` 内部便捷函数外泄；SDK facade 必须无环；**同一运行时面不许混用静态/动态 import**。
- **能力阶梯**（`AGENTS.md:24` 引入，`src/plugin-sdk/AGENTS.md:53-63` 落地）：① 扩已有 owner/命令/技能/插件 → ② 用已有插件契约（bundle 插件优先，code 插件次之）→ ③ 缺契约则加"窄的通用能力"并**同时迁移所有内置实现与调用方** → ④ 只有现有扩展点无法表达的根本需求才动核心。
- **核心是税**：`VISION.md:93-96`——"core 有 per-call 税：每个 core 工具、每行 prompt、每个 config key 都会出现在每个 operator 的每次模型请求里；plugins/skills/channels/apps 没有这种税，所以我们要让那面继续长"。

### 4. 分发与生态

`VISION.md:101-115`：两类插件（code plugins 走运行时扩展；bundle-style 打包 skills/MCP/配置，优先用它，边界更小更稳）；首选 npm 分发 + 本地加载开发；推广走 ClawHub，而不是塞进 core。

> 与 DSH 对比：DSH 用 Cordis 的 Service/inject/effect 做"运行时依赖注入 + 可逆注册"，天然支持热插拔与隔离域（`isolate`/`intercept`）；OpenClaw 用**清单 + 子路径契约 + 懒 import** 达到类似目标，但隔离弱、描述性强。两者互补：DSH 的机制更硬，OpenClaw 的清单更适合"生成 UI 与迁移"。

---

## 核心机制六：Rust 与 P2P（iroh / node-host）

`crates/` 只有 74 个文件、4 个 crate——**Rust 不是"重写核心"，而是补两个 TypeScript 补不动的地方：跨平台传输与常驻执行体。**

| crate | 体量 | 作用 |
|---|---|---|
| `openclaw-node-host` | `runtime.rs` 69 KB、`sidecar_runtime.rs` 81 KB、`node.rs` 49 KB、`sidecar_protocol.rs` 44 KB、`sidecar_handshake.rs` 31 KB、`SIDECAR_PROTOCOL.md` 14 KB | 节点侧的 **Rust sidecar**：身份、重连、生命周期、双向流、自更新、sidecar 握手协议 |
| `openclaw-gateway-client` | `session.rs` 57 KB、`lib.rs` 12 KB | Rust 实现的 Gateway WS 客户端（给 Rust 侧/嵌入式用） |
| `openclaw-iroh-node` | napi-rs 绑定，`iroh = "=1.4.1"` 精确 pin | 把 iroh 端点/双向流暴露给 Node |
| `openclaw-iroh-ffi` | UniFFI，生成 Swift 71 KB / Kotlin 145 KB 绑定 | 同能力给 Apple/Android 原生 App |

### 为什么需要 P2P

`crates/openclaw-iroh-node/README.md:3-6`——这是 "**the part of iroh 1.4.1 that the OpenClaw ID tunnel needs**：bind endpoint、dial/accept、开双向流、数字码关闭"。ALPN 固定 `openclaw/tunnel/1`（`crates/openclaw-iroh-ffi/README.md:65`）。

场景证据（`docs/cli/node.md`，"Labs: OpenClaw ID tunnel targets"）：

> "An OpenClaw ID node target connects through `openclaw/tunnel/1` over iroh **instead of a LAN address, Tailscale, or SSH**." … "Missing, stale, invalid, or replayed evidence refuses the tunnel; **a failed tunnel never falls back to a direct WebSocket**."

即：手机/朋友的电脑要连回你的 Gateway，今天得靠 LAN / Tailscale / SSH 反代；iroh（QUIC + relay）让设备**不需要公网端口、不需要 VPN、不需要第三方网络**就能 NAT 穿透直连，且失败时**不静默降级到明文 WS**。

### 安全边界写得很硬

`crates/openclaw-iroh-ffi/README.md:8-12`：

> "原生 App 拥有受保护存储、enrollment、descriptor/pin 校验、node-only 会话选择、帧化、admission 等待、重连策略。这个库只接收**已经验证过的 endpoint ID**；它不是 authority，也不是 Discovery client。**没有 TCP 代理、没有 key 导出 API、没有默认 relay、没有 pkarr、没有 peer DNS 查询**。"

再加 `:115-116`：32 字节 seed 在网络 bind 之前 zeroize（成功与失败路径都做），且 bind 边界不产生 secret Debug 输出。

> 对我们的意义：若 DSH 未来要"手机连回桌面 harness"，iroh 这条路（自建 relay + 精确 pin + 不做 discovery）是现成架构答案；但它是 **Labs**（`docs/cli/node.md` 明示），说明 OpenClaw 自己也没把它当 GA。

---

## 核心机制七：密钥与安全

### 1. SecretRef：opt-in 的引用式凭据

`docs/gateway/secrets.md:12-19`：支持 additive SecretRef，凭据不必以明文进配置；**明文仍可用**，SecretRef 是逐凭据 opt-in。同时诚实声明边界：明文凭据留在 agent 可读的文件里（`openclaw.json`、`.env`、退休的 auth-profile JSON、生成的 `agents/*/agent/models.json`）时 agent 依然能读——SecretRef 只在**所有受支持凭据都迁移完且 `openclaw secrets audit --check` 干净**之后才真正降低本地暴露。

四类 provider（`docs/gateway/secrets/secretref-contract.md`）：`env` / `file` / `exec`（1Password、Bitwarden `bws`、Vault CLI、pass、sops）/ `store`（共享 SQLite 密钥库）。另有 secret egress proxy + 目标 allowlist（`secret-store-and-egress.md` 30 KB）。

### 2. 出网哨兵（sentinel）——最值得抄的机制

`docs/gateway/secrets/runtime-model.md` "Egress-time injection (sentinels)"：

- 模型凭据由 SecretRef 支撑时，在 model-auth 解析阶段铸造**进程内不透明哨兵** `oc-sent-v2.<authenticated-ciphertext>.end`。
- 于是 auth storage、stream options、SDK 配置、日志、错误对象、大多数运行时内省看到的都是哨兵，不是真凭据。
- 真正的替换发生在**请求即将离开进程之前**（guarded fetch 替换 URL/header 中的已知哨兵）。
- **未知哨兵形状直接拒绝发送**——宁可失败，也不把未解析的哨兵发给 provider。
- 解析后的值同时注册精确值日志脱敏（纵深防御）。
- 逃生开关：`OPENCLAW_SECRET_SENTINELS=off`（见该页同段）。

配套的还有 **owner 隔离 + last-known-good**：启动时按 owner（模型供应商、媒体/TTS/cron、auth profile、per-agent memory、sandbox SSH、通道账号、插件路由）独立校验；可隔离的 owner 失败 → Gateway 照常启动并标记 `configured-unavailable` + 脱敏降级告警；重载时逐 owner 校验后**原子发布快照**，失败的合格 owner 保留 LKG，变更或新增的失败 owner 变 cold；严格失败直接拒绝整次重载。目的："把密钥供应商故障挡在热请求路径之外"。

### 3. 审计与治理

- `src/security/audit.ts` 44 KB + `audit-extra.*`（37/16/14 KB）+ `audit-channel.ts` 25 KB + `audit-gateway-config.ts` 21 KB + `audit-plugins-trust.ts` 15 KB + `install-policy.ts` 17 KB；`docs/gateway/security/audit-checks.md` 41 KB。
- `.gitleaksignore` 存在但为空文件——用 gitleaks 但**不靠 ignore 清单消音**。
- 文档里有 `docs/security/THREAT-MODEL-ATLAS.md` 28 KB、`formal-verification.md` 8 KB、`network-proxy.md` 22 KB。
- **trust model 文档化**：`trust-model.md` 除了写"支持/不支持"，还专门列出"**By design 不算漏洞**"的清单（prompt injection 单独不算、localhost 部署缺 HSTS 不算、`sessionKey` 不是授权令牌、默认 Gateway 全域会话可见不是越权…）——把安全评审判例公开化，极大降低噪声报告成本。

### 4. 只认一个信任边界

`trust-model.md:14`、`SECURITY.md:5`：OpenClaw 是"for trusted operators 的本地优先 agent 基础设施，**不是对抗性用户共享一个 gateway 的多租户边界**"。且 `trust-model.md:17` 明说：`tools.sessions.visibility` 默认 `all`、`tools.agentToAgent.enabled` 默认 `true`，任何未沙箱的 agent 都能列/读/搜/发所有 agent 的会话，**含其他用户的转录**——这是"一 Gateway 一信任边界"的直接后果，不是 bug。

---

## 界面架构

- 体量：`ui/` 6,573 文件；`ui/src` 内部：**pages 2,399、components 1,224、e2e 1,105、lib 826、app 411、i18n 208、api 30、assets 57**。
- 技术栈：**Solid.js 2.0.0-rc.18 + `@solidjs/signals` + Vite 8 + TypeScript**（`ui/package.json` dependencies）。不是 React。**几乎没有 UI 框架依赖**：自研组件 + 少量原语（`@zag-js/menu|vanilla|rect-utils`），加 codemirror（编辑器）、`ghostty-web`（终端）、`@novnc/novnc`（远程桌面）、`@panzoom/panzoom`、`mediabunny`（媒体）、`markdown-it` + CJK 插件、`dompurify`、`qrcode`。
- 路由：`ui/src/app-route-paths.ts` 定义 **56 条 path**；`ui/src/pages/` 24 个页面族：`chat`、`agents`、`agents-home`、`activity`、`approvals`、`approval`、`apps`、`channels`、`config`、`connection`、`cron`、`custodian`、`dashboards`、`debug`、`device`、`devices`、`labs`、`lobsterdex`、`logs`、`meetings`、`memory-import`、`model-providers`、`about`、`cloud-workers`。
- 设置分组（同文件）：`agents / channels / connection / general / profile / communications / appearance / device / device-permissions / notifications / security / secrets / advanced / approvals / automation / mcp / memory / search / talk / infrastructure / labs / updates / model-setup / model-providers / worktrees / sessions`。
- 深链：`/approve`（审批）、`/ask`（提问）是**文档级路由**（`CONTROL_UI_DOCUMENT_ROUTE_PATHS`），通道消息可直接带链接点开——"在手机上批一个工具调用"的关键设计。
- 插件自带页面：`controlUi.entry + settingsViews`（memory-core manifest）把插件 UI 作为**独立 bundle** 挂进 Control UI，且 `activation:"settings-only"` 表示不打开设置就不加载。
- 工程质量：`ui:check-performance`、`ui:i18n:verify`、`ui:solid:inventory`、`ui:parity` 等脚本；e2e 1,105 文件。

> 与 DSH 对比：DSH 的 Web GUI 是"浏览器里第二个 Cordis 实例 + 62 个 `dsh-client-ui-*` 插件渲染成 React 树"（`vs-dsh.md`）。OpenClaw 用 Solid + **声明式 manifest 生成设置页**。若 DSH 想减少"每个 UI 插件都要写前端"的成本，`configSchema → 设置面板` 这条路径值得直接抄。

---

## 它最强的地方（5 条，带证据）

1. **多通道抽象是全行业最彻底的一份**：28 个 bundled 通道（`src/channels/bundled-channel-ids.generated.ts`）；`ChannelPlugin` 用 30+ 个可选 adapter 槽位组合而非继承（`types.plugin.ts:69-129`）；入口懒加载契约（`extensions/telegram/index.ts:5-30`）；入站是带 claim lease、attempt floor 8/age gate 24h、墓碑化的持久排空队列（`src/channels/AGENTS.md:13-30`）。**"能接 28 个平台"只是表象，真正的资产是那套投递语义。**
2. **RPC/控制平面工程做到了"一张表管全部"**：549 行核心方法规格在 `src/gateway/methods/core-descriptors.ts:19-20` 的 append-only 表里逐行声明 `name/family/scope/since/policy`，同一事实源驱动列出、鉴权、启动可用性、写限流；约 125 个 handler family 全部 `() => import()` 懒加载（`server-methods/core-handlers.ts:1,14-140`）。
3. **记忆系统是"可换引擎 + 分层 + 溯源 + 后台整合"的完整设计**：五层 tier（`memory-architecture.md:57-61`）、五条原则（`:32-45`）、闭集 provenance（`:76-92`）、dreaming 三阶段 + `maxPriorEntryLossFraction` 改写护栏（`memory-core/openclaw.plugin.json`）、单槽位可换插件（`VISION.md:117`）。它把"记忆的价值在写入路径"当第一性原理。
4. **安全有机制创新，不是口号**：出网哨兵（凭据在进程内只是 `oc-sent-v2.*`，未知哨兵拒绝发送）、owner 隔离 + 原子快照 + LKG 降级（`secrets/runtime-model.md`）、SecretRef 四 provider、gitleaks 无 ignore、`THREAT-MODEL-ATLAS.md` 28 KB、以及把"什么不算漏洞"逐条公开的 trust model。
5. **可证明的自我诚实 + 验证文化**：`AGENTS.md` 通篇是"证明必须走真实产品路径"——用户可见改动要在隔离 Gateway + 真模型 + 真通道 e2e 技能上复现（`AGENTS.md:82-83`），修 bug 必须"base 红、fix 绿"（`:84`）；`docs/maturity/scorecard.md:13,26` 自评 **50 surfaces / 280 capability areas / 68% quality / Alpha**；`src` 里 49.6% 是测试。**一个敢给自己打 Alpha 68% 的项目，可信度反而更高。**

---

## 它的短板/漏洞（5 条，带证据 —— 我们的机会）

1. **体量与认知负担已失控**：63,769 文件 / 714 MB；`src` 29,750（`agents` 5,508、`gateway` 5,664、`infra` 3,346）；`package.json` 156 KB ≈ 1000 个 script；`tsconfig.json` 18 KB；49.6% 是测试。**一个模型/新人无法在单次上下文里把握它**，任何改动都要靠"局部 AGENTS.md 纪律"兜底。→ 机会：小内核 + 生成式 + 显式边界。
2. **架构上明确放弃多租户**：`trust-model.md:14`"Not supported: one shared gateway/agent used by mutually untrusted or adversarial users"；`:17` 默认 `sessions.visibility=all` + `agentToAgent=true`，agent 之间可互读转录。共享场景只能拆进程/拆 OS 用户。→ 机会：**真正的多用户隔离**（per-user principal、会话可见性默认最小、工具授权矩阵、按用户计费）。
3. **记忆碎片化，core 不掌握语义**：同时存在 5 个记忆方向的插件（memory-core 541 / knowledge 445 / memory-wiki 120 / memory-lancedb 51 / active-memory 36），`VISION.md:117-118` 自认"今天发布多个 memory 选项，未来计划收敛到一个推荐默认"；`src/memory` 只剩 4 个文件（`root-memory-files.ts` 75 行）。后果：跨插件语义/工具/迁移不一致，用户要在"5 个半成品"里选。→ 机会：**一个默认记忆内核 + 一条明确升级路径**。
4. **成熟度自评仍是 Alpha，通道长尾"能连≠能用"**：`docs/maturity/scorecard.md:13,26`——50 surfaces、68% quality、Alpha；最好的通道 Telegram 也只有 **Beta M3 / quality 68% / coverage Unscored**（`:80` 附近）。而 channel 列表里有 `qa-channel`、`raft`、`reef`、`buzz`、`clickclack`、`tlon` 这类实验/小众项。→ 机会：**少而深**，把 3 个通道做到 GA 而不是 28 个做到 Beta。
5. **前沿依赖 + 运维耦合，学习与维护成本极高**：`package.json:2568` 要求 `node >=24.16.0 <25 || >=26.1.0`；devDeps 里 `typescript 7.1.0-dev`、`vite 8`、`tsdown 0.23`；`iroh = "=1.4.1"` 精确 pin + Rust 1.99 toolchain；自建更新/doctor/迁移/锁/备份/崩溃恢复（`docs/gateway/` 162 文件里 restart-recovery 50 KB、postgresql 86 KB、prometheus 109 KB、diagnostics 75 KB）；`AGENTS.md:80` 甚至把"Updates always work"列成产品级硬约束。→ 机会：**默认简单**（单文件状态、零外部服务、可解释失败），把复杂度做成可选。

> 附加短板（第 6 条，不计入 5 条）：**远程访问仍是门槛**。本地优先意味着要 tailscale / 反代 / SSH / iroh；`exposure-runbook.md`、`network-exposure.md` 21 KB、`trusted-proxy-auth.md` 44 KB 的存在本身说明这一步很容易配错，且 iroh 隧道还是 Labs（`docs/cli/node.md`）。

---

## 对我们 10 条可直接继承的东西

1. **通道 = 插件 + 30+ 个可选 adapter 槽位（组合优于继承）**。照 `src/channels/plugins/types.plugin.ts:69-129` 拆槽位：config/pairing/security/outbound/status/streaming/threading/message/actions/heartbeat/doctor/secrets/allowlist…；Core 只留"共享 message 工具 + action 词汇 + dispatch"。我们若接 IM，这比"写一个 BaseChannel 子类"健壮一个数量级。
2. **通道入口懒加载契约**：`defineBundledChannelEntry({ id, importMetaUrl, plugin:{specifier,exportName}, ... })`（`extensions/telegram/index.ts:5-30`）+ "热路径文件不静态拉 send/monitor/probe/login"（`channels/AGENTS.md:30-32`）。直接决定冷启动预算。
3. **append-only RPC 方法表**：一行 = `[name, family, scope, since, policy]`，同时驱动"列出/鉴权/启动可用性/写限流"（`gateway/methods/core-descriptors.ts:19-20`）+ 按 family `() => import()`（`server-methods/core-handlers.ts:14`）。DSH 现在有 Typert 控制器，加这两个机制几乎零成本，收益是全套横切能力。
4. **协议分层 + 双入口**：TypeBox schema 单一事实源 → 生成 validator；同时提供**零依赖** `frame-guards` / `version` / `client-info` 子路径给浏览器，避免为了分帧就拉全图（`packages/gateway-protocol/README.md:40-62`）；协议版本走 N-1 窗口（`version.ts:2-8`）。
5. **出网哨兵（sentinel injection）**：凭据在进程内只以 `oc-sent-v2.<ct>.end` 形式存在，出网前一刻替换，**未知哨兵拒绝发送**，解析值额外注册精确日志脱敏（`docs/gateway/secrets/runtime-model.md`）。DSH 接模型与第三方 API 可直接落地，成本不大、收益是"截图/日志/报错里永不出现凭据"。
6. **记忆分层 + 溯源 + 后台整合**：五层（AGENTS/USER/MEMORY/daily/DREAMS）+ 闭集 origin class（owner/agent/untrusted/system）+ supersession key + 晋升闸门 + "失败永不阻塞回复"（`docs/concepts/memory-architecture.md:32-92`）；再加 dreaming 三阶段与 `maxPriorEntryLossFraction` 这种**改写护栏**。
7. **插件清单声明式描述一切**：`configSchema + uiHints + configGroups` 自动生成设置页；`controlUi.entry + settingsViews + activation:"settings-only"` 挂载插件 UI；`cliCommands/commandAliases` 挂 CLI；`recommendedPrompts` 给首启引导。插件作者不写前端框架代码。
8. **doctor 迁移契约**：插件在 manifest 里**声明** `stateMigrations`（含 `phase` 与 `doctorOnly`）与 `configRepair`，由宿主统一执行、备份、可验证（`memory-core`/`telegram` manifest；`VISION.md:57-64` "配置失效的变更必须同批带 doctor 迁移"）。这解决"配置/状态演进永不卡死用户"。
9. **会话写入 fencing**：`activeWriterRunId` 声明 + 每次 append/rewrite 带 `expectedWriterRunId` 同事务校验 + SQLite 单写者队列 + 状态目录锁（`docs/concepts/agent-loop.md` 队列一节）。任何"可能有两个写者/重放"的系统都该抄。
10. **输入队列模式化**：`steer / followup / collect / interrupt` 四模式统一 channel 与 native 入口（`docs/concepts/agent-loop.md` 队列一节；`channels/AGENTS.md:7`），配合"session controller 在物理会话身份上串行化 turn"。DSH 的"用户插话/补充/打断"应当做成显式策略而不是特例分支。

**三个"别抄"**（同样是结论）：

- 别抄它的**规模**：49.6% 测试占比与 714 MB 仓库是组织级投入的结果，不是设计目标。
- 别抄它的**信任模型**：一 gateway 一信任边界在消费级产品里会立刻变成投诉（"为什么我同事能看我的会话"）。
- 别抄它的**通道长尾**：28 个通道里真正被 QA 到 Alpha 以上的只是少数；宁可 3 个 GA。

---

### 附：一句话总评

OpenClaw 的价值不在"它是一个 agent"，而在**它把 agent 与真实世界之间的每一层摩擦都做成了可插拔契约**：通道适配器、agent runtime、模型供应商、记忆引擎、密钥 provider、设备传输、插件状态与迁移。强项是接口设计与可靠性工程；弱项是体量、租户模型、以及把 28 个平台都做得半好。对我们最划算的策略是：**继承它的契约设计（1/2/3/4/5/6/7/8/9/10），换一个更小的实现内核和更严格的默认安全模型。**
