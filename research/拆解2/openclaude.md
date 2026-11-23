# openclaude 拆解（v2：找可抄的实现）

> 本地源码：`D:\refs\openclaude`，3730 文件。主语言 TypeScript（ESM，Bun 构建，Node ≥24 运行）。
> 拆解目标只有一个：**我们要抄哪个文件、抄哪几行、解决我们哪个问题。**

---

## 1. 定位与规模

**一句话**：OpenClaude 不是「Claude Code 的阉割复刻」，而是一个**把 Claude Code 那套 agent 循环 / 工具 / 权限 / 插件 / MCP 全部重写一遍、并接上 200+ 模型供应商**的完整开源 CLI coding agent。

- 名字/版本/定位：`package.json:2-4` —— `"@twigpine/openclaude"`, version `0.36.0`, `"OpenClaude opens coding-agent workflows to any LLM — OpenAI, Gemini, DeepSeek, Ollama, and 200+ models"`。
- 运行时约束：`package.json:195-197` `engines.node >= 24.22.1`；构建用 Bun（`package.json:29` `build: bun run scripts/build.ts`）。
- 主语言：TypeScript（`package.json:5` `"type": "module"`，`tsconfig.json:20-22` 路径别名 `src/*`）。
- 文件数：3730（本机 `Get-ChildItem -Recurse -File` 实测）。体积分布：`src/utils` 1018、`src/components` 481、`src/services` 409、`src/commands` 326、`src/tools` 303。
- 最近提交：`439d75344f2819b7e0dcda0d116368b815635bc9`，`Tue Nov 17 12:06:47 2026 +0800`（`git log -1`）。
- star：**未找到** —— 这是离线克隆，仓库内无 GitHub star 元数据；README 只有 trendshift 上榜徽章（`README.md:5`），不能据此报数。
- 依赖面：运行时依赖只有 3 个包 `@orama/orama` / `@orama/plugin-data-persistence` / `@vscode/ripgrep`（`package.json:89-93`），其余全在 devDependencies —— 说明它是「重源码、轻运行时依赖」的形态。

> 关键判断：它确实是「Claude Code 的开源重实现」，而且重点不在模型层，而在**agent 运行时**：`src/query.ts`（3287 行）是循环本体，`src/services/tools/*` 是工具执行，`src/utils/plugins/*` 是插件生态。这三块就是我们最该抄的地方。

---

## 2. 架构骨架

### 顶层目录 → 职责（证据：`AGENTS.md:36-47`）

| 目录 | 职责 | 规模 |
|---|---|---|
| `src/query.ts` / `src/QueryEngine.ts` | agent 主循环（generator）与 SDK/headless 包装 | 3287 / 1555 行 |
| `src/tools/` | 60+ 工具实现，每个工具一个目录（`BashTool/`、`FileEditTool/`、`AgentTool/`…） | 303 文件 |
| `src/services/` | API、MCP、OAuth、compact、tools 执行、analytics | 409 文件 |
| `src/utils/plugins/` | 插件发现/校验/装载/贡献点/热插拔 | 55 文件 |
| `src/commands/` | 斜杠命令与 CLI 命令（含 `/plugin`、`/mcp`、`/doctor`） | 326 文件 |
| `src/components/` + `src/ink/` | React + 自研 Ink 渲染器（终端 UI） | 481 + 116 文件 |
| `src/memdir/` | 文件式长期记忆 + 向量索引 | 17 文件 |
| `src/tasks/` / `src/proactive/` | 后台任务 / 常驻 | 17 / 2 文件 |
| `web/` | **只是文档站**（Astro，`web/package.json:2` `openclaude-web`），不是产品 UI | 34 文件 |

### 依赖方向 / 有没有单向约束

- **没有强制的「核心 / 插件」边界**：`src` 下全部是同一个 Node 进程内的 TypeScript 模块，`tsconfig.json:20-22` 只声明 `src/*` 别名。没有任何 CI 脚本或类型层去禁止 `tools/` 反向 import `services/`。
- 它靠的是**打破循环依赖的懒加载约定**：`src/tools.ts:53-64` 用 `getTeamCreateTool()` 包一层 `require(...)`，注释直言「Lazy require to break circular dependency: tools.ts -> TeamCreateTool/... -> tools.ts」；`src/tools.ts:14-45` 同样用条件 `require` 加载只在特定 feature 下存在的工具。
- 它的「可插拔」不是靠边界，而是靠 **`feature()` 编译期门控**：`src/tools.ts:1` `import { feature } from 'bun:bundle'`，`src/tools.ts:19-44` 里 `feature('PROACTIVE') ? require(...) : null`，Bun 在打包时把未启用分支整段死代码消除。这是**编译期**的能力裁剪，不是运行期插件。
- 真正运行期的「插件」是**数据驱动的**（见第 3 段）：插件不 import 宿主代码，只提供 markdown/JSON/子进程配置。这是它唯一干净的边界，也是我们最该学的那条。

> 证据小结：核心与插件之间**不存在类型或目录强制**（`AGENTS.md:36-47` 只是说明性列表），宿主本身是一个单体；插件边界是「声明式资产 + 子进程」，见 3 段。

---

## 3. 【A12】插件 / 扩展机制 —— 重中之重

这是整个仓库最成熟、也最值得抄的部分。它把「插件」做成了**纯声明式资产包**：插件里没有一行会被宿主 `import` 的 JS，宿主只读它的 `plugin.json` + markdown + JSON 配置 + 子进程定义。**我们的插件内核正是缺这一整层。**

### 3.1 插件清单长什么样（真实片段）

清单文件固定路径 `.claude-plugin/plugin.json`：

```ts
// src/utils/plugins/pluginLoader.ts:1454
const manifestPath = join(pluginPath, '.claude-plugin', 'plugin.json')
```

清单 Schema 是把 11 个子 Schema 拼起来的一张 zod 大表（`src/utils/plugins/schemas.ts:916-930`）：

```ts
export const PluginManifestSchema = lazySchema(() =>
  z.object({
    ...PluginManifestMetadataSchema().shape,      // name/version/description/author/dependencies
    ...PluginManifestHooksSchema().partial().shape,
    ...PluginManifestCommandsSchema().partial().shape,
    ...PluginManifestAgentsSchema().partial().shape,
    ...PluginManifestSkillsSchema().partial().shape,
    ...PluginManifestOutputStylesSchema().partial().shape,
    ...PluginManifestChannelsSchema().partial().shape,
    ...PluginManifestMcpServerSchema().partial().shape,
    ...PluginManifestLspServerSchema().partial().shape,
    ...PluginManifestSettingsSchema().partial().shape,
    ...PluginManifestUserConfigSchema().partial().shape,
  }),
)
```

