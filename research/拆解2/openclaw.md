# openclaw 拆解（可抄实现口径）

> 仓库：`D:\refs\openclaw\openclaw-main`（git 目录名 openclaw-main）
> 规模：63,769 文件 / pnpm monorepo / TypeScript 主体 + SolidJS UI + 少量 Rust
> 版本：`package.json:3` → `"version": "2026.11.3"`
> 注意：本仓库体量极大（`extensions/` 188 个、`src/plugins/` 1,494 个文件），
> 本报告只走「与我们卡住的 A12 / C1C2 / 工具派发」这条主线，其余维度按证据强度给「有/部分/判不了」。

---

## 1. 定位与规模

一句话：**一个多通道 AI 网关（gateway）+ 可插拔 agent 运行时**，把「消息通道 / 模型 provider / agent harness / 工具」全部做成插件，核心只提供一个中央注册表。

- 自述：`package.json:17` → `"description": "Multi-channel AI gateway with extensible messaging integrations"`
- 版本/授权：`package.json:3` `2026.11.3`；`package.json:22` `"license": "MIT"`
- workspace 结构（`pnpm-workspace.yaml:1-8`）：`.` + `ui` + `packages/*` + `extensions/*` + `examples/*` + `tools/solid-lint`
  → 关键点：**根包本身就是核心**，`extensions/*` 与 `packages/*` 都是工作区成员，插件和核心共用一套 build。
- 目录体量：`extensions/` 188 个目录（`Get-ChildItem extensions -Directory` = 188）；`src/plugins/` 1,494 个文件；`src/channels/` 124 个文件。
- **未找到**：`cordis` 依赖或目录（`Select-String package.json/pnpm-workspace.yaml -Pattern 'cordis'` 无结果；全仓无 `cordis*` 目录）。→ 见第 3 段末尾的「openclaw vs Cordis」判断。

---

## 2. 架构骨架

### 顶层目录 → 职责

| 目录 | 职责 | 证据 |
|---|---|---|
| `src/` | 核心运行时（agent、gateway、channels、plugins、cron、mcp、security…） | `src/` 下 70+ 子目录 |
| `src/plugins/` | **插件发现 / 装载 / 注册表**（本报告主战场） | `src/plugins/registry-types.ts:278` |
| `src/agents/` | agent 工具、system prompt、subagent、sandbox、approval | `src/agents/agent-tools.*` |
| `packages/agent-core/` | **内建 agent loop 本体**（可被替换的 harness 之一） | `packages/agent-core/src/agent-loop.ts:95` |
| `extensions/` | 188 个官方插件（provider / channel / memory / 工具 / UI） | `extensions/` |
| `ui/` | Control UI（**SolidJS**，非 React） | `ui/package.json` deps `@solidjs/web` |
| `crates/` | Rust 侧（gateway-client / iroh / node-host） | `crates/` 4 个 |
| `apps/` | 移动/桌面壳（android、ios、macos、linux…） | `apps/` |
| `docs/plugins/` | 插件文档（manifest / load-pipeline / sdk-*，注意：**文档，不当事实来源**） | `docs/plugins/architecture-internals/load-pipeline.md` |

### 依赖方向：单向「插件 → 注册表 → 核心」

核心设计（`docs/plugins/architecture-internals/load-pipeline.md:326-334` 的原话）：
- plugin module → registry registration
- core runtime → registry consumption

代码印证：
- 插件侧只有一个入口：`register?: (api: OpenClawPluginApi) => void`（`src/plugins/plugin-definition.types.ts:27`；`OpenClawPluginModule = ... | ((api) => void)` 同文件 `:30`）
- 插件拿到的是**构造出来的 api 对象**，不是核心单例：`src/plugins/registry.ts:259` `const api = buildPluginApi({...})`；`src/plugins/api-builder.ts:117`
- 注册表是纯数据容器：`src/plugins/registry-types.ts:278` `export type PluginRegistry = { plugins, tools, hooks, typedHooks, channels, ... }`（见第 3 段清单）

### 有没有「核心/插件」边界？靠什么强制？

边界存在，但**不是靠类型系统，也不是靠 lint**：
- AGENTS.md 规定「Plugins use documented `openclaw/plugin-sdk/*` contracts … never core internals」（`AGENTS.md:73` 段落 "Runtime and code safeguards"）
- 但 `.oxlintrc.json` 里对 `extensions/**` **只有 tsx/style 规则**（`.oxlintrc.json:400,422,444,466`），**没有** no-restricted-imports 约束 extensions 不得 import 核心内部。
- 真正生效的是 **workspace 包级**约束：`packages/worker-runtime` 被禁 import `openclaw` 或 `../../../src/`（`.oxlintrc.json:313-328`，regex `^(?:openclaw(?:/|$)|(?:\.\./){3,}src/)`）；`packages/*` 一组包启用严格规则（`.oxlintrc.json:335-357`）。
- 运行时靠 **SDK 别名解析**把 `openclaw/plugin-sdk/*` 指到真实文件（`src/plugins/sdk-alias.ts`，37KB；`src/plugins/plugin-instance-module-resolver.ts:20,67` 用 `Module.registerHooks`）。

结论：**边界是「约定 + 包级分层」，插件本身没有能力沙箱**（见第 3.6）。

---

## 3. 【A12】插件 / 扩展机制（重中之重）

### 3.1 插件清单长什么样

**原生清单 = `openclaw.plugin.json`，放在插件包根目录。**

