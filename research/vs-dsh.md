# DeepSeek Harness 源码剖析

> 取证方式：解包 `app.asar`（约 199MB，路径 `.../resources/app.asar`），逐包读取 `package.json` 与随包发布的 `src/*.ts` 原始源码（未压缩，可读）。
> **本文所有路径均相对 `app.asar/dsh/node_modules/@deepseek-ai/`**，行号为源码真实行号（已修正 asar 数据区 3 字节偏移）。
> 版本：dsh 全系 `0.2.2-rc.3`，cordis `4.1.0`。

## 一句话定位

**一个"没有特权的核心"的插件树产品**：338 个包目录（336 个 npm 包）里没有一个"主程序"，整个 Harness 由 99 行 YAML 行（row）拼装出的 Cordis 插件树构成；模型适配、工具注册表、会话日志、沙箱、子代理、甚至 agent 循环本身都是可被配置替换的 `Service`，浏览器端再跑第二个 Cordis 实例，把 62 个 `dsh-client-ui-*` 插件渲染成一棵 React 插槽树。

---

## 包拓扑（实际数字 + 分组表）

统计方式：遍历 `app.asar/dsh/node_modules/@deepseek-ai/` 下目录 338 个，其中 **336 个含有效 `package.json`**（`libreoffice-kit`、`libreoffice-kit-win32-x64` 为随包二进制，无发布清单）。按最长前缀归组：

| 组 | 数量 | 职责 | 代表包 |
|---|---|---|---|
| `dsh-client-ui-*` | **62** | 浏览器 UI 插件，每个=一个 npm 包+一个 Cordis 客户端插件 | `dsh-client-ui-chat`(141 文件)、`-conversation`(110)、`-sidebar-documentpreview`(109) |
| `dsh-tool-*` | **29** | 模型可见工具（schema+执行） | `dsh-tool-fs`、`-bash`、`-subagent`、`-workflow`、`-executor-ptc` |
| `dsh-experimental-*` | **28** | 实验特性/可选 bundle | `dsh-experimental-inspector`(942 文件)、`-liveshare`(114)、`-client-ui-forge`(102) |
| `dsh-session-*` | **24** | 会话日志、格式迁移(v0→v4)、投影、查询、标题 | `dsh-session`、`-persistence-jsonl`、`-query-sqlite` |
| `dsh-host-*` | 9 | Host 侧宿主能力（webserver、目录选择、前端静态） | `dsh-host-webserver`、`-frontend-static` |
| `dsh-api-*` | 9 | Host↔Client 的 RPC 控制器（Typert Remote） | `dsh-api-session-controller`(97)、`-gateway`、`-workspace-controller` |
| `dsh-client-*` | 8 | 前端基础设施（非 UI）：连接、模块加载、HMR、语言、快捷键 | `dsh-client-modules`、`-connection`、`-hmr` |
| `dsh-agent-*` | 7 | Agent 接口/循环/预设/团队 | `dsh-agent`、`-loop`、`-preset`(58)、`-team`(36) |
| `dsh-util-*` / `dsh-llm*` / `dsh-plugin-*` / `dsh-web*` | 各 6 | 工具函数 / 模型接入 / 插件市场 / Web 壳 | `dsh-llm`(42)、`dsh-llm-deepseek`、`dsh-plugin-manager`(58) |
| `dsh-fs*` / `dsh-compaction*` / `dsh-sandbox*` / `dsh-skill*` / `dsh-sdk-*` / `dsh-command*` | 各 4–5 | 文件系统 seam、上下文压缩、沙箱、技能、SDK、人类命令 | `dsh-fs-sandbox`、`dsh-compaction-basic`、`dsh-sandbox-windows-acl` |
| 其余（≤3 个/组） | 111 | 子代理、MCP、goal、jobs、schedule、终端、凭据、存储、附件、persona 等 | `dsh-subagent`(60)、`dsh-mcp-client`(40)、`dsh-goal`(28) |

单点包（只此一个）：`dsh`(514，CLI 入口)、`dsh-base`(8，含 21KB `cordis.patch.yml`)、`dsh-system-prompt`、`dsh-chunked-list`、`dsh-token-meter`(38)、`dsh-hmr`、`dsh-persona`、`dsh-harness-dev-context`、`dsh-office-kit`、`cordis`(14)/`cordis-plugin-*`(4)/`cosmokit`/`schemastery`。

**规模画像**：`dsh` 包 `docs/` 下自带 253KB `config-catalog.md`、366KB `persistence-catalog.md`、111KB `tool-catalog.md`（77 个 `###` 工具条目）、71KB `capability-seams.md` —— 文档本身即"能力清单"。

---

## 架构分层图（ASCII）