元数据字段（`schemas.ts:308-352`）就是我们要的清单骨架：

```ts
name: z.string().min(1).refine(name => !name.includes(' '), { message: '...kebab-case...' }),
version: z.string().optional(),
description: z.string().optional(),
author: PluginAuthorSchema().optional(),      // {name, email?, url?} 见 schemas.ts:286-299
homepage: z.url().optional(),
repository: z.string().optional(),
license: z.string().optional(),
keywords: z.array(z.string()).optional(),
dependencies: z.array(DependencyRefSchema()).optional(),  // 插件依赖插件
```

**贡献点字段就是「这个插件能往宿主加什么」**：`hooks`、`commands`、`agents`、`skills`、`outputStyles`、`channels`、`mcpServers`、`lspServers`、`settings`、`userConfig`（`schemas.ts:919-928`）。每一个都可以是「字符串路径 / 路径数组 / 内联对象」三种形态（如 commands 见 `schemas.ts:461-471`，agents 见 `492-502`，skills 见 `517-525`）。

### 3.2 怎么被发现（扫描逻辑）

- 入口是 `loadAllPlugins`（`src/utils/plugins/pluginLoader.ts:3379-3391`），内部把三类来源**并行**合流（`pluginLoader.ts:3438-3494`）：
  - marketplace 插件（`loadPluginsFromMarketplaces`）
  - 会话内 `--plugin-dir` 插件（`loadSessionOnlyPlugins`）
  - CLI 内置插件（`getBuiltinPlugins`，`src/plugins/builtinPlugins.ts:58-103`）
- 单个插件目录的组件发现是「**约定目录 + 清单附加路径**」双轨（`pluginLoader.ts:1469-1523`）：

```ts
// src/utils/plugins/pluginLoader.ts:1469-1490
const defaultDirectoryChecks = await Promise.all([
  !manifest.commands ? resolveDefaultPluginComponentDirectory(pluginPath, 'commands', 'Command') : null,
  !manifest.agents   ? resolveDefaultPluginComponentDirectory(pluginPath, 'agents', 'Agent') : null,
  !manifest.skills   ? resolveDefaultPluginComponentDirectory(pluginPath, 'skills', 'Skill') : null,
  !manifest.outputStyles ? resolveDefaultPluginComponentDirectory(pluginPath, 'output-styles', 'Output style') : null,
])
```

> 即：插件目录下有 `commands/ agents/ skills/ output-styles/` 就自动认；清单里另外给了路径就再补。**我们的 `kernel.mjs:194 discover()` 只认 `plugin.json` 一层递归，没有「约定组件目录」这套。**

- 内置插件是**代码内注册表**，不是磁盘扫描（`src/plugins/builtinPlugins.ts:22-33` `BUILTIN_PLUGINS.set`、`registerBuiltinPlugin`），enabled/disabled 由用户设置覆盖（`builtinPlugins.ts:58-103`，`userSetting !== undefined ? userSetting === true : defaultEnabled`）。

### 3.3 怎么校验（schema？手写？失败怎么报）

**三层校验，各管一段**：

1. **运行期装载**：`loadPluginManifest` 用 zod `safeParse`，失败把每条 `err.path.join('.') + ': ' + err.message` 拼成字符串抛出并 `logForDebugging(... level:'error')`（`pluginLoader.ts:1169-1198`）。清单不存在时**不报错**，返回一个最小 manifest 让插件仍可工作（`pluginLoader.ts:1160-1167`）——这是「宽容装载」。
2. **运行期 Schema 故意宽松**：`PluginManifestSchema` 对未知顶层字段是**静默 strip**，只有嵌套配置（userConfig/channels/lspServers）才 strict（`schemas.ts:905-915` 注释明说：怕一个未来字段让整个 marketplace 全挂）。
3. **开发期 `claude plugin validate`**：`validatePluginManifest` 反过来用 `z.strictObject(PluginManifestSchema().shape)` 做**严格**校验，专为作者抓拼写（`src/utils/plugins/validatePlugin.ts:243-251`），并在 schema 之前先做**路径穿越检查**（`validatePlugin.ts:177-213`），还额外给出一堆 warning（非 kebab 名、缺 version/description/author，`validatePlugin.ts:253-296`）。

> 这个「运行期宽 / 开发期严」的双档设计非常值得抄：我们 `kernel.mjs:25 validateManifest` 只有一档，且报错只给 code + message，没有 path。

### 3.4 怎么装载（动态 import？子进程？沙箱？）

**都不是——插件代码根本不被执行。** 装载 = 拉取/缓存文件 + 解析资产。

- 拉取源：npm / git / github / git 子目录 / 本地（`pluginLoader.ts:493 installFromNpm`、`535 gitClone`、`665 installFromGitHub`、`721 installFromGitSubdir`、`863 installFromLocal`）。
- 落地是**版本化缓存**：`copyPluginToVersionedCache`（`pluginLoader.ts:366`）、`cachePlugin`（`918`），安装记录写 `installed_plugins.json`。
- 全仓 `src/utils/plugins/*.ts` **没有一处 `import(pluginPath)`**（本机 grep 确认，唯一 `await import(...)` 全是内部模块或 `@anthropic-ai/mcpb`）。插件提供的：
  - `commands/*.md` / `skills/*/SKILL.md` → 当成 **prompt 文本**载入（`loadPluginCommands.ts:419 getPluginCommands`，命名 `${plugin.name}:${basename}` 见 `547`）；
  - `agents/*.md` → 解析成 `AgentDefinition`（`loadPluginAgents.ts:244`）；
  - `hooks/hooks.json` → 注册成 **shell 命令钩子**（`loadPluginHooks.ts:91`）；
  - `mcpServers` / `lspServers` → 作为**独立子进程/连接**启动（`mcpPluginIntegration.ts:35-79`、`lspPluginIntegration.ts`，refresh 时统计 `refresh.ts:105-122`）。

**这就是它的隔离模型**：插件拿不到宿主内部对象，因为它连宿主进程都不进。代价是插件不能写「任意 JS 逻辑」，回报是安全边界极干净。信任提示也只在 UI 层做一次免责声明（`src/commands/plugin/PluginTrustWarning.tsx`）。

> 对我们：我们的插件是 `import()` 真实 JS（`kernel.mjs:133 await import(...)`），能力靠 `ctx` 注入。抄它的「声明式资产包」能让我们在不牺牲安全的前提下，先长出「技能/命令/agent/hook/mcp」这几类最常用的扩展，而不必给插件开放任意代码。

### 3.5 贡献点：插件能往宿主里加什么