- 文件名常量：`src/plugins/manifest.ts:188` `relativePath: PLUGIN_MANIFEST_FILENAME`（常量在同文件，`bundled-dir.ts:79` 也直接用 `"openclaw.plugin.json"`）
- 必填字段只有两个：`id` + `configSchema`
  - `src/plugins/manifest.ts:226-229` → `const id = normalizeOptionalString(raw.id) ?? ""; if (!id) return fail("plugin manifest requires id");`
  - `src/plugins/manifest.ts:233-236` → `const configSchema = isRecord(raw.configSchema) ? raw.configSchema : null; if (!configSchema) return fail("plugin manifest requires configSchema");`
- 中文语境最该抄的字段（真实存在、且都是「读 manifest 就能拿到、不用执行插件代码」）：
  `id / configSchema / kind / channels / providers / skills / contracts / toolMetadata / activation / uiCapabilities / dashboard / themes / mcpServers / controlUi / cliCommands / setup / recommendedPrompts`
  证据：`docs/plugins/manifest.md:245-309` 的字段表（*这是文档，但每个字段在 `src/plugins/manifest.ts` 的 `loadPluginManifest` 里都有对应 `fail(...)` 校验分支*，例如 `generationOverlap` 见 `manifest.ts:237-239`、`categories` 见 `manifest.ts:249`）。
- 还有 **4 种兼容清单**（Agent Plugins / Codex / Claude / Cursor）：`plugin.json`、`.codex-plugin/plugin.json`、`.claude-plugin/plugin.json`、`.cursor-plugin/plugin.json`（`docs/plugins/manifest.md:11-18`）。**这条我们不要抄**（见第 10 段）。

### 3.2 怎么被发现（扫描逻辑）

- 入口函数：`src/plugins/discovery.ts:1104` `export function discoverOpenClawPlugins({...})`
- 扫描器工厂：`src/plugins/discovery.ts:475` `function createPluginScanner(env)`；真正逐目录判定在 `:574` `function discoverPluginDirectory(...)`
- **三个根**（这就是「插件去哪找」的答案）：`src/plugins/roots.ts:14-24`
  - `stock` = 内置 bundled 目录（`resolveBundledPluginsDir`，`roots.ts:20`）
  - `global` = 全局扩展目录（`resolveDefaultPluginExtensionsDir`，`roots.ts:21`）
  - `workspace` = `<workspace>/.openclaw/extensions`（`roots.ts:22`）
- 发现时的 ID 推断链（**很值得抄**，容错顺序清晰）：
  `src/plugins/discovery.ts:594-599`
  `manifest.id` → `package.json#openclaw.plugin.id` → `package.json#openclaw.channel.id` → 包名推导 → `path.basename(dir)`
- 每个候选都过安全闸（`:513-530`）：`checkSourceEscapesRoot`（entry 不得逃出插件根）+ `checkPathStatAndPermissions`（不得 world-writable、非 bundled 要 uid 匹配）
- 结果有缓存：`discovery.ts:1119-1133`（按 `roots+workspaceDir+loadPaths+installRecords+policy` 做 hash key）

### 3.3 怎么校验

**手写字段校验，不是 zod，不是 JSON Schema 注册机。** 证据：`src/plugins/manifest.ts:181-573` 整个 `loadPluginManifest` 就是一个「读文件 → parse JSON5 → 逐字段 if → fail(字符串)」的函数。

- 失败语义：返回 `{ok:false, error, manifestPath}`，**不抛异常**；结果按文件缓存（`manifest.ts:213-217` `cacheResult`）
- JSON5 容错：`manifest.ts:218` `parsePluginCacheJson(file, { json5: true })`
- 保留 ID：`manifest.ts:230-232` `isCoreReservedPluginId(id)` 拒绝核心占位 id
- 边界：`MAX_PLUGIN_MANIFEST_BYTES` + `rejectHardlinks` + `rootRealPath` 都在 `manifest.ts:186-192` 传进 `readPluginCacheFile`

**这条对我们特别有价值**：「清单校验绝不执行插件代码」是整个体系的地基，因为发现/配置校验/UI 展示全在 manifest 上跑。

### 3.4 怎么装载

- 校验清单：`manifest.ts:181`；读包元数据：`discovery.ts:588-589` `readPackageManifest`
- **方案 A（bundled / 已构建）**：原生 loader
- **方案 B（第三方本地 TS 源码）**：Jiti 兜底 —— `src/plugins/plugin-instance-module-loader.ts:10` `import { createJiti } from "./jiti-factory.js"`；`:391` `createJiti(params.source, { fsCache:false, moduleCache:false, tryNative:false })`
- 装载后解出 register：`src/plugins/module-export.ts:16-53` `resolvePluginModuleExport`（容忍 `default`/`module`/函数式入口的嵌套，最多展开 12 层 `:22`）
- **真正调用 `register(api)` 的唯一位置**（核心中的核心）：
  `src/plugins/loader-runtime-candidate.ts:579` `const { definition, register } = resolvePluginModuleExport(mod);`
  `src/plugins/loader-runtime-candidate.ts:619` `if (typeof register !== "function") { … "missing register/activate export" }`
  `src/plugins/loader-runtime-candidate.ts:649` `const api = params.registryBuilder.createApi(record, {...})`
  `src/plugins/loader-runtime-candidate.ts:655-658` `withProfile(..., () => runPluginRegisterSyncInRegistry(register, api, registry, record.id))`