```
┌ Electron main / Node CLI ────────────────────────────────────────────────┐
│ dsh/src/profile-boot.ts        profiles: web / headless / sdk /           │
│                                sdk-minimal / acp / desktop                │
│        ↓ 依次叠加 patch 层                                                │
│ cordis-plugin-loader (EntryTree)  ← dsh-base/cordis.patch.yml (99 rows)   │
│        ↓                            + 各 bundle patch + 用户 patch        │
│ ┌ Cordis Context (Proxy) ──────────────────────────────────────────────┐  │
│ │  Service 注册表(ctx.<key>) │ 5 模式事件总线 │ Fiber 生命周期/effect   │  │
│ │  ── Host 服务层 ─────────────────────────────────────────────────    │  │
│ │  sessions(llm) tools agents systemPrompt subagents agentTeams …      │  │
│ │  ── Typert Remote ───────────────────────────────────────────────    │  │
│ │  api-gateway + api-*-controller（SessionController 等 9 个控制器）    │  │
│ └──────────────────────────────────────────────────────────────────────┘  │
│ dsh-host-webserver → HTTP + SSE(/plugins/events)                          │
└───────────────────────────────────────────────────────────────────────────┘
                    ↓ window.__DSH_BOOT__（合成图，非 HTML 注入）
┌ 浏览器：第二个 Cordis 实例 ──────────────────────────────────────────────┐
│ dsh-client-modules（懒加载 CommonJS 表）→ 62×dsh-client-ui-* 插件        │
│ ctx.slots（SlotMap 声明合并）→ dsh-client-ui-renderer → React 树         │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 一、Cordis 插件机制

**1）Service：构造即注册。** `Service` 基类在构造时调用 `ctx.reflect.provide(name, self, check)`，因此"注册"和"依赖注入"是同一个动作，随所属 Fiber 卸载自动撤销 —— `cordis/src/service.ts:42-59`。上下文本身是 Proxy：`new Proxy(this, ReflectService.handler)`，服务解析全部走 proxy 拦截（`cordis/src/context.ts:74`，root fiber 在 `:77`）。

**2）声明依赖用 `inject`，加载顺序由"服务是否就绪"驱动，而不是 boot 顺序。** `ctx.inject(deps, cb)` 实质是 `ctx.plugin({ inject, apply: cb })`（`cordis/src/registry.ts:300-302`）；`ctx.plugin` 创建 Fiber 并把 `Inject.resolve(plugin.inject)` 传入（`:316-330`）。Fiber 有六态 `PENDING/LOADING/ACTIVE/FAILED/UNLOADING/DISPOSED`（`cordis/src/fiber.ts:148-153`），依赖缺失就停在 PENDING。

**3）注册即副作用，必须可逆。** `fiber.effect(execute)` 返回 disposer（`cordis/src/fiber.ts:423-425`），而 Fiber 自身的销毁被托管为父 fiber 的一个 effect（`:271`）；`assertActive()` 防止向已卸载上下文注册（`:357`）。这是"插件能热插拔"的根本，不是靠约定。

**4）事件有 5 种派发语义，是公开契约。** `DispatchMode = 'emit'|'parallel'|'serial'|'bail'|'waterfall'`（`cordis/src/events.ts:31`）；`on()` 支持 `prepend` 与 `global`（`:113-115`），分发时按 Context 过滤器筛监听者（`:168-170`）。Waterfall 是"环绕中间件"：必须 `next()` 才委托，否则短路 —— 整个 Harness 的拦截/策略都建立在这上面。

**5）加载器：一行配置 = 一个插件。** `Loader extends EntryTree`，作为 `loader` 服务注册（`cordis-plugin-loader/src/index.ts:77,102`）；它把 `internal/config` 改成"先求值配置表达式再提交"（`:104-110`），把 `internal/commit` 变成"写回 entry.options 并持久化"（`:112-120`），并监听 `internal/plugin` 处理自卸载 → 把 entry 标记 `disabled` 写回配置（`:128-174`）。真正的加载在 `Entry._init()`：`await this.parent.tree.import(this.options.name)` 动态 import 模块名 → `registry.plugin(plugin, options.config)`（`cordis-plugin-loader/src/config/entry.ts:225-238`）。

**6）插件行（row）的字段**：`{ id, name(模块说明符), config, disabled, inject }` —— `config/entry.ts:10-23`。组合是"层叠 patch"：基础层 99 行 `- id: …  name: '@deepseek-ai/dsh-…'  config: …`，`disabled` 支持 `!!js` 表达式（如 `plugin-manager` 行 `disabled: !!js "!ctx.get('profileContext')"`，`dsh-base/cordis.patch.yml`）。后层按 id 整体替换 config，last write wins（同文件头注释）。

**7）隔离与拦截**：`ctx.isolate(name, label)` 给子树独立服务作用域（`cordis/src/context.ts:121-125`），`ctx.intercept(name, config)` 给子树注入服务级配置（`:140-146`）。这正是"同一进程里一个会话用 A 模型/沙箱、另一个用 B"的实现基础（`dsh-persona` 文档明确要求 service row 必须带 `isolate` realm）。

**8）插件安装（运行时）**：`dsh-plugin-manager` 用 pnpm 操作 profile（`dsh-plugin-manager/src/index.ts:31` 引入 `runProfilePnpm`），失败回滚 `package.json`/`pnpm-lock.yaml`（`:98 RESTORED_FILES`），受 `dsh-official-bundles` 的 `PROTECTED_PLUGINS` 约束（`:28`）。即：**装插件 = 改 profile 的依赖 + 写 patch 行 + 重载 Loader 条目**。

---

## 二、agent 执行循环

**结构**：`AgentLoop extends Service implements AgentFactory`（`dsh-agent-loop/src/index.ts:290`），具体的 Agent 是 `ReactLoopAgent`（`dsh-agent-loop/src/agent.ts:112`），入口 `kick()` → `while (await this.turn()) {}`（`agent.ts:274-277`）。

**一次 turn**（`agent.ts:333-439`）：
1. `session.append('turn/start')`（`:342`）；
2. 循环调 `preStep(target, {turn, step})`（`:289-323`）：`tools.resolve()` 拿本步工具集（`:299`）→ `systemPrompt.assemble()` 组装提示词（`:301`）→ 触发 **`agent/pre-step` waterfall**，监听者可 `reject` 或 `enter(messages)`（`:303-313`）；默认分支把 runtime-context 追加为一条 user 消息（`:306-311`）；
3. 空消息且是首步 → 直接 `turnEnds={kind:'completed'}` 且不消耗模型调用（`:363-366`）；
4. `session.append('step/start')`（`:367`）→ `step(decision)`（`:441`）；
5. 步结束若 `turnEnds` 已定且 `inbox.nextStep` 为空 → 触发 **`agent/turn-stopping` serial**（`:402`），然后 `turn/end`（`:429`，`finally` 里保证必写）。

**一步 step**（`agent.ts:441-617`）：
`prepareRequest`（`:620`，内含 `agent/request` waterfall `:637-640`）→ `llm.prepareCall(proposedConfig, signal)` 绑定适配器（`:651`）→ 提交 `system/message`/`user/message`（`:465-484`）→ `buildRequest` → `preparedCall.stream(request)`（`:497`）逐 chunk 推给 `agent/assistant-stream`。

**继续/停止条件（核心）**：
- 命中 `max-tokens` → 返回 `{kind:'max-tokens'}` 且**粘住**，后续正常步不能把 turn 结果降级（`:590`、`:374-380`）；
- 无 tool-call → `{kind:'completed'}`（`:593`）；
- 有 tool-call → `tools.execute(...)`，若 `result.concluded` 为真则 completed，否则返回 `null` 表示"还欠一次模型请求"，`turn()` 的 while 继续下一步（`:596-604`）；
- 工具调用还会把 `additionalContexts` 追加进 `next-step` inbox（`:600-603`），这是"工具反向给模型塞上下文"的通道。
- 结束原因类型化：`TurnEndReasonMap` 含 `aborted/blocked/completed/max-tokens/error`（`dsh-session/src/types.ts:206-238`），插件可合并扩展（`:237`）。三态映射：reject→`blocked`（agent.ts:355）、取消→`aborted`+cause（`:412`）、异常→`error`（`:419`）。

**中断**：每 turn 新建一个 `AbortController`（`agent.ts:434`），每个关键点 `signal.throwIfAborted()`；`cancel(cause, opts)` 在 `agent.ts:192`。取消时若已流出内容，落成 `interrupted: true` 的 `assistant/message`，否则落 `assistant/attempt`（`:509-538`）——**失败/取消也是可回放的持久事实**。

**重试**：`agent/request-error` waterfall（`:554-565`），只有监听者返回 `{kind:'retry'}` 才 `continue`（`:567-570`）；重试在同一 step 内重新 prepareCall 并复用已渲染的组装结果，不重复 pre-step 与 user 消息提交。

**输入队列**：`send/followup/steer/inject` 四个入口（`agent.ts:171-190`）写同一个 inbox（`inbox.ts`），`next-step` 与 `next-turn` 两个目标；每一步 claim 一次（`:294`）。这解释了"steering 在当前步之后生效"。

**并发上限**：单步并行安全工具调用默认 **10**（`dsh-agent-loop/src/constants.ts:6 DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10`），作为 `volatile` 配置可热改不重启（`index.ts:295`）。

---

## 三、工具系统

**先纠一个常见误读**：`dsh-agent-tool-presentation` **不是 schema 格式**，而是"把工具以什么形态呈现给模型"的选择器（`native` 每工具一个 schema vs `ptc` 只给 `run_code`+生成 SDK），且已标记 deprecated —— `dsh-agent-tool-presentation/src/index.ts:4,19,33,49,52`。

**真正的 schema 定义**在 `dsh-tools`：
- 参数用类型化 DSL `ParameterSchemaSpec`（`dsh-tools/src/schema.ts:104`），编译成 JSON Schema（`:450`）并做校验（`:479`）；
- `defineTool({ name, description, parameters, output:{ schema, presentationMeta?, render? }, … })`（`:484-492, :555`）——**输出也要 schema**，成功值必须符合 `output.schema`（`contracts.ts:17-19`）；
- 模型只看到白名单字段：name/description/parameters（`contracts.ts:64-70` 明确 `timeoutMs` 绝不下发模型）；
- `ToolDefinition extends ToolSchema` + `execute(args, exec): Promise<unknown>`（`contracts.ts:27-40`），可选 `timeoutMs`（由 `dsh-tool-call-timeout-policy` 作为 `tools/execute` wrapper 实现）与 `isConcurrencySafe(args)`（`contracts.ts:84`，决定排队策略）。

**渲染意图是类型化的**，不是让 UI 猜：`ToolCallKind = read|edit|delete|move|search|execute|fetch|other`（`dsh-tools/src/presentation.ts:15`）；`ToolCallView = Generic|Terminal|Diff`（`:46`）；`ToolResultView` 6 种（`:140`）。工具作者声明一次，Web/CLI 各自渲染。

**注册与作用域**：`ToolsService.register(definition, options)`（`dsh-tools/src/index.ts:128`）；`run_code` 是保留名，注册即报错（`:145-146`）；`resolve()` 按 agent 作用域求值本步工具集（`:264`）；`schemas()` 只投影白名单（`:316`）；`restrict()` 必须挂在 `agent.ctx` 下（`:162` 否则报"全局限制会屏蔽所有 agent"）；`guard()` 是单调执行守卫（`:384-396`）；`setExecutor()` 允许换执行器（native / PTC，`:325`）。

**执行管线**：`tools/pre-execute` waterfall → `tools/execute` wrapper → 工具体 → `tools/post-execute` waterfall（`dsh-tools/src/pipeline.ts:201/307/496`）；取消在两个方向都被融合（`:737-761`），未启动的调用会合成"已取消"结果以保证回放连续（`pipeline.ts` 头注释与 `batch.ts:8`）。

**批调度**（`dsh-tools/src/batch.ts`）：头注释即规格 —— "Exclusive calls form barriers; parallel calls use a bounded rolling pool and are reclassified before start"（`:2-3`）；`executeToolBatch`（`:50`），有界滚动池 `fillPool`（`:186-200`），`inFlight` 映射（`:152`），结果按**模型顺序**提交（`:146-147`），中途出现的 exclusive 调用会形成下一道屏障（`:109-115`）。

**沙箱**：`SandboxMode = read-only | workspace-write | danger-full-access`（`dsh-sandbox/src/index.ts:38`），一次调用的完整策略是 `SandboxExecutionPolicy`（`:48`），宿主能力分级 `SandboxEnforcement = full | partial`（`:76`），升级（escalation）走"更宽策略的新调用 + 审批"（`:82-83`）。Bash 执行器**不自己实现隔离**，而是把精确 argv 包给 `ctx.sandbox`（`dsh-bash-sandbox/src/index.ts:2-3,45-46`，`inject = ['subprocess','sandbox','sandboxPolicy']`）。Windows 后端是真实实现：受限令牌 + 每工作区写 SID + DACL 授予（`dsh-sandbox-windows-acl/src/index.ts:2-16,55-61`）。

**工具规模**：29 个 `dsh-tool-*` 包 + 其它包里注册的工具（plugin_manager、plugin_market、list_mcp_resources、office_*、stagehand_*、propose_action 等），`docs/tool-catalog.md` 里共 **77** 个工具条目。

---

## 四、子智能体与团队

**抽象**：子代理是 provider seam。`SubagentProvider` 的注册名就是 `spawn`/`fork`/`acp` 之类（`dsh-subagent/src/types.ts:321-322`），能力声明在 `SubagentCapabilities`（`:132`），父子关系、深度、生命周期由 `SubagentManager` 统一管（`dsh-subagent/src/manager.ts:139`；`startLocal` 本地子 Agent `:308`，`startExternal` 外部 provider `:429`）。

**两个内置 in-process provider**：
- `spawn`：全新子 Agent（`dsh-subagent-spawn-in-process/src/index.ts:17,38`，能力全开含 `depthLimit`）；
- `fork`：**用父会话日志的前缀做 seed**，子代理继承父的对话上下文，seed 截到最后一个 `turn/end`（`dsh-subagent-fork-in-process/src/index.ts:2-7,21,31`）。

**递归预算**：`delegationDepthOf()` 取 `session.header.delegationDepth` 与运行时 options 的 `max`（**单调不可降**，防止 resume 后当作顶层再递归）—— `dsh-subagent/src/depth.ts:28-36`；默认深度上限 **1**（`dsh-tool-subagent/src/index.ts:77` "the current Host subagent depth setting (default `1`)"），若 provider 无 `depthLimit` 能力而配置了数值上限，**挂载即失败**（`:169-172`）。

**工具层**：`dsh-tool-subagent` 用 `config.provider` 选一个 provider（`:46-47`），工具名默认 `subagent`（`:84`），schema 会按 provider 是否继承上下文改写描述与 prompt 参数说明（`:116-137`）；`dsh-tool-subagent-control` 提供消息/中断/子代理发现（对应 `manager.ts:194 interrupt`、`:567 sendMessage`、`list-children.ts`）。

**团队 = 根会话共享任务板 + 消息，不是角色化多智能体**：`TeamService extends TypertRemoteService`，注入 `agents/sessions/sessionPersistence/sessionProjections/subagents`（`dsh-agent-team/src/index.ts:46-47`），任务上限默认 256（`:32`）；`TeamTaskBoard`（`task-board.ts:29`）实现 `create/get/list/claim/release/edit/set_dependencies/complete/reopen/reassign/delete`，**用 revision 做 CAS**（`:128-130`），`claim` 要求无 owner 且未被阻塞（`:142-150`），`writeScopes` 只是"建议性写入范围"（`:74`）。模型侧对应 4 个工具 `team_task_create/list/get/update`（`dsh-tool-agent-team/src/index.ts:118-209`）。

**脚本级编排（比 subagent 更强的一层）**：`WorkflowEngine` 服务定义（`dsh-workflow/src/index.ts:157`），脚本里可用 `agent()/parallel()/pipeline()/phase()/log()`（事件契约 `:51-96`）；实现在 `dsh-workflow-ptc`：并发 `agent()` 上限默认 `min(16, cores-2)`、单次 run 总 agent 调用上限 1000、`parallel()` 单次最多 4096 项、脚本同步片段 5s 超时（`dsh-workflow-ptc/src/index.ts:36-43`），跑在沙箱化 Node 进程里（`:125-130`）。

---

## 五、记忆与上下文

**结论：没有跨会话记忆引擎（未找到证据）。** 全库 336 个包里没有 memory/知识库类包；全局 grep `MEMORY.md|cross-session memory|long-term memory` 只命中三处：`docs/user/guide/mcp-memory.md`（教用户接**第三方** MCP memory server，见 `dsh-mcp-client/README.md:175`）、`dsh-tool-ralph` 明确写"共享工作区就是长期记忆、跨 round 只有一份有界报告"（`dsh-tool-ralph/src/index.ts:157,180`）、以及 session 的"in-memory store"字样。**也没有 embedding/向量检索**（grep `embedding|vector search|RAG` 无代码命中）。

它实际有的四层"记忆替代品"：

1. **静态指令文件**（近似 memory 的只读部分）：`dsh-agent-instructions` 在用户级（harness home + 共享 agents 根）与项目级按候选路径发现指令文件并读取（`dsh-agent-instructions/src/files.ts:83-95,67-68`），上限与摘要见 `digest.ts`。
2. **会话内 token 压力计量**：`TokenMeter` 服务（`dsh-token-meter/src/index.ts:87`）聚合 provider usage 去重（`:56-63`），投影出 `contextPressure/contextWindow`（`:122-126`）。
3. **压缩（compaction）**：`ctx.compaction` 是 Service Definition，provider 决定"何时压缩、把一段历史替换成摘要节点"（`dsh-compaction/src/index.ts:2-3`），触发原因只有两种 `pressure | context-overflow`（`:32`）。默认后端 `dsh-compaction-basic` 用 `ctx.tokenMeter` 判压、用 LLM 生成结构化摘要并用 `<compacted-summary>` 标签包裹成 checkpoint 节点（`dsh-compaction-basic/src/summarizer.ts:22-33`；挂点在 `agent/pre-step` `:157` 与 `agent/request-error` `:213`）；另有 `dsh-compaction-tool-result-pruner`（裁工具结果）与 `dsh-compaction-image-offload`（图片外移）作为可选前置。
4. **跨会话检索（≠记忆）**：`dsh-session-query-sqlite` 用 SQLite FTS5 给历史会话建全文索引（`src/index.ts:2`），工具 `dsh-tool-session-query` 提供 search/trace/events；`dsh-experimental-session-search` 另做实验性搜索。这是"翻旧账"，不是"记住了什么"。

**代价**：压缩是**有损且不可逆**的——原文被一段摘要替换，模型之后只能看到摘要。

---

## 六、界面插件化（dsh-client-ui-* 全表）

**机制**：每个 UI 包都是"双面包"——`package.json` 里声明 `dsh.client`（浏览器入口 + 客户端依赖图），宿主侧 `dsh-client-modules` 扫描 Loader 里所有声明 `dsh.client` 的包，**按模块图顺序合成 `window.__DSH_BOOT__`** 并逐个提供 bundle（`dsh-client-modules/src/index.ts:2-27`，入口类型 `WebBootEntry/WebBootGraph` 在 `src/client/manifest.ts`）。浏览器里是"懒加载 CommonJS 表"：加载即注册工厂，materialize 时同步 `require` 平台模块与已声明动态依赖（`docs/subsystems/web-client.md` 的 Browser boot 段）。热更新由 `dsh-client-hmr` 完成：**每 500ms stat-poll 所有 bundle**，变化经 `clientModules.rebuilt(id)` 通告，并通过 `/plugins/events` 的 SSE 广播给浏览器（`dsh-client-hmr/src/index.ts:2-3,36,149`）。UI 组合用**类型化插槽**：`ctx.slots.register()` 贡献、`ctx.slots.inject(key, cb)` 跟随宿主生命周期，只有 `root` 由 Cordis service 直接渲染（`docs/subsystems/slots.md`）；本 asar 未单独发布 `dsh-client-ui-slots` 包，实现落在 `dsh-client-ui-renderer/src/client/{registry.ts,scoped-slots.tsx,app.tsx}`。

| # | 包（省略 `dsh-client-ui-`） | 职责 |
|---|---|---|
| 1 | account-notifications | 账号通知与本地化刷新 |
| 2 | action-cards | 回答下方动作卡（`propose_action`） |
| 3 | agent-preset | 预设三面：默认/本会话座位/组合编辑器 |
| 4 | agent-team | 共享团队任务板 |
| 5 | approval | 审批编辑器接管（Remote Event waterfall） |
| 6 | attachment | 输入/消息/轨迹的图片附件渲染 |
| 7 | brand-official | 官方品牌图与首页背景 |
| 8 | chat | Chat 目标、节点定义、渲染器、详情面 |
| 9 | commands | 斜杠命令面板与 popupSelect |
| 10 | context-menu | 类型化、可扩展的右键菜单 |
| 11 | conversation | 会话外壳/输入框/队列/视图导航 |
| 12 | cordis | `cordis_define` 动态插件卡与启停开关 |
| 13 | creation-recommendations | 创作推荐卡（位置/进度/Undo） |
| 14 | deliverables | 变更文件卡、交付卡、可点开文件引用 |
| 15 | directory-picker-browse | 应用内目录浏览 |
| 16 | directory-picker-native | 原生目录选择（Desktop/Host OS） |
| 17 | entry-customization | 侧栏/视图/右栏条目自定义与新建插件 |
| 18 | file-actions | 原始文件保存与图片剪贴板 |
| 19 | file-drag | 应用自有文件拖拽 |
| 20 | goal | 目标条（composer 上方，读 goal 投影） |
| 21 | input-trigger | `/` 与 `@` 触发管线与候选菜单 |
| 22 | jobs | 会话头后台任务列表与流式记录面板 |
| 23 | layout | 三栏 AppFrame + `ctx.layout` 导航/面板服务 |
| 24 | message-feedback | 逐条赞/踩与反馈对话框 |
| 25 | model-selection | 模型选择（目录+投影+selectModel） |
| 26 | open-in-app | 用外部应用打开目录/预览文件 |
| 27 | permission-presets | 权限预设（新建默认 + `/permission`） |
| 28 | plan | 计划模式控件与持久计划卡 |
| 29 | plugin-manager | 插件面板：安装/启停/重试/组合 |
| 30 | plugin-market | 市场发现页（索引浏览与安装） |
| 31 | plugin-recommendations | 官方插件推荐卡 |
| 32 | reference | 统一 `@file`/`@session` 引用源 |
| 33 | renderer | React 插槽绑定、`ctx.uiRenderer`、应用根 |
| 34 | schedule | 定时任务管理页与提醒目录 |
| 35 | secret-mask | 已发送文本中的凭据掩码 |
| 36 | session | SessionController 的 React 适配与插槽源 |
| 37 | settings | 设置域基座与插槽类型契约 |
| 38 | settings-account | DeepSeek 登录与账单跳转 |
| 39 | settings-agent-loop | 工具并行上限设置 |
| 40 | settings-general | 通用设置、引导、欢迎页 |
| 41 | settings-models | 模型设置与凭据 |
| 42 | settings-plugin-inventory | 只读 Cordis Loader 清单 |
| 43 | settings-plugins | 内置插件设置区 |
| 44 | settings-session-log | 会话日志上传开关 |
| 45 | settings-shell | 命令超时与单流输出上限 |
| 46 | settings-subagent | 递归深度、并发、可选模型 |
| 47 | settings-web-search | 搜索/抓取 provider 与结果数 |
| 48 | shortcuts | 快捷键参考/录制/本地偏好 |
| 49 | sidebar | 会话多级树、搜索、分组、状态点 |
| 50 | sidebar-browser | 右栏沙箱化网页标签 |
| 51 | sidebar-documentpreview | Office/MD/代码/图片/PDF/HTML 预览 |
| 52 | sidebar-files | 工作区文件页与目录树 |
| 53 | sidebar-right | 右栏停靠状态、面板与导航服务 |
| 54 | sidebar-terminal | 右栏交互式 shell 标签 |
| 55 | skill | 技能引用与技能工具行 |
| 56 | subagent | 子代理目录、续跑路由、`@` 引用源 |
| 57 | theme | 主题：宿主预置调色板、明暗/系统、`--dsw-*` token |
| 58 | tool | 工具调用树渲染与按工具键控的呈现插槽 |
| 59 | trajectory | 事件账本、耗时概览、工具结果实时查看 |
| 60 | user-questions | `ask_user_question` 与计划评审 UI |
| 61 | workflow-run | workflow 运行节点与成员展开 |
| 62 | workspace | 工作区选择器（侧栏 + 空态插槽） |

---

## 七、会话与持久化

**事件溯源是唯一事实源**：`Session.append` 追加事件（`dsh-session/src/index.ts:858`，批量 `:809`），`deriveMessages()` 从日志投影出模型历史（`:1079`），`SessionStore` 是服务（`:1144`）。事件类型表本身可被插件合并扩展（`types.ts:206` 的 `TurnEndReasonMap` 注释即"plugins extend it by merging"）。

**内存表示**：`dsh-chunked-list` 用 64 值一块的不可变链表，追加最多复制一个 chunk，遍历 O(N/64) 暂存（`dsh-chunked-list/src/index.ts:8,26-36`），并有递归 zod schema 校验 checkpoint（`:52`）——为长会话的"追加+快照"取平衡。

**落盘**：JSONL 后端"每 session 一个目录、不可变 generation 文件、header + 连续事件"（`dsh-session-persistence-jsonl/src/index.ts:2-6`），默认 zstd 压缩（`:69,85-88`），有写租约（`lease.ts`）和 worker 内迁移校验（`:48`）；generation 文件名规范在 `format.ts`（`generationLogFilename`，`:40-42` 导出）。文档口径：v0 用 `session.jsonl[.zstd]`，v1+ 用 `session.vN.jsonl[.zstd]`，已提交的 generation 永不改名/覆盖/删除，相邻迁移链一次性 compose（`docs/architecture.md` 的 Session log 段）。

**格式迁移代际**：`dsh-session-format` + `-catalog` + 四个 `vN-to-vN+1` 包（v0→v4），共 6 个 `dsh-session-format*` 包。**这既是"可演进"的优点，也说明契约还在变。**

**对外 RPC**：`SessionController extends TypertRemoteService`（`dsh-api-session-controller/src/index.ts:135`），方法集覆盖 `list/search/create/prompt/cancel/page/events/observeEvent/observeProjections/state/observeState/wait/follow/projections/fork/rename/selectModel/attachment/updateQueue`（`:282-651`）。传输层：`dsh-api-gateway` 做 Typert 网关，`dsh-client-connection` 是"Host HTTP bridge for browser-client RPC"（`dsh-client-connection/src/index.ts:1`），`dsh-host-webserver` 提供 HTTP/SSE。**读模型走 projection**：`dsh-session-projection(+cache)` 注册投影单元，载体通过 `snapshot()` 读客户端视图，业务服务只暴露业务方法（`docs/architecture.md` 的 Projection seam 段）。

---

## 八、它最强的地方

1. **没有特权核心，产品是"配置出来的"。** 99 行 base patch（`dsh-base/cordis.patch.yml`）+ bundle patch + profile patch + 用户 patch 逐层覆盖，按 id 替换整行 config；文档原话："There is no privileged core to patch"（`dsh/docs/architecture.md` 开头）。竞品要改 agent 循环得 fork，它改循环 = 换一个实现 `AgentFactory` 的插件。
2. **日志即真相，"模型见过的"必可从日志重建。** `deriveMessages()`（`dsh-session/src/index.ts:1079`）+ 每条 `assistant/message` 内嵌产生它的紧凑流 + 失败的 `assistant/attempt` 也持久（`dsh-agent-loop/src/agent.ts:581-588`）。于是 fork、resume、审计、回放、遥测全部免费获得。
3. **事件/中间件设计让"策略"和"机制"彻底分家。** 三域事件（session 落盘 / agent 实时 / capability 策略）+ 5 种派发（`cordis/src/events.ts:31`）+ 三条工具 waterfall（`dsh-tools/src/pipeline.ts:201/307/496`）：审批、超时、重试、压缩、重复调用提醒都是监听者，不改循环一行。
4. **能力 seam 抽得深且一致**：`ctx.fs`、`ctx.subprocess`、`ctx.sandbox`、`ctx.llm`、`ctx.sessions`、`ctx.subagents`、`ctx.tools` 都是"定义-提供者-消费者"三件套（`docs/capability-seams.md`，71KB 的能力图）。所以 `dsh-subagent` 的 provider 可以是同进程子 Agent，也可以是另一个产品（`acp`），工具层零改动。
5. **双形态工具呈现（native / PTC）**：PTC 模式下模型只见 `run_code`，其它工具以**自动生成的 TypeScript/Python SDK** 形式在程序内调用（`dsh-tool-executor-ptc/src/index.ts:16,40-50,99-102`；SDK 生成器 `ts-types.ts`/`py-types.ts`）。这是同类产品里少见的"把工具变成库"的做法，且嵌套调用仍走原生并发调度。
6. **可自省**：`cordis_inspect_list` / `cordis_inspect_query` 两个只读工具直接查询运行中的 Cordis 服务/事件/工具 schema（`dsh-tool-cordis/src/index.ts:23,44`），配套 `dsh-experimental-inspector`（942 文件，host/client/worker 三端，`src/index.ts:39-71`）。agent 能读自己的运行时 API——这让"用 DSH 开发 DSH 插件"闭环。
7. **多入口一套内核**：`web/headless/sdk/sdk-minimal/acp/desktop` 六个 profile 共用 `dsh-base`，Typert 一份方法定义供 Host RPC、浏览器、远程复用（`dsh-typert-{protocol,loader,registry}` + `dsh-api-gateway`）。

---

## 九、它的短板/漏洞（我们的机会）

1. **没有跨会话记忆（最大空档）。** 无 memory 包、无 embedding（grep 无代码命中），长期上下文只有静态指令文件（`dsh-agent-instructions/src/files.ts:83-95,67-68`）与 FTS5 翻历史（`dsh-session-query-sqlite/src/index.ts:2`）。它自己也承认"工作区才是长期记忆"（`dsh-tool-ralph/src/index.ts:157`）。**机会：持久记忆层（事实/偏好/实体/决策），带写入时机、去重合并、遗忘与置信度**——这正是"越用越懂你"与"每次从零开始"的分水岭。
2. **压缩 = 有损摘要，丢原文。** `dsh-compaction-basic` 让 LLM 写 `<compacted-summary>` 并替换整段历史（`dsh-compaction-basic/src/summarizer.ts:22-33`），模型之后只能看到摘要，细节不可回溯。**机会：分层上下文——摘要归摘要，原文按需检索取回（引用式而非重写式）。**
3. **上下文是"常驻推入"，不是"按需取用"。** 组装发生在每步 `preStep`（`dsh-agent-loop/src/agent.ts:289-323`），是否压缩由 token 压力/溢出触发（`dsh-compaction-basic/src/index.ts:157,213`）而非语义相关性。**机会：检索式上下文（按 query 取片段+来源），同 token 预算下信息密度更高。**
4. **扩展门槛太高。** 加一个 UI 功能 = 新建 npm 包 + `dsh.client` 双面 + SlotMap 声明合并 + 沿依赖图注入（案例：`dsh-client-ui-chat/package.json` 的 `dsh.client.inject` 列了 13 个包）；加一个工具 = `parameters` DSL + `output.schema` + presentation + render 四件套（`dsh-tools/src/schema.ts:484-492`）；62 个 UI 包平均 40+ 文件。**机会：单文件/单函数的扩展点（声明即插件），把"平台工程"降为"写一个文件"。**
5. **多智能体仍是"任务板 + 消息"，没有真正的协作协议。** `TeamService` 就是根会话的任务板（`dsh-agent-team/src/index.ts:46-47`），claim 靠 revision CAS 与"没被占"（`task-board.ts:128-150`），深度默认 1（`dsh-tool-subagent/src/index.ts:77`），没有角色、投票、预算协商、共享工作记忆。**机会：角色化 Agent Team + 共享内存 + 冲突消解 + 资源预算，这才是"团队"而非"任务队列"。**
6. **体量与部署成本高。** 336 个包、asar ≈199MB、`libreoffice-kit-win32-x64` 单包 190MB；桌面端与 npm CLI **各自一套包管理与锁文件**（`docs/architecture.md` Desktop 段："keep packages, activation, and lockfiles separate"）。**机会：薄内核 + 能力按需下载，启动/安装成本可差一个数量级。**
7. **契约还在漂移。** 会话格式已迭代 5 代（v0→v4，6 个 format 包）；`dsh-agent-tool-presentation` 已被 deprecated（`src/index.ts:4`）；沙箱能力分级允许 `partial`（`dsh-sandbox/src/index.ts:76`），意味着跨平台行为不完全等价——**这给"一次写对、契约稳定"的后来者留了 compatibility 优势。**

**未找到证据的项**（据实说明）：① 向量/语义记忆与 RAG 链路；② 容器/microVM 沙箱后端（`dsh-sandbox/src/index.ts:3` 只说"Containers, microVMs, and remote execution replace the …"，是 seam 留白，未见实现包）；③ 任何跨会话的偏好学习或用户画像持久化（`dsh-personalized-recommendations` 等内容包未见读写用户画像的服务）；④ 独立的 `dsh-client-ui-slots` 包（文档引用，本 asar 未发布，实现在 renderer 内）。