| 贡献点 | 宿主侧装载器 | 变成什么 |
|---|---|---|
| commands（斜杠命令） | `loadPluginCommands.ts:419 getPluginCommands` | `Command`（type:'prompt'） |
| skills（技能） | `loadPluginCommands.ts:874 getPluginSkills` | `Command`（Skill 工具可见） |
| agents（子代理） | `loadPluginAgents.ts:244 loadPluginAgents` | `AgentDefinition` |
| hooks（钩子） | `loadPluginHooks.ts:91 loadPluginHooks` | 注册进 `STATE.registeredHooks` |
| output-styles | `loadPluginOutputStyles.ts`（路径检测见 `pluginLoader.ts:1483-1489`） | 输出风格 |
| mcpServers | `mcpPluginIntegration.ts`（`refresh.ts:109 loadPluginMcpServers`） | MCP 连接 |
| lspServers | `lspPluginIntegration.ts` | LSP 连接 |
| channels | `services/mcp/channelNotification.ts` | 入站 IM 消息通道 |
| settings / userConfig | `pluginOptionsStorage.ts` | 写入设置 / `${user_config.KEY}` 变量替换 |

宿主在 `src/commands.ts:528` 把 `getPluginCommands()` 合进命令池，`refresh.ts:91-94` 同时刷新 commands 与 agentDefinitions —— **贡献点不是死代码，有真实消费点**。这正是我们最缺的：我们 `kernel.mjs:22 CONTRIBUTION_POINTS = ['commands','panels','verifiers']` 里 `panels/verifiers` 没有消费者。

### 3.6 隔离：插件拿得到宿主内部对象吗？能力怎么限

- 拿不到。装载器只把**自己的资产文件路径**交给加载函数，插件没有句柄能访问宿主 `AppState`、工具池、权限上下文。
- 能力边界靠**资产类型本身**：markdown 只能当 prompt；hooks 是外部 shell 命令（进程边界）；MCP/LSP 是进程/网络边界；`userConfig` 只做字符串替换进 env（`schemas.ts:663-696`）。没有任何「插件拿到 fs/网络」的入口。
- 对比我们：`kernel.mjs:137` 把 `Object.freeze(ctxFactory(...))` 注入 `activate`，`run.mjs:55-94` 自己实现 fs 前缀 + exec 拒绝的能力声明。方向一致，但我们的 ctx 仍是进程内对象 → 边界更弱。

### 3.7 热插拔：能装/卸/启用/禁用吗？状态存哪

**能，而且是一条完整的生命周期链。**

- **状态存储**：`installed_plugins.json`（V2 格式，`installedPluginsManager.ts:315-364 loadInstalledPluginsV2`，V1 自动迁移 `338-344`）。每个插件是「一个安装数组」，元素 `{scope, installPath, version, installedAt, lastUpdated, gitCommitSha, projectPath}`（`installedPluginsManager.ts:406-434 addPluginInstallation`）。
- **作用域**：`user / project / local` 三级（`pluginOperations.ts:72-78 VALID_INSTALLABLE_SCOPES`），跨作用域覆盖有明确优先级（`pluginOperations.ts:674-692`）。
- **操作**：`installPluginOp`（`pluginOperations.ts:321-420`）、`uninstallPluginOp`（`429`）、`setPluginEnabledOp`（`577-706`，内置插件走 user scope `586-608`）、`updatePluginOp`（`833`）。
- **热生效**：`/reload-plugins`（`src/commands/reload-plugins/reload-plugins.ts:10-57`）→ `refreshActivePlugins`（`src/utils/plugins/refresh.ts:74-148`）：
  1. `clearAllCaches()` 把所有 memoize 缓存清空（`refresh.ts:78`；实现见 `cacheUtils.ts:44-50`：清 plugin/command/agent/hook/options/output-style + commands + agentDefinitions + prompt）；
  2. 重新 `loadAllPlugins()` + 并行 `getPluginCommands()` / `getAgentDefinitionsWithOverrides()`（`refresh.ts:90-94`）；
  3. 重新填 MCP/LSP（`refresh.ts:105-122`）；
  4. **bump `mcp.pluginReconnectKey`** 让 MCP 连接管理器重跑（`refresh.ts:137-140`）；
  5. `reinitializeLspServerManager()`（`refresh.ts:148`）；重新注册 hooks（`refresh.ts:157`）。
- **hooks 单独热重载**：`setupPluginHookHotReload`（`loadPluginHooks.ts:255`）+ `pruneRemovedPluginHooks`（`179`）。
- **旧版本回收**：未安装版本打 `.orphaned_at`，7 天后 GC（`cacheUtils.ts:23-24,74-116`）。
- **UI**：`src/commands/plugin/ManagePlugins.tsx`（91KB，装/卸/启停/设置）、`DiscoverPlugins.tsx`（29KB，市场浏览）、`cli/handlers/plugins.ts`（32KB，CLI 版）。

> 对我们：`kernel.mjs` 只有「load → activateAll → stats」，**没有 install/disable/market、没有状态文件、没有缓存失效**。这一段几乎是逐字可抄的架构：`installed_plugins.json`（状态） + `pluginOperations`（装/卸/启停） + `refreshActivePlugins`（清缓存重载）。

---

## 4. 【A13】MCP / 工具接入

- **client 在哪**：`src/services/mcp/client.ts`，3825 行（仓库最大的服务文件之一）。传输层覆盖 stdio / SSE / StreamableHTTP / WebSocket / SDK in-process（`client.ts:840-1222`），连接入口 `connectToServer` 被 `memoize`（`client.ts:818-830`），单个 server 的 tools 拉取是 `fetchToolsForClient`（`client.ts:1995-2114`），内部用 `paginateMcpList` 处理 `nextCursor` 分页（`client.ts:2004-2052`）。
- **工具列表怎么暴露给模型**：把每个 MCP tool **适配成宿主 `Tool` 对象**（`client.ts:2062-2114`）：

```ts
// src/services/mcp/client.ts:2064-2113（节选）
.map((tool): Tool => {
  const fullyQualifiedName = buildMcpToolName(client.name, tool.name)  // mcp__server__tool
  return {
    ...MCPTool,
    name: skipPrefix ? tool.name : fullyQualifiedName,
    mcpInfo: { serverName: client.name, toolName: tool.name },
    isMcp: true,
    isConcurrencySafe() { return tool.annotations?.readOnlyHint ?? false },
    isReadOnly()       { return tool.annotations?.readOnlyHint ?? false },
    isDestructive()    { return tool.annotations?.destructiveHint ?? false },
    isOpenWorld()      { return tool.annotations?.openWorldHint ?? false },
    inputJSONSchema: tool.inputSchema as Tool['inputJSONSchema'],
    async checkPermissions() { return { behavior: 'passthrough', message: 'MCPTool requires permission.' } },
  }
})
```

  - 命名规则 `mcp__server__tool` 由 `buildMcpToolName` 生成（`src/services/mcp/mcpStringUtils.ts:50`）。
  - **MCP 的 `readOnlyHint` 直接映射成主机的 `isConcurrencySafe`/`isReadOnly`** —— 这正是并发调度（第 6 段）能对 MCP 工具安全批处理的来源。