- 注意 `:615-618`：`if (params.validateOnly) { finish(); return; }` → **`validateOnly` 模式只装载不注册**，这是「配置校验不产生副作用」的实现方式。
- 装载策略分级：`activation` 元数据决定「启动时装载 / 按 provider 触发 / 按 channel 触发 / 按 CLI 命令触发」（文档 `load-pipeline.md:86-104`；代码侧 `resolveEffectivePluginIds` 在 `src/plugins/effective-plugin-ids.ts`，被 `load-pipeline.md:109` 引用）

### 3.5 贡献点（插件能往宿主里加什么）

**两层：typed hooks（事件钩子）+ PluginRegistry 的 60+ 能力数组。**

A. typed hooks —— 名字清单在 `src/plugins/hook-types.ts:756-860`，每个都是 `AsyncPluginHook<Event, Context, Result>`：
```
agent_turn_prepare / before_model_resolve / before_prompt_build / before_agent_reply
model_call_started / model_call_ended / llm_input / llm_output
before_agent_finalize / agent_end / before_compaction / after_compaction / before_reset
inbound_claim / before_dispatch / reply_dispatch / reply_payload_sending
before_tool_call / after_tool_call / tool_result_persist / before_message_write
session_start / session_end / run_stopped
subagent_spawned / subagent_progress / subagent_ended / subagent_delivery_target
gateway_start / gateway_stop / heartbeat_prompt_contribution
cron_reconciled / cron_changed / skill_changed / before_install
before_agent_run / resolve_exec_env
```
（`hook-types.ts:757-859`；另有 message 类由 `PluginMessageHookHandlerMap` 交叉合并，`hook-types.ts:756`）

B. `PluginRegistry` 能力数组（`src/plugins/registry-types.ts:278-441`，逐项都在同一 type 里）：
`tools / hooks / typedHooks / channels / channelSetups / providers / modelCatalogProviders / sessionCatalogs / cliBackends / embeddingProviders / speechProviders / realtimeTranscriptionProviders / realtimeVoiceProviders / mediaUnderstandingProviders / transcriptSourceProviders / imageGenerationProviders / videoGenerationProviders / musicGenerationProviders / webFetchProviders / webSearchProviders / workerProviders / storageProviders / migrationProviders / agentToolResultMiddlewares / agentHarnesses / compactionProviders / decisionProviders / memoryCapabilities / contextEngines / gatewayHandlers / dashboardDataBindings / dashboardActionVerbs / httpRoutes / widgetPresenters / cliRegistrars / nodeHostCommands / nodeInvokePolicies / gatewayAccessPolicies / repositoryIntegrations / securityAuditCollectors / services / commands / subagentProfiles / interactiveHandlers / sessionExtensions / trustedToolPolicies / toolMetadata / controlUiDescriptors / runtimeLifecycles / agentEventSubscriptions / sessionSchedulerJobs / sessionActions / …`

C. 插件侧注册 API（`src/plugins/plugin-api.types.ts:196` `OpenClawPluginApi`）是**扁平大接口**，关键成员：
- `:250 registerTool(tool, opts)`、`:254 registerHook(events, handler, opts)`
- `:266 registerChannel(...)`、`:279 registerGatewayMethod(...)`、`:259 registerHttpRoute(...)`
- `:301 registerCli(...)`、`:319 registerService(...)`、`:336 registerProvider(...)`
- `:226 session.state/workflow/controls`、`:232 agent.registerSubagentProfile/events`、`:240 runContext`、`:249 lifecycle`
- `:220 runtime: PluginRuntime` —— 注释原文：「In-process runtime helpers for trusted native plugins. This surface is broader than hooks.」

**能力是按「声明」放行的**：`src/plugins/registry.ts:282-304` 里 `registrationCapabilities.capabilityHandlers` 决定是否把 `registerSpeechProvider / registerRealtimeTranscriptionProvider / registerContextEngine / registerSubagentProfile` 注入 api；`registerTool` 还被 `promptGuidance` 策略额外裁剪（`registry.ts:305-319`）。

### 3.6 隔离：插件拿得到宿主内部对象吗？能力怎么限

**结论：没有沙箱。插件与宿主同进程，`api.runtime` 是「给可信原生插件」的完整运行时。**

证据链：
1. 同进程动态装载：`loader-runtime-candidate.ts:540-555`（`loadPluginModule(safeSource)`，无子进程、无 VM）
2. api 显式暴露运行时：`plugin-api.types.ts:220` 注释 "trusted native plugins…broader than hooks"
3. 隔离实际只有三道「软闸」：
   - **路径闸**：entry 不逃出插件根 + 不可 world-writable（`discovery.ts:513-530`）
   - **硬链接闸**：`rejectHardlinks`（`manifest.ts:183`、`discovery.ts:583-587`）
   - **安装期扫描 + 能力同意**：`src/plugins/install-security-scan.runtime.ts`（30KB）；`src/plugins/capability-consent.ts:47-118`（`PluginCapabilityConsentReview` / `resolvePluginCapabilityConsent`，是「装之前让你看一眼它声明了哪些能力」的 UI 同意，不是运行时沙箱）
4. 唯一真正「隔离」的维度是 **generation 隔离**（见 3.7），不是权限隔离。

### 3.7 热插拔：装/卸/启/禁用，状态存哪

**状态 = 配置文件里的 `plugins.entries.<id>` / `plugins.allow`／`plugins.enabled`，不是独立 DB。**

- 启停主流程：`src/plugins/management-mutations.ts:317` `mutateManagedPluginEnabled(...)`
  - `:373-394` 启用：`ensurePluginAllowlisted` → `enableExplicitlySelectedPluginInConfig` → `applySlotSelectionForPlugin`
  - `:396` 禁用：`setPluginEnabledInConfig(next, pluginId, false, {...})`
  - 写配置前有 `assertConfigWriteAllowedInCurrentMode`（`:329`）与 `readConfigFileSnapshotForWrite`（`:334`，带 `baseHash` 做乐观并发）
- 对外 API：`:456 setManagedPluginEnabled`、`:502 reloadManagedPlugin`、`:596 refreshManagedPlugins`
- 安装落盘：`src/plugins/install-persistence.ts:220` `persistPluginInstall`
- **热替换（最重要的一段设计）**：`src/plugins/plugin-instance.ts:54` `class PluginInstance`
  - `:545 loadModule(source)` 在 `this.run(...)` 里执行，所有调用被登记
  - `:764 this.forcedRetirement = true` 强制退役；`:768` 日志 "forced retirement after ${SHUTDOWN_TIMEOUT_MS}ms: N still-running call(s)"
  - `:793 work.run(() => this.controller.abort(new Error(\`Plugin ${id} is retiring\`)))`
  → 语义是「**先挡住新调用，等在飞的调用跑完（或超时强退役），再卸**」。这就是 `plugins.refresh` 能做到 `restartRequired: false` 的原因（`management-mutations.ts:596` + 文档 `load-pipeline.md:254-258`）。
- 清单里还有两个专门的替换协议位：
  - `generationOverlap`：新旧两代短暂并存（`manifest.ts:237-239` 校验）
  - `reload.turnHandover`：重载时把正在跑的 agent turn 在「下一次模型调用」处交接（`docs/plugins/manifest.md:268`）

### 3.8 ⭐ **openclaw 的插件机制和 Cordis 是一路还是另一路？我们该抄哪一路？**

**判断：两路，血统完全不同。openclaw 是「清单 + 中央注册表 + 命令式 registrar」，Cordis 是「依赖注入容器 + 可逆 effect 树」。**

| 维度 | openclaw | Cordis（dsh） |
|---|---|---|
| 插件入口 | `register(api)`，api 是宿主构造的**大扁平接口**（`plugin-api.types.ts:196`） | `apply(ctx, config)`，`ctx` 是**服务容器** |
| 插件间通信 | 不能互调，只能各自往**中央注册表**塞数据（`registry-types.ts:278`） | 通过 `ctx.<service>` 注入/取用，按服务名解耦 |
| 元数据 | **外置 JSON 清单**，装载前就能读（`manifest.ts:181`） | 逻辑在代码里（`dsh.bundle.patch` / 包清单） |
| 贡献点 | 60+ 个 typed 数组 + 36 个 typed hook 名 | Service / Event / Slot / Tool 四类，靠 ctx 挂 |
| 卸载 | `PluginInstance` 挡新调用 + 等在飞 + 强退役（`plugin-instance.ts:545,764,793`） | effect disposer 自动逆序回收 |
| 能力限制 | 只有「声明 + 同意」，无沙箱 | scope / isolate（`isolate.ts`） |

**该抄哪一路：抄「一路」的约定，不抄它的运行时。**
- 我们跑在 dsh 上，dsh 的插件运行时是 Cordis，**不能也不该**搬 openclaw 的 loader / registry / `register(api)`——那会和 Cordis 的 ctx 生命周期打架，等于在 Cordis 上再套一层中央注册表（就是我们 `kernel.mjs` 现在犯的错）。
- **可跨血统移植的三个「思想件」**：
  1. **外置清单做控制面**：把「插件声明了什么」变成一份不执行代码就能读的 JSON（对应我们 `kernel.mjs` 的贡献点死代码区——死是因为贡献点只有声明、没有运行时注册出口；openclaw 的解法是**清单负责发现/校验/UI，runtime 只负责注册**，两边不混）。
  2. **typed hook 名单**（`hook-types.ts:756-860`）：这 36 个名字就是「agent 生命周期到底该有哪些可插拔点」的现成答案。我们 `WorkbenchScene.tsx` 需要的「在做什么」埋点，`before_agent_finalize / agent_end / subagent_progress / before_compaction` 直接能用。
  3. **热替换的四步**：挡新调用 → 等在飞 → 超时强退役 → 换代（`plugin-instance.ts:545,764,793`）。Cordis 的 effect 回收天然给了第 4 步，缺的正是前 3 步——**这是我们要在 dsh 宿主侧补的**。

→ 一句话回答用户：**「另一路。抄它的清单约定和 hook 名单，别抄它的 loader。我们的 kernel.mjs 应该退化成 Cordis 插件（`apply(ctx)`），贡献点通过 `ctx` 注册，而不是自建中央注册表。」**

---

## 4. 【A13】MCP / 工具接入

- MCP client 本体：`src/agents/native-mcp-runtime-client.ts:50` `createNativeMcpClientBridge(...)`，内部直接包官方 SDK：`:355 listTools`、`:373 callTool`（用 `CallToolResultSchema`，`:16` 引入 `@modelcontextprotocol/...`）
- MCP 的两种来源：
  1. **插件清单静态贡献**：manifest `mcpServers`（`docs/plugins/manifest.md:288`；运行时绑定 `api.registerMcpServerConnectionResolver`，`plugin-api.types.ts:262`）
  2. **运维配置** `mcp.servers`（`src/config/mcp-config.test.ts:6 listConfiguredMcpServers`）