- **合并进工具池**：`assembleToolPool`（`src/tools.ts:342-365`）= 内置工具（做前缀、保持连续以便 prompt cache）+ MCP 工具（排序）+ `uniqBy('name')`（内置优先）；先过 `filterToolsByDenyRules`（`tools.ts:252-259`）。
- **有没有 UI 管理 MCP server**：有整套。命令 `src/commands/mcp/addCommand.ts`（10KB）、`doctorCommand.ts`；组件 `src/components/mcp/` 下 `MCPListPanel.tsx`（16KB 列表）、`MCPStdioServerMenu.tsx`、`MCPRemoteServerMenu.tsx`（27KB）、`MCPSettings.tsx`（13KB）、`MCPToolListView.tsx` / `MCPToolDetailView.tsx`、`MCPReconnect.tsx`、`ElicitationDialog.tsx`（48KB）。启用/禁用：`src/services/mcp/config.ts:1706 isMcpServerDisabled` / `1737 setMcpServerEnabled`。
- **调用结果怎么回填**：`transformResultContent`（`client.ts:2863`）/ `processMCPResult`（`3107`）把 MCP content 转成宿主 message；带 URL elicitation 重试的调用 `callMCPToolWithUrlElicitationRetry`（`3202`）；超长结果按工具的 `maxResultSizeChars` 落盘（见 `Tool.ts:532-541`）。

> 我们已有 `tools/mcp/client.mjs`（18KB）+ `api-handler.mjs`（6KB），但**没有把 MCP tool 适配成内部统一 Tool 的能力注解**（readOnly→concurrency）。`client.ts:2064-2113` 那 50 行是可直接抄的适配器模板。

---

## 5. 【A11】调度 / 后台任务

- **定时任务怎么定义**：工具 `CronCreateTool`（`src/tools/ScheduleCronTool/CronCreateTool.ts`）。输入 `{cron, prompt, recurring?, durable?}`（`CronCreateTool.ts:28-43`）：`recurring` 默认 true 循环触发、false 一次性；`durable` true 落盘、false 仅本会话（`CronCreateTool.ts:36-42`）。对应 `CronDeleteTool` / `CronListTool`。
- **怎么存**：durable 写 `.openclaude/scheduled_tasks.json`（`CronCreateTool.ts:162`），session-only 存内存（`getSessionCronTasks`）。`addCronTask/listAllCronTasks/nextCronRunMs` 在 `src/utils/cronTasks.ts`。
- **谁来 tick**：`src/utils/cronScheduler.ts` 的 `createCronScheduler`（`cronScheduler.ts:142`）——**非 React 核心**，REPL 与 SDK/-p 共用（文件头 `1-7` 说明）。机制：
  - 1 秒 `check()` 轮询（`CHECK_INTERVAL_MS=1000`，`cronScheduler.ts:40`；`checkTimer = setInterval(check,...)` `456`）；
  - `chokidar` 监听文件变化（`cronScheduler.ts:441-454`）；
  - **每项目一把调度锁**，只有一个会话 `isOwner` 跑 `check()`，其他会话 5s 探活接管（`cronScheduler.ts:406-436`）——防多开双触发；
  - 错过的一次性任务在首次加载时**弹出来让用户确认**（`load()` `194-228`，通知文本 `buildMissedTaskNotification` `542-565`）；
  - 抖动 `jitter` 避开整点尖峰（`getJitterConfig` / `jitteredNextCronRunMs`）。
- **常驻怎么起**：REPL 用 `useScheduledTasks` hook 挂载/卸载（`src/hooks/useScheduledTasks.ts:53-126`）；headless 由 `print.ts` 共用同一 `createCronScheduler`（`cronScheduler.ts:1-7`）；daemon 场景传 `dir`（`cronScheduler.ts:88-94`）。
- **失败/超时/四态**：定时任务本身没有「四态」，但有 `isKilled` 杀开关每 tick 轮询（`cronScheduler.ts:112-119`）、`inFlight` 防双触发（`170`）、aging（`isRecurringTaskAged` `53-60`）、锁失效接管。真正的超时/四态在任务执行侧（BashTool 超时；`LocalMainSessionTask` 后台任务）。

> 我们 `tools/schedule/scheduler.mjs` 已有「持久化 job + 五段 cron + tick/daemon」，抄的价值主要在**多会话锁**（`cronScheduler.ts:406-436`）和**错过任务确认**（`194-228`）这两条我们完全没有的。

---

## 6. 【C1/C2】agent 循环与停止条件

### 主循环在哪、一轮怎么定义

- 本体：`src/query.ts` 的 `queryLoop`（`query.ts:696-3287`），是一个 `async function*` 异步生成器，外层 `while (true)` 在 `query.ts:854`。公开入口 `query()` 在 `query.ts:652`（薄包装，`679` 处 `yield* queryLoop(...)`）。`src/QueryEngine.ts`（1555 行）是给 SDK / `-p` headless 用的包装（`QueryEngine.ts:36` `import { query as defaultQuery }`）。
- **一轮（turn）的精确边界**（代码顺序）：
  1. 组装 request-only/system prompt、可能触发压缩（`query.ts:1040-1110`）；
  2. 流式请求模型，收 `assistantMessages` 与 `toolUseBlocks`（`query.ts:1248-2100`）；
  3. 若无 tool_use → 走「完成/停止」判定（`query.ts:2552-2734`）；
  4. 有 tool_use → `runTools(...)` 执行工具，`nextTurnCount = turnCount + 1`（`query.ts:3203`），把 tool_results 拼回 messages，`state = next; continue`（`query.ts:3268-3285`）。
- 工具执行在 `src/services/tools/toolOrchestration.ts`：`runTools`（`19-82`）先按 `isConcurrencySafe` 把连续只读工具**分批**（`partitionToolCalls` `94-119`），并发批用 `runToolsConcurrently`（`155-180`，并发上限默认 10 `getMaxToolConcurrency()` `8-12`），非只读批串行 `runToolsSerially`（`121-153`）。真正单工具执行在 `toolExecution.ts:332 runToolUse` → `735 checkPermissionsAndCallTool`。

### 停止条件有哪几种（这是它的强项，`query/transitions.ts:1-18` 定义全部终态）

```ts
// src/query/transitions.ts:1-18
export type Terminal =
  | { reason: 'blocking_limit' }        // 上下文顶到硬上限
  | { reason: 'image_error' }
  | { reason: 'model_error'; error: unknown }
  | { reason: 'aborted_streaming' }     // 用户 Ctrl+C / 背景化
  | { reason: 'prompt_too_long' }
  | { reason: 'completed' }             // 正常结束（无 tool_use）
  | { reason: 'stop_hook_prevented' }   // stop hook 否决续跑
  | { reason: 'aborted_tools' }
  | { reason: 'hook_stopped' }
  | { reason: 'max_turns'; turnCount: number }
  | { reason: 'agent_step_limit'; turnCount; stepsUsed; maxSteps }  // 子代理步数上限
  | { reason: 'tool_failure_loop' }     // 同一工具反复失败陷入死循环
```

对应的判定点（逐条贴行号）：

| 停止条件 | 判定位置 | 说明 |
|---|---|---|
| **max_turns（前置）** | `query.ts:821-829` | 进入 turn 前 `state.turnCount > maxTurns` 直接返回 `max_turns` |
| **max_turns（工具后）** | `query.ts:3229-3252` | 工具跑完 `nextTurnCount > maxTurns` 返回 `max_turns` |
| **completed（无工具/API 错误）** | `query.ts:2556-2558`、`2734` | 末条是 API error 跳过 stop hook 直接 `completed`；否则正常 `completed` |
| **stop hook 可否决** | `query.ts:2561-2576` | `handleStopHooks` 返回 `preventContinuation` → `stop_hook_prevented`；`blockingErrors` → 追加消息 **continue**（`2578-2610`） |
| **token budget 早期停止 / 续跑** | `query.ts:2612-2664` | `checkTokenBudget` 决定 `continue`（`token_budget_continuation`）或 `completionEvent.diminishingReturns` 停 |
| **continuation nudge（防早停）** | `query.ts:2672-2723`，上限 `MAX_CONTINUATION_NUDGES=20`（`302`） | 模型说「我接下来要…」但没调工具时，追加「继续」消息续跑 |
| **agent_step_limit（子代理）** | `query.ts:2725-2732`、`2749-2769`、`2843` | 子代理工具步数达 `maxSteps` 后强制出摘要并停 |
| **hook_stopped** | `query.ts:2907-2909` | 钩子 `hook_stopped_continuation` |
| **tool_failure_loop** | `query.ts:2067`、`2904`、`2939` | 同一工具连续失败（`toolFailureLoopGuard`） |
| **blocking_limit / prompt_too_long** | `query.ts:1411/1425/1482/1498`、`2270/2277` | 上下文超硬限、压缩也救不回来 |
| **时间维度：QueryGuard** | `utils/QueryGuard.ts:48-50`（idle 5min / hard_max 30min / lease grace 5s）、`queryLifecycle.ts:14`（`'idle'｜'hard_max'｜'lease_expired'`） | **纯时间/停滞刹车**，与轮数无关 |

另有 `Continue` 续跑原因（`transitions.ts:20-31`）：`reactive_compact_retry`、`context_overflow_compact_retry`、`provider_max_tokens_retry`、`provider_fallback_retry`、`max_output_tokens_escalate/recovery`、`stop_hook_blocking`、`token_budget_continuation`、`continuation_nudge`、`next_turn`。

> **对我们的直接意义**：我们 C2 现状是「只有 `maxTurns` 透传」（`apps/vouch-web/.../AgentAPI.ts:65 maxTurns?: number`）。openclaude 把「停不停」拆成了 **12 个终态 + 10 个续跑态 + 时间维度的 QueryGuard**，而且最关键是 **stop hook 是「可否决」的**（`query.ts:2574-2576`）——让「目标未达成不许停」变成循环外挂一个评估器，而不是改循环。这正是我们缺的。

### 循环状态怎么持久化（断了能续吗）

- 循环内状态是 `State` 对象（`query.ts:624-650`：`messages / toolUseContext / autoCompactTracking / turnCount / agentStepLimit / transition …`），每次 continue `state = next`（如 `3268-3285`）。它不是长驻内存的 daemon，而是**每轮把 messages 增量 yield 出去**，由上层写入 transcript / session（`src/utils/sessionStorage.ts`）。断点续跑由 `resumeAgent`（`tools/AgentTool/resumeAgent.ts`）+ 会话存储实现，循环本身不自带 checkpoint。

---

## 7. 【A6/A7】记忆

- **存储形态**：纯文件 + markdown frontmatter，不是 DB。入口 `MEMORY.md`（`memdir.ts:35 ENTRYPOINT_NAME`，截断上限 `200 行 / 25000 字节` `36-39`）。`buildMemoryPrompt` 把 `MEMORY.md` 正文拼进系统提示（`memdir.ts:298-342`）。
- **类型分类**：`user / feedback / project / reference` 四种（`memoryTypes.ts:14-19`），并明确「代码模式/架构/git 历史等**可从仓库推导的信息不该存记忆**」（`memoryTypes.ts:1-8`）。
- **扫描**：`scanMemoryFiles`（`memoryScan.ts:66-125`）深度有界遍历 + 小 worker 池读 header + 只保留最新 N 条。
- **检索**：向量索引 `@orama`（`vectorIndex.ts:169 initMemdirIndex`、`283 searchMemdirIndex`），按需召回 `findRelevantMemories`（`findRelevantMemories.ts:39`）。
- **自动抽取**：`extractFactsIntoMemdir`（`autoExtractFacts.ts:182`）。
- **溯源 / TTL**：有「新鲜度」提示——`memoryAge`/`memoryFreshnessText` 对 >1 天的记忆注入「这是 X 天前的观察，代码可能已变，先核实再用」的 system-reminder（`memoryAge.ts:33-52`）。**但没有 TTL 自动删除、没有 supersede 链、没有冲突消解**（本机全仓 grep 无 `supersede`/`ttl` 记忆淘汰逻辑）。所以 A7 判「部分」：有溯源提示，无冲突/老化机制。

---

## 8. 【D1–D5】界面