- 会话级 overlay：`registry-types.ts` 有 `mcpServerConnectionResolvers`（`:375`）
- 工具列表暴露：MCP 工具和插件工具走同一条 `resolvePluginTools`（`src/plugins/tools.ts:413`）
- UI 管理：`ui/package.json` 依赖 `@modelcontextprotocol/ext-apps`（`ui/package.json` 依赖区）→ 有 MCP 可视化/审批面
- 结果回填：走标准的 `callTool` 返回 → 进 `tool_result_persist` hook（`hook-types.ts:817`）→ 落 transcript

## 5. 【A11】调度 / 后台任务

- 位置：`src/cron/`（**130+ 文件**，是个完整子系统，不是小模块）
- 定义/调度：`src/cron/schedule.ts`（12.5KB）；存储：`src/cron/store.ts`（17.4KB）
- 执行：`src/cron/session-run.ts`（16KB）+ `run-admission.ts`（7.7KB，准入）+ `run-authority.ts`
- 每次执行是一个**独立 agent 会话**：`src/cron/isolated-agent.ts`、`run-prompt.ts`、`run-workspace.ts`
- 失败处理：`src/cron/retry-hint.ts`、`failure-notification-text.ts`、`delivery-attempt-fence.ts`
- 与插件联动：`plugin-command-schedule.ts`（11KB）让插件能注册定时命令；typed hook `cron_reconciled` / `cron_changed`（`hook-types.ts:843-844`）
- 四态/幂等：`proactive-job-receipt.kernel.ts`、`event-occurrence-admission.ts`
- 另有独立的后台服务面：`api.registerService`（`plugin-api.types.ts:319`）+ `PluginServiceRegistration`（`registry-types.ts:156`）+ `registerGatewayDiscoveryService`（`:326`）

## 6. 【C1/C2】agent 循环与停止条件

### 主循环

- 文件：`packages/agent-core/src/agent-loop.ts`
- 入口：`:95 runAgentLoop(prompts, context, config, emit, signal, streamFn, runtime)`
- 续跑：`:134 runAgentLoopContinue(...)`（明确禁止从 `assistant` 结尾的 transcript 续：`:146-148` `TranscriptNotContinuableError`）
- 主循环：`:156 runLoop(...)` → `:218 while (true)` → `:221 while (hasMoreToolCalls || pendingMessages.length > 0)`
- **一轮的定义**（模型 → 工具 → 再模型）：
  `:295 const streamed = await streamAgentResponse(...)`（模型 + 流式工具执行）
  `:330-345 terminalToolBatch`（流结束后补跑未执行的 toolCall）
  `:352-357 hasMoreToolCalls = streamed.continuationRequired || (stopReason==="stop" && endTurn===false && !terminate) || (executedToolBatch && !terminate)`
  → **「还有没有工具调用」就是下一轮的唯一判据**。

### 停止条件（这是 C2 的核心，共 7 类，全部可独立判定）

| # | 条件 | 位置 |
|---|---|---|
| 1 | `signal.aborted`（用户取消 / 超时） | `:177-208 stopIfAborted()`，每个 checkpoint 都查（`:222,243,255,266,277,288,386,441,462`） |
| 2 | provider 失败（`stopReason==="error"/"aborted"`） | `:321`→`:412-415` |
| 3 | 模型显式 `aborted` 且不属于 turn handoff | `:373-385` |
| 4 | **工具循环熔断** `executedToolBatch.terminateRun` | `:389-410`（写入 `TOOL_LOOP_RECOVERY_TERMINATED_MESSAGE`，`:91-92`） |
| 5 | 宿主判定 `shouldStopAfterTurn(...)` | `:446-457` |
| 6 | `nextTurnSnapshot.stop`（next-turn 钩子要求停） | `:465-470` |
| 7 | 没有更多工具调用 + 无 pending/follow-up 消息 | `:474-481` → `break` → `:484 agent_end` |

**关键发现：内建 loop 没有 maxTurns 硬上限。** 全仓 `maxTurns` 只出现在：CLI 后端（claude-code 等）的 `error_max_turns`（`src/agents/cli-output-records.ts:272-315`）、群聊广播 `broadcast.*.maxTurns`（`src/config/zod-schema.messages.ts:96`，`src/auto-reply/group-thread.ts:92`）。**内建 loop 用「工具循环检测」替代 turn 上限**——见第 9 段机制 1。

### 循环状态持久化

- 每轮把 assistant/toolResult 追加进 `newMessages` 并 emit（`:359-362`、`:365 turn_end`）
- 中断会**补写一条 aborted assistant 消息**，防止下次从 toolUse 继续（`:184-207` 注释与实现）——这是「断了能续」的关键正确性细节
- 续跑靠 `runAgentLoopContinue`（`:134`），前置条件就是最后一条不是 assistant

## 7. 【A6/A7】记忆

- 形态：**文件为主 + 向量索引可选**
  - 核心编排：`extensions/memory-core/src/memory/manager.ts:55 class MemoryIndexManager`（`manager-search.ts` / `manager-search-orchestration.ts` / `manager-sync-base.ts` / `manager-publication.worker.ts`）
  - 向量：`extensions/memory-lancedb/`（`lancedb-runtime.ts`、`lancedb-custody.ts`、`embeddings.ts`）
  - 插件化：`memory` 是 **exclusive slot**（`kind: "memory"`，`docs/plugins/manifest.md:257`；选中逻辑 `loader-runtime-candidate.ts:600-613 memorySlotMatched`）
- 溯源（A7 里少见的实现）：`src/memory/memory-artifact-provenance.ts:14 MemoryArtifactProvenance`，区分 `originClass: "agent" | "untrusted"`（`:12`），上限 `MAX_ENTRIES = 50_000`（`:10`）
- 老化/巩固（很值得抄）：`extensions/memory-core/src/memory/dreaming.ts` + `dreaming-phases.ts`（42KB）+ `short-term-promotion-apply.ts`（27KB）+ `rem-evidence.ts`（31KB）
  → 语义是「短期记忆 → 定期 dreaming 巩固 → 产出 evidence」，这是一条**可调度的记忆整理流水线**，不是简单 RAG。
- 冲突消解：**未找到**「后写覆盖前写」之外的显式冲突消解算法（未找到 conflict-resolution / supersede-by-policy 之类模块）。

## 8. 【D1–D5】界面

- 技术栈：**SolidJS** —— `ui/package.json` deps `@solidjs/web`、`@solidjs/signals` 2.0.0-rc.18；**不是 React**。（与我们 `WorkbenchScene.tsx` 的 React 栈不同，D 维度可抄性低）
- 应用壳：`ui/src/app/app-shell-view.tsx`（27KB）、`app-shell-chrome.ts`（28KB）、`app-root.tsx`（27KB）、`app-host.tsx`（26KB）
- 状态存储：`ui/src/app/gateway-store.ts`（30KB）、`app-shell-gateway.ts`（29KB）
- 插件可贡献 UI：manifest `uiCapabilities` / `dashboard` / `controlUi` / `themes`（`docs/plugins/manifest.md:286-289, 98-100`）+ registry `controlUiDescriptors`（`registry-types.ts:418`）、`dashboardDataBindings` / `dashboardActionVerbs`（`:370-371`）、`widgetPresenters`（`:374`）
  → **「插件能挂 dashboard 卡片」这条是 D 维度里唯一值得看的**（我们的面板也可以让插件声明 widget binding）
- 主题：manifest `themes`（插件贡献主题）+ 重载时刷新调色板不重启 gateway（`docs/plugins/manifest.md:289`）
- D2/D3（信息密度、状态可见性）：`src/trajectory/`（runtime-store / retention / export）提供轨迹留存；但 **UI 侧具体排版未细看，判不了它比我们强多少**。

---

## 9. ⭐ 最值得抄的 3 条机制

### 机制 1：工具循环检测 —— 用「结果哈希无进展」替代 maxTurns

```
机制：不设 turn 上限，而是对每次 toolCall 计算 (toolName+args) 哈希，跟踪「同一哈希连续多少次拿到同一结果」，按阈值升级为 warning → critical → 熔断整轮
位置：src/agents/tool-loop-detection.ts:548-685（detectToolCallLoop）
      src/agents/tool-loop-detection.ts:57-59（UNKNOWN_TOOL_THRESHOLD=10 / CRITICAL_THRESHOLD=20 / GLOBAL_CIRCUIT_BREAKER_THRESHOLD=30）
      src/agents/tool-loop-thresholds.ts:1（TOOL_LOOP_WARNING_THRESHOLD=10）
      消费点：packages/agent-core/src/agent-loop.ts:389-410（terminateRun → 写终止消息 → agent_end）
为什么好：maxTurns 是「猜」，它会把「正常但慢」的任务砍死，又会放过「10 轮内空转」的任务。
      它检测的是 5 类真实故障：unknown_tool_repeat（模型幻想不存在的工具）、
      global_circuit_breaker（同工具同结果 30 次）、known_poll_no_progress（wait 类轮询空转，阈值 10）、
      ping_pong（A/B 交替）、generic_repeat（同参数重复 10 次）+ argument_churn（参数在几个稳定模式间抖动）
      —— 每一种都带可回灌给模型的自然语言 message（:569,:585,:608,:637,:679），模型能自己改行为
我们抄到哪：tools/plugin/kernel.mjs 的 loop 部分（新增 detector 模块 + 在 tool 执行后调用）；
      我们的 agent 循环（若仍是自研）加一个 toolCallHistory + 5 个 detector；
      dsh 侧则在 Cordis 插件里监听 after_tool_call 钩子做同样的事（见机制 3）
```

### 机制 2：清单是控制面、runtime 是数据面 —— 两者绝不混

```
机制：openclaw.plugin.json 承载「身份 / 配置 schema / 声明了哪些能力 / UI 提示 / 启动触发条件」，
      全部在**不执行插件代码**的前提下可读；真正的行为（hook / tool / provider）只在 register(api) 里注册。
      两者靠 registry 这个纯数据容器解耦：plugin → registry.push(...)，core → registry 读取。
位置：清单读取 src/plugins/manifest.ts:181-236（手写逐字段校验，失败返回 fail 而非抛异常）
      清单→候选 src/plugins/discovery.ts:594-599（id 推断链）+ :513-530（安全闸）
      注册唯一出口 src/plugins/loader-runtime-candidate.ts:649-658（createApi → runPluginRegisterSyncInRegistry）
      注册表定义 src/plugins/registry-types.ts:278-441（60+ 能力数组，纯数据）
      validateOnly 不注册 src/plugins/loader-runtime-candidate.ts:615-618
为什么好：这一条直接解释我们 kernel.mjs「贡献点死代码」的病根 —— 我们把「声明」和「注册」放在了同一层，
      于是声明了却没出口，或出口了却没人读。openclaw 用「清单可读不可执行」+「注册表只进不出」把两件事物理隔开。
      副产品：配置校验、插件市场、UI 展示、启动裁剪全都不用跑插件代码 → 快且安全。
我们抄到哪：tools/plugin/kernel.mjs —— 拆成 (a) `plugin.manifest.json` 声明层（不进代码），
      (b) 一个 `Registry` 纯数据类（我们现有贡献点全改成 push 进 registry 的数组），
      (c) Cordis 插件 apply(ctx) 里只做 registry 注册，不做别的
```