- **技术栈**：**自研 Ink（React 终端渲染器）**，不是 Web。`src/ink/ink.tsx` 85KB + 自研 reconciler（`src/ink/reconciler.*`、`dom.ts`、`log-update.ts` 30KB），`src/components/` 481 个 `.tsx`。主屏 `src/screens/REPL.tsx` **299KB**（全仓最大文件）。另有 `web/`（Astro 文档站，非产品）与 `vscode-extension/`。
- **布局范式**：终端单列 —— 消息流（滚动）+ 底部 PromptInput + 状态行；支持 fullscreen（`src/components/FullscreenLayout.tsx`）。**没有可拖拽分栏/可停靠面板/多工作区面板**（D1 部分）。
- **状态可见性（强项）**：内置状态行显示 `模型 · ctx 用量% · 会话成本 · 限流窗口`（`BuiltinStatusLine.tsx:64-113`，段按优先级自适应收缩 `fitSegments` `128-161`）；`Spinner/` 有动画行、停滞检测、队友 spinner 树（`SpinnerAnimationRow.tsx` 35KB、`useStalledAnimation.ts`）；`CompactProgressBar`、`Usage/` 用量对话框、`ContextVisualization`、`TodoWrite` 面板、`cost-tracker.ts` 成本账本。用户能清楚看到「在做什么/花了多少」。
- **主题 / 多工作区 / i18n**：主题 `THEME_NAMES` + `auto/dark/light`（`theme.ts:99-117`，`getTheme` `630`）；多工作区靠 **worktree 模式**（`EnterWorktreeTool`/`ExitWorktreeTool`，`isWorktreeModeEnabled()` 门控，见 `tools.ts:214`）而非并排面板；i18n 有 `src/i18n/` 7 文件。D4 判「部分」（有主题/i18n/worktree，无多工作区并行面板）。

---

## 9. ⭐ 最值得抄的 3 条机制（最重要）

### ① 插件 = 声明式资产包：清单 Schema + 约定组件目录 + 每类贡献点独立加载器

**机制**：插件不写宿主代码，只交「plugin.json + 约定目录（commands/agents/skills/output-styles）+ hooks.json + mcp/lsp 配置」；宿主用一张 zod Schema 校验清单，用「约定目录自动探测 + 清单附加路径」发现组件，每类贡献点有独立 loader 把它变成宿主的 `Command`/`AgentDefinition`/`Hook`/`MCP 连接`。

**位置**：
- 清单 Schema：`src/utils/plugins/schemas.ts:308-352`（元数据）、`916-930`（合并总表）
- 清单固定路径：`src/utils/plugins/pluginLoader.ts:1454`
- 组件自动探测：`pluginLoader.ts:1469-1523`
- 加载失败上报：`pluginLoader.ts:1169-1198`
- 各贡献点 loader：`loadPluginCommands.ts:419`（commands）/ `:874`（skills）、`loadPluginAgents.ts:244`、`loadPluginHooks.ts:91`、`mcpPluginIntegration.ts`、`lspPluginIntegration.ts`
- 消费点（证明不是死代码）：`src/commands.ts:528`、`refresh.ts:91-94`

**为什么好 / 解决我们什么具体问题**：我们现在 `tools/plugin/kernel.mjs:22` 只有 `CONTRIBUTION_POINTS = ['commands','panels','verifiers']`，其中 `panels`/`verifiers` **无消费者**（死贡献点，正是「贡献点是死代码」那条痛点）；`discover()`（`kernel.mjs:194-236`）只会找 `plugin.json`、没有「约定组件目录」概念；`validateManifest()`（`kernel.mjs:25-53`）只有一档校验、报错无 path。抄这一段 = 把插件从「几个探针」升级成「有清单规范、有真实贡献点、能发现组件的扩展体系」。而且它证明了一件对我们重要的事：**不用给插件开放任意 JS，也能靠 markdown/JSON/子进程长出完整生态**（我们 `kernel.mjs:133` 是 `import()` 真实 JS，可以保留，但先把声明式资产这层做出来）。

**我们抄到哪**：
- `tools/plugin/kernel.mjs`：把 `CONTRIBUTION_POINTS` 扩成真实消费的集合（`commands / skills / agents / hooks / mcp / lsp`，先砍掉无消费者的 `panels/verifiers` 或补上消费者）；`validateManifest` 改成「错误带 `path` 字段」+ 增加「组件路径穿越检查」（照 `validatePlugin.ts:177-213`）。
- 新建 `tools/plugin/loader.mjs`：照 `pluginLoader.ts:1469-1523` 实现「约定目录 + 清单附加路径」发现，替代 `kernel.mjs:194 discover()` 的单层扫描；新建 `tools/plugin/loaders/{commands,skills,agents,hooks,mcp}.mjs` 对应五个 loader。
- `tools/plugin/run.mjs:104-119` 的 `discover → createKernel → load → activateAll` 管线改为「discover → validate → 逐贡献点 loader → 汇总」。

---

### ② 热插拔 = `installed_plugins.json` 状态 + 装/卸/启停操作 + `clearAllCaches → reload` 刷新

**机制**：插件安装记录落 `installed_plugins.json`（V2：每插件一个多作用域安装数组）；安装/卸载/启用/禁用是独立 op 函数按 `user/project/local` 作用域写设置；改完之后 `/reload-plugins` 调 `refreshActivePlugins`：**先清空所有 memoize 缓存，再全量重载，最后 bump MCP 重连 key**，从而单进程内热生效。

**位置**：
- 状态存储：`src/utils/plugins/installedPluginsManager.ts:315-364`（load V2）、`406-434`（add installation）
- 作用域：`src/services/plugins/pluginOperations.ts:72-78`
- 装/卸/启停：`pluginOperations.ts:321-420`（install）、`429`（uninstall）、`577-706`（set enabled，内置插件 `586-608`）
- 热刷新：`src/utils/plugins/refresh.ts:74-148`
- 清缓存：`src/utils/plugins/cacheUtils.ts:44-50`（+`26-42` 插件专项）
- 入口命令：`src/commands/reload-plugins/reload-plugins.ts:10-57`
- 旧版本回收：`cacheUtils.ts:23-24,74-116`
- UI：`src/commands/plugin/ManagePlugins.tsx`、`DiscoverPlugins.tsx`、`cli/handlers/plugins.ts`

**为什么好 / 解决我们什么具体问题**：这正是我们痛点原话——「**无安装/禁用/市场**」。我们 `kernel.mjs:95-178 createKernel()` 只有内存里的 `plugins/contributions/activated` 三个 Map，**没有持久化状态文件、没有 enable/disable、没有加载后失效重载**；插件一旦 `load()` 就钉死在进程里，改了文件要重启。抄这一段 = 给插件加「安装状态（磁盘）+ 启停开关（设置）+ 热重载（清缓存）」三件套。尤其 `refresh.ts:78 clearAllCaches()` 这一行（配合 `cacheUtils.ts:44` 的清单）是「memoize 之后如何正确失效」的标准答案——我们所有 loader 都是模块级缓存，一改就脏，必须先有这一层。