### 机制 3：热替换四步 —— 挡新 / 等在飞 / 超时强退役 / 换代

```
机制：重载插件时不粗暴 kill，而是新调用进新代、旧调用在旧代跑完，超时才 forcedRetirement
位置：src/plugins/plugin-instance.ts:54（class PluginInstance）
      :545 loadModule(source) → this.run(...)（每次调用登记）
      :764 forcedRetirement = true；:768 "forced retirement after ${SHUTDOWN_TIMEOUT_MS}ms: N still-running call(s)"
      :793 work.run(() => this.controller.abort(new Error("Plugin X is retiring")))
      对外：src/plugins/management-mutations.ts:502 reloadManagedPlugin / :596 refreshManagedPlugins
      清单开关：generationOverlap（manifest.ts:237-239）、reload.turnHandover（docs/plugins/manifest.md:268）
为什么好：Cordis 那一路的 effect 回收是「按依赖逆序」，但它不知道「一个插件调用还在跑」。
      openclaw 补的正是「在飞调用的所有权」：谁的 run() 还没返回，就不能拆谁的资源。
      这就是能做到「重载不重启 gateway」（restartRequired:false）的全部秘密，也是我们改插件后
      必须重启进程的根因。
我们抄到哪：dsh 侧宿主的插件生命周期（不是 Cordis 本体）。最小可用版本：
      给每个插件 wrapper 记 activeCallCount，reload 时先停新派发，等 count→0 或超时，再 dispose effect scope
```

---

## 10. 我们不该抄的

1. **4 种兼容清单格式**（Agent Plugins / Codex / Claude / Cursor，`docs/plugins/manifest.md:11-18`）。
   这是 openclaw 为了吃「别家生态」背的包袱。我们没有存量生态，只做**一种**清单。
2. **188 个 bundle 插件 + 60+ 能力数组的全展开注册表**（`extensions/` 188 个、`registry-types.ts:278-441`）。
   这是「多通道 IM + 多 provider + 多媒体 provider」产品的量，我们只有工作台。
   抄它的形状会立刻得到一个空转的大对象——正是我们 kernel.mjs 现在的状态。**只抄 A12 的 3 条机制，不抄规模。**
3. **Jiti 兜底加载 TS 源码**（`plugin-instance-module-loader.ts:391`）。
   这是「第三方插件是源码目录」时代的产物。我们插件都在我们自己仓里，有 build，不需要运行时转译。
4. **「同进程 + 无沙箱 + 靠清单同意兜底」的安全模型**（`plugin-api.types.ts:220` + `capability-consent.ts:47`）。
   它成立的前提是「插件都是可信作者」。我们如果要开放第三方，这条必须重做，不能直接沿用。
5. **SolidJS UI 栈的移植**（`ui/package.json`）。
   我们前端是 React（`apps/vouch-web/.../WorkbenchScene.tsx`），跨框架抄 UI 只会得到两套组件体系。
   D 维度只借鉴「插件可声明 dashboard widget」这一个概念即可。
6. **`docs/` 里那批「已经落后于代码」的字段表**（例如 `docs/plugins/manifest.md` 400+ 行）。
   该文件本身多处写着「Runtime-exported `kind` is kept as a compatibility fallback」（`plugin-definition.types.ts:16-22`），
   说明文档在追代码。**结论永远以 `src/plugins/*.ts` 为准，不以 docs 为准**（本报告已按此执行）。

---

## 附：维度速查（给 _cells/openclaw.json 用）

| dimId | verdict | 主证据 |
|---|---|---|
| A1 文件编辑 | 有 | `src/agents/core-coding-tools.ts`（18.8KB）、`src/agents/apply-patch.ts`（27.8KB）、`agent-tools.read.ts:1-40282` |
| A2 沙箱/执行 | 有 | `src/agents/sandbox/docker-backend.ts:1`、`ssh-backend.ts:1`、`remote-shell-backend.ts:1`、`network-mode.ts:1`、`tool-policy.ts:1` |
| A3 web 搜索/抓取 | 有 | `src/web-search/runtime.ts:524 runWebSearch`、`:114 listWebSearchProviders`；`src/web-fetch/runtime.ts`、`content-extractors.runtime.ts` |
| A4 图片/附件 | 有 | `src/media/`（`fetch.ts`、`store.ts`、`media-facts.ts`、`playback-transcode.ts`、`web-media.ts`） |
| A5 压缩 | 有 | `src/agents/embedded-agent-runner/compact.ts:70,257`；typed hook `before_compaction`/`after_compaction`（`hook-types.ts:787-788`） |
| A6 会话/记忆持久化 | 有 | `extensions/memory-core/src/memory/manager.ts:55`；`src/agents/subagents` transcript；`agent-loop.ts:134` 续跑 |
| A7 记忆治理 | 部分 | 有溯源（`src/memory/memory-artifact-provenance.ts:12,14`）与巩固（`dreaming.ts`/`short-term-promotion-apply.ts`）；**未找到**显式冲突消解 |
| A8 subagent | 有 | `src/agents/subagents/`（`announce/`、spawn）+ hook `subagent_spawned/progress/ended`（`hook-types.ts:833-835`）+ `api.agent.registerSubagentProfile`（`plugin-api.types.ts:234`） |
| A9 多 agent/团队 | 有 | `src/auto-reply/group-thread.ts:92`（maxTurns 群聊编排）、`group-thread-config.ts:40`；`src/boards/board-store.ts` 任务板 |
| A10 外部通道 | 有 | `src/channels/` 124 文件；`extensions/` 里 discord/telegram/whatsapp/slack/signal/matrix/imessage/msteams/line/feishu/irc/twitch/nostr 全有 |
| A11 调度/后台 | 有 | `src/cron/`（`schedule.ts`、`store.ts`、`session-run.ts`、`run-admission.ts`）；`api.registerService`（`plugin-api.types.ts:319`） |
| A12 插件机制 | 有 | 见第 3 段（`manifest.ts:181`、`discovery.ts:1104`、`loader-runtime-candidate.ts:649`、`registry-types.ts:278`、`plugin-instance.ts:545`） |
| A13 MCP | 有 | `src/agents/native-mcp-runtime-client.ts:50,355,373`；manifest `mcpServers`；`resolvePluginTools`（`src/plugins/tools.ts:413`） |
| A14 多 provider | 有 | `extensions/` 中 anthropic/openai/google/deepseek/openrouter/bedrock/… 数十个 provider 插件；`src/plugins/providers.runtime-core.ts:57` |
| A15 审批/权限 | 有 | `src/agents/tool-loop-admission.ts`、`agent-tools.before-tool-call.approval.ts`（21KB）、`src/security/`（91 文件）、`src/gateway/exec-approval-manager.ts:1`、`src/infra/exec-approvals-*.ts`（60+ 文件） |
| A16 可观测/轨迹 | 有 | `src/logging/`（diagnostic-*）、`src/trajectory/`（runtime-store/retention/export）、hook `llm_input/llm_output/model_call_started/ended`（`hook-types.ts:777-780`） |
| B1 无特权核心/服务化 | 部分 | 思想有（「Small core, capable plugins」`AGENTS.md:31`；单向 plugin→registry→core `load-pipeline.md:326-334`），但**不是 DI 容器**，核心仍是中心化 registry |
| B2 单一权威源+生成校验 | 有 | `package.json` scripts 里大量 `*:gen`（`config:schema:gen`、`db:kysely:gen`、`gateway:validators:gen`、`docs:map:gen`…）+ `scripts/verify-*.mjs` |
| B3 互操作/协议 | 有 | ACP（`src/acp/`）、MCP（`src/mcp/`）、Codex harness（`extensions/codex`）、`packages/gateway-protocol` |
| B4 代码质量 | 部分 | 有 oxlint（`.oxlintrc.json`）+ `lint:all`、`format:check`、`check:test-lines-ratchet`；但**无 jscpd/重复度闸**，存在超大文件（`src/plugins/discovery.ts` 1172 行、`hook-types.ts` 877 行都带 `oxlint-disable max-lines`） |
| B5 分层/依赖方向 | 有 | `pnpm-workspace.yaml:1-8` 分组；`tsconfig.packages.json`/`tsconfig.extensions.json` 分治；`.oxlintrc.json:313-328` 禁 worker-runtime 越层 import |
| C1 主循环 | 有 | `packages/agent-core/src/agent-loop.ts:156 runLoop`、`:218/221` 双层 while、`:295 streamAgentResponse`、`:330 terminalToolBatch` |
| C2 停止条件 | 有 | `agent-loop.ts` 7 类停止（`:177,321,373,389,446,465,474`）；**无 maxTurns**；替代品 `src/agents/tool-loop-detection.ts:548-685` |
| C3 测试/验证守卫 | 有 | `test/vitest/`（多 config：`vitest.live.config.ts` 等，见 `package.json` android:test 行引用）、`check:test-*` 系列 ratchet 脚本、`ci-*.mjs` 20+ |
| C4 错误恢复/重试 | 有 | `src/agents/model-fallback-runner.ts`（28KB）、`src/agents/failover-error.ts:134`、`src/cron/retry-hint.ts`、`plugin-instance.ts` 退役恢复 |
| C5 prompt/上下文装配 | 有 | `src/agents/system-prompt.ts:266 buildAgentSystemPrompt`、`:114 cacheStablePromptPrefix`；hook `before_prompt_build`/`agent_turn_prepare`（`hook-types.ts:757,767`） |
| D1 布局 | 部分 | SolidJS 应用壳 `ui/src/app/app-shell-view.tsx`、`app-shell-chrome.ts`；**未逐页核对分栏/画布范式** |
| D2 信息密度 | 判不了 | 有 `src/trajectory/` 数据面，但未做 UI 层排版比对 |
| D3 状态可见性 | 部分 | 有 `src/logging/diagnostic-*`、`src/trajectory/runtime-store`、`api.runContext`（`plugin-api.types.ts:240`）；面板呈现未核 |
| D4 多工作区 | 有 | 插件作用域按 `workspaceDir`（`discovery.ts:1113-1151`）；`plugins.entries` per-agent（`manifest.md:249`）；`src/projects/` |
| D5 主题 | 部分 | manifest `themes` 插件贡献 + 热刷新（`manifest.md:289`）；具体 token 体系未核 |