**我们抄到哪**：
- 新建 `tools/plugin/registry.mjs`：照 `installedPluginsManager.ts` 落 `data/plugins.json`（V2 结构、原子写，照 `dispatch.mjs:241-246` 的 tmp+rename 风格），提供 `addInstallation/removeInstallation`。
- 新建 `tools/plugin/ops.mjs`：照 `pluginOperations.ts:321/429/577` 实现 `install(pluginId, scope) / uninstall / setEnabled`，作用域先只做 `user`（我们还没有 project/local 的 settings 概念）。
- 新建 `tools/plugin/refresh.mjs`：照 `refresh.ts:74-148` 做 `refreshActivePlugins()`——清 `kernel`/各 loader 的缓存并全量重载（我们目前没缓存，就先建立「统一入口 refresh，所有读取都走它」）。
- `tools/plugin/kernel.mjs`：`createKernel` 增加 `disable(id)`/`isEnabled(id)`，`activateAll` 只激活 enabled 的。
- UI 侧：`apps/vouch-web/.../workbench/WorkbenchScene.tsx` 加插件列表 + 启停按钮，消费 `registry`。

---

### ③ 停止条件分层：`Terminal` 终态枚举 + 时间维度 QueryGuard + stop hook 可否决

**机制**：把「停不停」显式建模成 `Terminal`（12 个终态）与 `Continue`（10 个续跑态）的判别式联合；每一处 `return { reason }` 就是一个可判定刹车；再叠一层**与轮数无关的时间刹车** `QueryGuard`（空闲 5 分钟、硬上限 30 分钟、租约过期）；最后用 **stop hook 的「否决权」** 把「目标未达成不许停」外置成评估器（不必改循环）。

**位置**：
- 终态/续跑定义：`src/query/transitions.ts:1-18`（Terminal）、`20-31`（Continue）
- max_turns 两处：`src/query.ts:821-829`、`3229-3252`
- completed：`query.ts:2556-2558`、`2734`
- stop hook 可否决：`query.ts:2561-2576`（`preventContinuation` / `blockingErrors`）
- token budget 早停/续跑：`query.ts:2612-2664`
- continuation nudge（防早停，上限 20）：`query.ts:2672-2723`，常量 `302`
- agent_step_limit：`query.ts:2725-2732`、`2749-2769`
- tool_failure_loop：`query.ts:2067/2904/2939`
- 时间刹车 QueryGuard：`src/utils/QueryGuard.ts:48-50`，超时原因 `src/utils/queryLifecycle.ts:14`（`'idle' | 'hard_max' | 'lease_expired'`）
- 子代理复用同一循环：`tools/AgentTool/runAgent.ts:916-935`（`query({ maxTurns, agentStepLimit })`）

**为什么好 / 解决我们什么具体问题**：我们的 C2 现状是「**只有 `maxTurns` 透传**」（`apps/vouch-web/src/web-ui/src/infrastructure/api/service-api/AgentAPI.ts:65 maxTurns?: number`）——循环只有一个「跑够 N 轮」的刹车，跑飞了只能等轮数用完，卡死了没有时间维度的兜底。openclaude 给的是一族**可组合、可判定的条件**：
1. 轮数（max_turns，已有）→ 保留；
2. **时间/停滞**（QueryGuard idle 5min / hard_max 30min / lease）→ 我们完全没有；
3. **stop hook 可否决**（`query.ts:2574-2576`）→ 让「目标未达成不许停」= 循环外挂评估器，这是最优雅的一条；
4. **防早停的 continuation nudge**（`query.ts:2672-2723`，上限 20 兜底）→ 解决「模型说要做却没动手就结束」；
5. **tool_failure_loop**（同一工具反复失败）→ 兜底死循环。
关键点：这些条件**彼此独立、每个都能单独判定**（正是「C2 = 停止条件可判定」的要求），而不是互相耦合在一个 `while` 里。

**我们抄到哪**：
- 新建 `tools/dispatch/stop.mjs`：先照 `transitions.ts:1-18` 定义 `Terminal`/`Continue` 判别式联合（先用最小集：`completed / max_turns / idle_timeout / hard_max / tool_failure_loop / budget_exhausted`），聚合三类判据：`maxTurns`（已有）+ `QueryGuard` 式时间刹车（照 `QueryGuard.ts:48-50` 的 5min/30min 两档）+ `tool_failure_loop`（照 `query.ts:2067` 同工具连续失败阈值）。
- `tools/dispatch/dispatch.mjs`：在 `finish()`/`refresh()` 旁加 `evaluateStop(run, now)`，把「这个 run/dispatch 该不该停」写成纯函数并给出反例自检（沿用该文件 `selfTest()` 的「反例不报=检查是假的」纪律）。
- `apps/vouch-web/src/web-ui/src/infrastructure/api/service-api/AgentAPI.ts:58-69`：在 `maxTurns?: number` 旁加 `idleTimeoutMs?`、`hardMaxMs?`、`stopOnToolFailureLoop?: boolean`，把停止策略从「一个数字」扩成「一组可判定条件」，并透传给后端。
- 后端/编排侧：把 stop hook 的「否决」语义落成一个可选回调（返回 `{block:true, reason}` 就不停），供「目标未达成」评估器挂载。

---

## 10. 我们不该抄的

1. **巨型单文件**：`src/screens/REPL.tsx` 299KB、`src/main.tsx` 231KB、`src/entrypoints/print.ts` 229KB、`src/query.ts` 3287 行。这是它的历史包袱，不是优点。我们抄机制，不要抄「一个文件包打天下」。
2. **`feature()` 编译期门控**：`src/tools.ts:19-44` 用 `bun:bundle` 的 `feature()` 做死代码消除 + 一堆 `process.env` 开关。这是**构建期**能力裁剪，与我们要做的**运行期**插件模型正交；照抄只会让我们的插件系统又变成「一堆 env 分支」。
3. **过细的权限判定体量**：`permissions.ts` 67KB + `bashSecurity.ts` 116KB + `yoloClassifier.ts` 56KB + `filesystem.ts` 74KB。用户已明确**不做越界拦截类机制**，我们只抄它的**分层思路**（deny 规则 → tool.checkPermissions → plan mode → 分类器 → ask），不要抄它的判定代码量。
4. **MCP 的 OAuth/企业级 auth**：`services/mcp/auth.ts` 108KB、`xaa*.ts`、`oauthPort`、`refreshLock`。这是给「托管式多租户」准备的，我们的 MCP client 只要 stdio + 基本 HTTP 就够，抄 `fetchToolsForClient` 适配器即可，别抄 auth。
5. **版本化缓存 + 7 天 orphan GC**：`pluginLoader.ts:366 copyPluginToVersionedCache` + `cacheUtils.ts:74-116`。对我们的小体量插件是过度设计；我们先「一个插件一个目录 + 覆盖式安装」即可。
6. **12 个终态全抄**：有些是它托管场景专属（`image_error` / `prompt_too_long` / `blocking_limit` 依赖它的压缩体系）。我们先抄 `completed / max_turns / 时间刹车 / tool_failure_loop` 四个够用，其余按需再补。
7. **自研 Ink 渲染器**：`src/ink/ink.tsx` 85KB 自研 reconciler，是我们产品形态（Web UI）完全用不上的，只借鉴它的「状态行分段自适应收缩」（`BuiltinStatusLine.tsx:128-161`）思想即可。

---

## 附：本次核对过的关键行号清单（防伪）

- `package.json:2-4`（名字/版本/描述）、`:89-93`（运行时依赖）、`:195-197`（node engines）
- `README.md:5`（trendshift 徽章，star 无法据此报数）
- `AGENTS.md:36-47`（目录职责表）
- `src/Tool.ts:437-478`（Tool 类型：call/description/inputSchema/isConcurrencySafe/isReadOnly…）、`:832-867`（TOOL_DEFAULTS + buildTool）、`:513-524`（shouldDefer/alwaysLoad）
- `src/tools.ts:183-241`（getAllBaseTools）、`:261-324`（getTools）、`:342-365`（assembleToolPool）、`:252-259`（filterToolsByDenyRules）、`:53-64`（lazy require 破环）
- `src/query.ts:652`（query）、`:696-3287`（queryLoop）、`:854`（while true）、`:3203`（nextTurnCount+1）、`:3268-3285`（state=next continue）、`:821-829` / `3229-3252`（max_turns）、`:2556-2558` / `2734`（completed）、`:2561-2576`（stop hook 否决）、`:2612-2664`（token budget）、`:2672-2723`（continuation nudge，上限见 `:302`）、`:2725-2732` / `2749-2769`（agent_step_limit）、`:2067/2904/2939`（tool_failure_loop）、`:1040-1110`（压缩触发）
- `src/query/transitions.ts:1-18`（Terminal 12 态）、`:20-31`（Continue 10 态）
- `src/utils/QueryGuard.ts:48-50`（idle 5min / hard_max 30min / lease 5s）；`src/utils/queryLifecycle.ts:14`（超时原因）
- `src/services/tools/toolOrchestration.ts:8-12`（并发上限 10）、`:19-82`（runTools）、`:94-119`（partitionToolCalls）、`:155-180`（并发批）
- `src/services/tools/toolExecution.ts:332`（runToolUse）、`:735`（checkPermissionsAndCallTool）、`:752`（zod 校验）、`:899`（validateInput）、`:1016`（PreToolUse）、`:1131`（resolveHookPermissionDecision）、`:1176`（deny 分支）
- `src/utils/permissions/permissions.ts:1524-1730`（hasPermissionsToUseToolInner 分层）
- `src/tools/FileEditTool/FileEditTool.ts:138`（old_string/new_string/replace_all）、`utils.ts:1007-1011`（唯一匹配校验）
- `src/utils/sandbox/sandbox-adapter.ts:1-3`（包装 `@anthropic-ai/sandbox-runtime`）
- `src/utils/plugins/schemas.ts:286-352`（metadata）、`:916-930`（PluginManifestSchema）、`:1286-1317`（marketplace entry）、`:1325-1376`（marketplace + pluginId）、`:905-915`（宽容 strip）
- `src/utils/plugins/pluginLoader.ts:1454`（manifest 路径）、`:1154-1220`（loadPluginManifest safeParse）、`:1443-1523`（createPluginFromPath + 约定目录探测）、`:493/535/665/721/863`（npm/git/github/subdir/local）、`:366/918`（版本化缓存）、`:3379-3391`（loadAllPlugins）、`:3438-3494`（assemblePluginLoadResult）
- `src/utils/plugins/validatePlugin.ts:129-305`（validatePluginManifest）、`:177-213`（路径穿越）、`:243-251`（strictObject）
- `src/plugins/builtinPlugins.ts:22-33`（registerBuiltinPlugin）、`:58-103`（getBuiltinPlugins）
- `src/utils/plugins/installedPluginsManager.ts:315-364`（load V2）、`:406-434`（addPluginInstallation）
- `src/services/plugins/pluginOperations.ts:72-78`（scope）、`:321-420`（install）、`:429`（uninstall）、`:577-706`（set enabled）
- `src/utils/plugins/refresh.ts:74-148`（refreshActivePlugins）；`src/utils/plugins/cacheUtils.ts:26-50`（clearAllCaches）；`src/commands/reload-plugins/reload-plugins.ts:10-57`
- `src/utils/plugins/loadPluginCommands.ts:419`（getPluginCommands）、`:547`（命名 `${plugin.name}:${basename}`）、`:874`（getPluginSkills）；`loadPluginAgents.ts:244`；`loadPluginHooks.ts:91/179/255`
- `src/services/mcp/client.ts:818-830`（connectToServer）、`:1995-2114`（fetchToolsForClient 适配器）、`:2863/3107`（结果转换）、`:3202`（elicitation 重试）；`src/services/mcp/mcpStringUtils.ts:50`（buildMcpToolName）；`src/services/mcp/config.ts:1706/1737`（启停）
- `src/tools/ScheduleCronTool/CronCreateTool.ts:28-43`（输入）、`:133-159`（call）、`:162`（落盘位置）；`src/utils/cronScheduler.ts:40/142/230-394/396-460`（tick/锁/监听）、`:1-7`（REPL+SDK 共用）；`src/hooks/useScheduledTasks.ts:53-126`
- `src/memdir/memdir.ts:35-39/298-342`；`memoryTypes.ts:1-19`；`memoryScan.ts:66-125`；`vectorIndex.ts:169/283`；`findRelevantMemories.ts:39`；`autoExtractFacts.ts:182`；`memoryAge.ts:33-52`
- `src/components/BuiltinStatusLine.tsx:64-113/128-161`；`src/utils/theme.ts:99-117/630`
- `src/tools/AgentTool/runAgent.ts:916-935`（子代理复用 query + agentStepLimit）；`AgentTool.tsx:298`（buildTool）、`:943`（runAgent 后台路径）
- `src/services/api/withRetry.ts:65-105`（429/529 退避）
- 我们侧：`tools/plugin/kernel.mjs:22`（贡献点白名单）、`:25-53`（validateManifest）、`:95-178`（createKernel）、`:194-236`（discover）；`tools/plugin/run.mjs:55-94/104-119`（能力 ctx + 真跑）；`tools/dispatch/dispatch.mjs:47-94/186-234`（状态机/DAG/结算）；`tools/schedule/scheduler.mjs:84-111/288-306`（cron/tick）；`apps/vouch-web/src/web-ui/src/infrastructure/api/service-api/AgentAPI.ts:65`（maxTurns 透传）
