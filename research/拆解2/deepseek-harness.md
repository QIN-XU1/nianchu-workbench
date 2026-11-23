# DeepSeek Harness（dsh）拆解 —— 抄什么

> 仓库：`D:\refs\deepseek-harness`（21,632 文件，TypeScript）
> 我们产品 `D:/file/AI Temp/DeepSeek/Agent自研` **就运行在它上面**。所以本文的落点不是「它有什么」，
> 而是「我们哪块在重复造轮子、该直接复用它哪个文件」。**第 3 段是全文最长**。

---

## 1. 定位与规模

- 一句话：DeepSeek 官方的 agent harness 本体，**「Everything is a Plugin」**——模型适配器、工具注册表、会话日志、agent 循环本身都是插件，配置里可换（`docs/architecture.md:9-11`）。
- 文件数 21,632；主语言 TypeScript；版本 `0.2.2-rc.3`；包管理器 pnpm 11；Node >= 24.9（`package.json:2-10`）。
- 形态是 pnpm monorepo：`packages/*/*`（约 60 个一级分组、几百个包）、`apps/*`、`vendor/*`（内置了 cordis/loader/hmr 等插件运行时）、`native/`、`python/`、`website/`（`pnpm-workspace.yaml:1-15`）。
- 质量仪式极重：根 `package.json` 里有 **29 个 `gen-*` 生成脚本和 84 个 `verify-*` 校验脚本**（`package.json:166-202`，`scripts/` 实测计数 29/84）。这本身是 B2 的证据。

---

## 2. 架构骨架

顶层目录职责：

| 目录 | 职责 | 证据 |
|---|---|---|
| `vendor/cordis` | 插件运行时内核：Context / Service / Fiber / Registry / Events | `vendor/cordis/src/*.ts`（共 10 个文件） |
| `vendor/loader` | 配置驱动的插件树 Loader：Entry / EntryTree / isolate / resolve | `vendor/loader/src/*.ts`（共 7 个文件） |
| `vendor/hmr` / `vendor/include` | 热重载、`cordis:include` 子树 | `vendor/hmr`、`vendor/include` |
| `packages/core/*` | 会话、system-prompt、tools、agent、agent-loop、scope | `docs/architecture.md:57-65` |
| `packages/bundle/*` | 发行格式：`base` / `web-app` / `headless` / `sdk-app` / `acp-app` / `sdk-minimal` | `packages/bundle/*/cordis.patch.yml` |
| `packages/boot/*` | app-boot（profile 组合）、plugin-manager（安装/启停）、plugin-market、hmr、cmdline、config-editor | `packages/boot/*` |
| `packages/*/*` | 能力seam：fs/web/llm/mcp/sandbox/subagent/skill/jobs/schedule/storage/session … | `packages/` 一级分组 |
| `packages/client/*` | 80+ 个浏览器插件（ui-*）+ slots 渲染器 + web 壳 | `packages/client/ui-slots`、`apps/web` |

**依赖方向 / 核心-插件边界**：没有「特权 core 可打补丁」——`docs/architecture.md:9-11` 明确「you extend dsh by mounting a plugin beside the others, and registrations are effects that unwind when their plugin unloads」。边界靠三样东西强制：

1. **服务键（`ctx.<key>`）+ `inject` 声明式依赖**：插件只声明需要哪些服务，Cordis 用服务可用性决定装载顺序（`vendor/cordis/src/registry.ts:19,300-336`；`docs/cordis-primer.md:10-11`）。
2. **effect 可逆注册**：所有注册都通过 `ctx.effect()`/`ctx.on()`，卸载时自动回收（`vendor/cordis/src/fiber.ts:443-548`）。
3. **CI 校验**：`verify-package-dependencies.ts`、`verify-client-domain-graph.ts`、`constraints`（`package.json:148,163,203`）等，防止跨层非法 import。

---

## 3. 【A12】插件 / 扩展机制 —— 重中之重

### 3.1 运行时：Cordis（自研前先看这个）

dsh 的插件运行时是 **`@deepseek-ai/cordis`**，仓库内置源码在 `vendor/cordis`（**只有 10 个 .ts 文件**，不是黑盒依赖）：

- 内核对象全集：`Context`（服务容器，proxy）`vendor/cordis/src/context.ts:42-151`、`Service`（`super(ctx,'key')` 即注册）`vendor/cordis/src/service.ts:12-62`、`Fiber`（一次 `ctx.plugin` 的生命周期）`vendor/cordis/src/fiber.ts`、`RegistryService`（`ctx.plugin`）`vendor/cordis/src/registry.ts:195-336`、`EventsService`（5 种派发模式）`vendor/cordis/src/events.ts`。
- 插件就是一个对象：函数、`class extends Service`、或 `{ apply(ctx, config) }`，可带 `inject` / `Config`（schemastery schema）/ `provide`（`vendor/cordis/src/registry.ts:91-146`）。
- **注册即 effect**：`ctx.effect(() => { ...; return dispose }, label)`，execute 立即跑，返回的 disposer 在 fiber 卸载时逆序执行（`vendor/cordis/src/fiber.ts:443-548`）。
- 派发模式：`emit / waterfall / parallel / serial / bail`（`docs/cordis-primer.md:16-27`，实现见 `events.ts`）。
- 服务隔离：`ctx.isolate(name, label)` 让同名服务在不同 label 下互不干扰（`vendor/cordis/src/context.ts:126-130`）。

> **这一层直接回答我们的关键问题**：我们 `tools/plugin/kernel.mjs` 想做的「无特权核心 + 依赖排序 + 只读 ctx」，Cordis 已经做完了，而且只有 10 个文件、可整包复用。

### 3.2 清单长什么样（两层：包级 manifest + 行级 Entry）

**（a）行级「插件清单」= Loader 的 entry options**（真正决定装载的是它，不是某个 plugin.json）：

```ts
// vendor/loader/src/config/entry.ts:10-23
export interface EntryOptions {
  id: string          // 树内稳定 id（补丁按 id 覆盖）
  name: string        // import 的模块 specifier
  config?: any        // 传给插件的配置
  group?: boolean     // 嵌套组
  disabled?: boolean  // 禁用（支持 !!js 表达式）
  inject?: Inject     // 需要的服务 / 拦截配置
}
```

`disabled` 支持 YAML 里的 `!!js` 表达式，按 loader ctx 求值（`vendor/loader/src/config/entry.ts:87-99`；真实用例见 `packages/bundle/base/cordis.patch.yml:22,30`：`disabled: !!js "!ctx.get('profileContext')"`）。

**（b）包级 manifest 的 `dsh` 字段**：

- bundle 声明自己的补丁文件：`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`（`packages/bundle/base/package.json:34-38`）。还支持 `dsh.bundle.platforms` 平台白名单（`packages/boot/app-boot/src/bundle-platform.ts:22-31`）。
- profile 声明它叠哪些 bundle：`"dsh": { "profile": { "bundles": [...] } }`（`packages/util/official-bundles/src/bundles.ts:10-25` 的 `PROFILE_TEMPLATES`；读写在 `packages/boot/app-boot/src/profile.ts:599`、`profile-plugins.ts:66-90`）。
- 官方内置 profile 模板：`web: [dsh-base, dsh-web-app]`、`headless`、`sdk`、`acp`、`sdk-minimal`（`packages/util/official-bundles/src/bundles.ts:10-25`）。

> 对比我们：我们用 `plugin.json`（`tools/plugin/kernel.mjs:25-53` 校验 `name/version/contributes/requires`）。dsh 的清单是 **package.json 的 `dsh` 字段 + YAML 里的一行 entry**，而且行的 `id` 是补丁系统的寻址主键。

### 3.3 怎么被发现（没有「扫 plugin.json」，是「按 profile 解 bundle + 解 YAML 补丁」）

1. `dsh --profile web` 找到 profile 目录的 `package.json`，读 `dsh.profile.bundles`（`packages/boot/app-boot/src/profile.ts:684-685`）。
2. 对每个 bundle 名，**安装目录优先、profile 目录兜底**地解析包目录，读它的 `dsh.bundle`，加载其 `cordis.patch.yml` 为 patch 层（`packages/boot/app-boot/src/profile.ts:678-713`，`resolveBundleDir` 在 `profile.ts:651-662`）。
3. 所有 patch 层按顺序「叠」成一份 entry 列表：`composeEntries(layers) = applyEntryPatches([], flat(layers))`（`packages/boot/app-boot/src/profile.ts:755-761`），**后写的层按 row id 覆盖前面**（`packages/bundle/base/cordis.patch.yml:1-13` 注释即此契约）。
4. 合成结果交给 `mountRootInclude` 挂成 `cordis:include` 一个根 entry（`packages/boot/app-boot/src/index.ts:752-799`），由 Include 展开成整棵 entry 树。

**结论**：dsh 不扫「插件目录」，它扫「profile 的 bundle 列表 + YAML 补丁」。这比我们的「递归扫 plugin.json」（`kernel.mjs:194-236`）更可控——**插件是配置行，不是文件系统里的散落目录**。

### 3.4 怎么校验

- profile manifest 先做 JSON 形状校验：必须是对象（`packages/boot/app-boot/src/profile.ts:548-562`）。
- bundle 的 patch 必须是 string 或 string[]（`profile.ts:55-57`）。
- 平台：`dsh.bundle.platforms` 非空且合法，否则抛错（`bundle-platform.ts:22-31`）；启用前再查一次（`profile-plugins.ts:119`）。
- 版本兼容：每行/每 bundle 用 `evaluatePluginCompatibility` 检查 `engines.dsh` 与 DSH peer，不过则跳过并记 `skippedBundles`（`profile.ts:688-706`），支持 `compatibility.json` 精确豁免（`packages/boot/plugin-manager/src/types.ts:28-35,77-83`）。
- 插件自己的 `Config`：schemastery schema，fiber 启动前用它校验（`vendor/cordis/src/registry.ts:100-111,326`；真实例子 `packages/core/tools/src/index.ts:101-104`）。
- 出口面校验：`scripts/verify-plugin-entry-exports.ts`、`verify-plugin-record-callers.ts`（`package.json:158-159`）。
- **失败策略**：单个 bundle 坏 → 记 `skippedBundles` 继续启动（`profile.ts:704-706`）；required entry 起不来 → 整个启动抛 `StartupError`，消息列出所有失败插件（`packages/boot/app-boot/src/index.ts:1164-1185`）。

### 3.5 怎么装载（动态 import + registry.plugin + fiber）

- Entry 初始化时 `this.parent.tree.import(this.options.name, ...)`（`vendor/loader/src/config/entry.ts:225-238`）。
- `import` 走 Node 内部 ESM loader（可绕过打包器）或原生 `import()`（`vendor/loader/src/config/tree.ts:182-201`；`internal.ts:105-143` 定位 Node 内部 loader）。
- `unwrapExports` 归一 ESM/CJS/default（`vendor/loader/src/index.ts:209-216`）。
- `this.ctx.registry.plugin(plugin, config, stack)` 起一个 fiber（`entry.ts:236`；`registry.ts:316-336`）。
- **进程内、无子进程、无 VM 隔离**——与宿主同一个 Node 进程。

### 3.6 贡献点：插件能往宿主里加什么（这是「一切皆插件」的体现）

`docs/architecture.md:148-170` 给了完整「新行为该挂哪」的映射表（这是架构契约，不是 README 宣传）；代码侧对应：

| 能力 | 注册 API | 证据 |
|---|---|---|
| 模型供应商 | `ctx.llm` adapter | `packages/llm/llm-pi-ai/src/adapter.ts:278-395`（多 provider，dict 键即路由） |
| 模型可见工具 | `ctx.tools.register(def, opts)`，schema 自动进 prompt | `packages/core/tools/src/index.ts:128-153`；`tools/src/index.ts:113-117` 把 tools 描述注入 systemPrompt |
| 工具执行器 | `ctx.tools.setExecutor`（native / PTC） | `tools/src/index.ts:325-350` |
| 人类命令 | `ctx.commands`（无需模型轮次） | `architecture.md:155`；`dsh-commands`（base 依赖） |
| 后台任务 | `ctx.jobs` 注册 + `job_*` 工具 | `packages/jobs/jobs/src/index.ts:89-197` |
| 浏览器 UI 面板/视图 | `ctx.slots.register({name, children, ...}, Component)` | `packages/client/ui-slots/src/index.ts:1220-1309`；槽表合并 `ui-slots/src/index.ts:26` |
| 会话节点渲染 | `ConversationNodeDefinition` + keyed renderer | `architecture.md:163`；`packages/client/ui-trajectory/src/client/index.ts:49-110` |
| 持久域状态 | 扩展 `SessionEventMap` / `ctx.sessionProjections.register` | `packages/boot/plugin-manager/src/types.ts:440-477`；`packages/llm/token-meter/src/index.ts:106` |
| 生图/附件 | `ctx.attachments` | `packages/attachment/attachment/src/index.ts:79` |
| 沙箱后端 | `ctx.sandbox` / `ctx.sandboxPolicy` | `packages/sandbox/sandbox-policy/src/index.ts:135-215` |
| 技能提供商 | `ctx.skills.registerProvider` / `register` | `packages/skill/skill/src/index.ts:393-463` |
| 设置页卡片 | settings section | `packages/client/ui-theme/src/index.ts:52`（`apply(ctx,config)`） |

**关键点：不用改内核**。工具是 `ctx.tools.register`、面板是 `ctx.slots.register`、命令是 `ctx.commands`——**我们那套「commands / panels / verifiers」白名单（`tools/plugin/kernel.mjs:22`）其实一一对应 dsh 已有的三个真实注册面**。

### 3.7 隔离与权限（必须如实说：不是沙箱）

- **服务级隔离**：`ctx.isolate(name, label)` 建立独立 service scope；Loader 用 `entry.options.isolate` 给一个 entry 及其消费者开 realm（`vendor/cordis/src/context.ts:126-130`；`vendor/loader/src/config/isolate.ts:71-156`）。这是「同名服务换实现」的能力隔离，不是安全隔离。
- **按 agent 收窄**：`core/scope` 提供 per-agent scoped 注册；工具注册/限制/guard 都按调用者 scope 生效（`packages/core/tools/src/index.ts:162-189,384-401`；`architecture.md:169`）。
- **进程/文件隔离只作用于被 spawn 的东西**：`sandbox-policy` 只管 bash/pty 等进程与文件写根（`packages/sandbox/sandbox-policy/src/index.ts:60-77,135-215`；`SANDBOX_MODES` at `session-mode.ts:42`）。
- **插件代码本身不受沙箱约束**：装载是进程内 `import`（`tree.ts:192`），plugin-manager README 原话「installed Host code executes in-process outside the workspace sandbox」（`packages/boot/plugin-manager/README.md:31`）。

> 结论：dsh 的插件隔离是**能力/作用域隔离（Cordis service + scope）**，不是 OS 沙箱。我们 `run.mjs` 想做的「能力受限 ctx」在 dsh 里对应的是 `ctx.tools.restrict` / `guard` / `sandboxPolicy`，但**都不能阻止插件代码本身乱来**——这点 dsh 自己也不假装。

### 3.8 热插拔（装/卸/启/禁/市场 全都有）

- 运行时热更新：`Entry.update()` 对比新旧 options，必要时 `fiber.update` 重启或仅提交 volatile config；`EntryTree.update/remove/create` 负责增删（`vendor/loader/src/config/entry.ts:121-160`；`vendor/loader/src/config/tree.ts:126-179`；`loader/src/index.ts:112-120` 把变更写回 patch）。
- 状态存在哪：**profile 目录**——`package.json`（依赖 + `dsh.profile.bundles`）+ `cordis.patch.yml`（按 row id 的 disabled/覆盖）+ `compatibility.json`（`packages/boot/plugin-manager/src/types.ts:79`；`profile-plugins.ts:87-92`）。
- 管理面：`PluginManager`（`ctx.pluginManager`）提供 `listBundles` / `setPluginEnabled` / `setBundleEnabled` / `installBundle` / `removeBundle` / `updateBundle`（`packages/boot/plugin-manager/src/index.ts:325,506,937,955,977,1156,746`），并暴露 `plugin_manager` 模型工具（`plugin-manager/src/tools.ts:87-97`）。
- 市场：`packages/boot/plugin-market`（search / detail / repository-cache）+ `apps/plugin-market-generator`。
- 无 HMR 的 profile：改动只在下次启动生效，结果返回 `restart-required` + 原因（`plugin-manager/src/types.ts:45-52`）。
- 安装依赖 pnpm、校验 `dsh.bundle`、失败回滚 manifest+lockfile（`plugin-manager/src/index.ts:977-1155` 与 `types.ts:170-200` 的 `ChangeResult`）。

### 3.9 ⚠️ 我们的 `tools/plugin/kernel.mjs` 是重复造轮子吗？——是，而且造了三层的其中一层

逐条对照：

| 我们 kernel.mjs | dsh 对应物 | 结论 |
|---|---|---|
| `discover()` 递归扫 plugin.json（`kernel.mjs:194-236`） | Loader 按 profile bundle + YAML 解 entry（`profile.ts:678-713`、`tree.ts:182-201`） | 重复；且我们的「扫目录」不如「配置行」可控 |
| `validateManifest()` 校验 name/version/contributes（`kernel.mjs:25-53`） | package.json `dsh` 字段 + EntryOptions + Config schema + 兼容性检查（`profile.ts:548-562`、`registry.ts:100-111`） | 重复（更弱） |
| `topoSort()` 按 `requires` 拓扑（`kernel.mjs:61-92`） | Cordis `inject` + 服务可用性自动定序（`registry.ts:19,300-336`） | 重复；Cordis 的定序是「服务出现即装载」，比手工拓扑更强（能等外部服务） |
| `activateAll()` 动态 import + `activate(ctx)`（`kernel.mjs:115-150`） | `Entry._init → import → registry.plugin`（`entry.ts:225-238`、`registry.ts:316`） | 重复 |
| 冻结只读 ctx（`kernel.mjs:137`） | `ctx.isolate` / `ctx.tools.restrict` / `ctx.tools.guard`（`context.ts:126-130`、`tools/src/index.ts:162-189`） | 重复（而且我们的「冻结对象」不是真隔离，dsh 也不假装） |
| `CONTRIBUTION_POINTS = ['commands','panels','verifiers']`（`kernel.mjs:22`）+ `contribute()` 死代码（`kernel.mjs:152-170`） | 真实注册面：`ctx.commands` / `ctx.slots.register`（`ui-slots:1220`）/ `ctx.tools.guard`（`tools/src/index.ts:384`） | 重复；且我们的贡献点从没被真实注册面消费 = 死代码 |
| 无 enable/disable/install/market | plugin-manager + plugin-market + HMR（3.8） | 我们缺，dsh 有 |

**明确结论：**
1. **应废弃自研 `tools/plugin/kernel.mjs` 的「装载层」和 `tools/plugin/run.mjs` 的「受限 ctx」**——它们只是 Cordis（10 文件）+ Loader（7 文件）的一个弱化子集。
2. 若要保留一个「内核」，**直接用 `@deepseek-ai/cordis` + `@deepseek-ai/cordis-plugin-loader`**（仓库 `vendor/cordis`、`vendor/loader` 即源码），不要自己维护第二套 plugin.json/topoSort/activated 列表。
3. **我们运行在 dsh 上**：正确姿势是把我们的业务（探针、工作台）写成 dsh 插件——导出一个 `apply(ctx, config)` 或 `Service` 子类，用 `ctx.tools.register` / `ctx.slots.register` / `ctx.effect` 注册，再在 profile 的 `cordis.patch.yml` 里加一行 entry；安装/启停/市场全交给 `dsh plugin` / plugin-manager。**我们的 `plugin.json`+`activate(ctx)` 契约应整体换成 Cordis 契约**。
4. 唯一值得保留自研的是**插件内部的业务代码**（探针逻辑），把它包成 Cordis 插件即可；插件「内核/发现/排序/装载/启停」这层 100% 复用。

---

## 4. 【A13】MCP / 工具接入

- MCP client 在 `packages/mcp/mcp-client`：一个插件实例连一个 MCP server，把工具注册到 `ctx.tools`，名字空间 `mcp__<server>__<rawName>`（`packages/mcp/mcp-client/src/index.ts:2-8,140-190`；工具注册 `mcp-client/src/tools.ts:163-211`）。
- 传输：`transport: 'stdio' | 'streamable-http'`，含重连策略、初始连接+工具同步完成才激活（`mcp-client/src/index.ts:75-140,203-263`）。
- 多 server 管理：`ctx.mcpManager` / `McpServerManager`，`Config.servers` 是 **volatile dict**，增删/启用禁用触发实时 reconcile，每 server 挂一个 `McpClient` 插件（`packages/mcp/mcp-manager/src/index.ts:71-83,194-202,459-500`）；还有 `probe` 探测（`mcp-manager/src/index.ts:370-393`）。
- 工具结果回填：MCP 工具是标准 `ToolDefinition`，走同一条 `ctx.tools` 执行管线（`mcp-client/src/tools.ts:163-181` + `core/tools/src/index.ts:375-377`）。
- UI 管理：Web 有 MCP 设置（`packages/client/ui-settings-*`），server 增删改经 `mcpManager`。

---

## 5. 【A11】调度 / 后台任务

两套东西：

**（a）后台任务 jobs（进程内）**：`ctx.jobs` 抽象注册表 + `jobs-local` 实现（`packages/jobs/jobs/src/index.ts:89-197`；`packages/jobs/jobs-local/src/index.ts` 310KB 含 pump/ring）。模型通过 `job_*` 工具读输出/杀任务（`packages/jobs/tool-jobs/src/index.ts`）。

**（b）定时任务 schedule（cron/持久）**：`packages/schedule/schedule`
- 定义：`ScheduleRecord` 含 rrule/时区/目标（`schedule/src/types.ts`、`storage.ts:12-60` zod schema）。
- 存储：`storage-domain` 的 `domainTable`（`schedule/src/storage.ts:8,39-60`），Host 级、与会话激活解耦。
- 谁 tick：`ScheduleRuntime` 只维护**至多一个 `setTimeout`**，到期重算下一次并驱动投递（`schedule/src/runtime.ts:67-68,199-224`）。
- 投递：往目标 session 的 inbox 注入一条 `source.kind:'schedule'` 的 user 消息（`runtime.ts:354-363`）；支持 `session / new_once / new` 三种目标（`storage.ts:52-56`）。
- 失败/重启恢复：`delivery-history` + 恢复最后一条 queued 投递（`runtime.ts:306-332`）；有 delivery floor / 最短间隔（`runtime.ts:31-38`）。

---

## 6. 【C1/C2】agent 循环与停止条件

- 主循环：`AgentLoop extends Service`（`packages/core/agent-loop/src/index.ts:290-326`），实际驱动在 `agent.ts`。
- 外层：`kick()` 里 `while (await this.turn()) {}`（`agent.ts:274-276`），`turn()` 里再 `while (true)` 跑 step（`agent.ts:333-407`）。
- 一轮（turn）= 0..N 个 step；一个 step = 一次模型请求 + 它触发的工具批（`docs/architecture.md:83`；代码 `agent.ts:441+` `step()`）。
- **停止条件（`turn/end` 的 `TurnEndReason`）**：
  - `completed` / `max-tokens`（`agent.ts:63,347,379`）；
  - `blocked`（pre-step 拒绝，`agent.ts:354-357`）；
  - `aborted`（取消，`agent.ts:408-414`）；
  - `error`（结构化错误，`agent.ts:415-424`）；
  - 循环的**真正判据**是「本轮是否还有 owed 工作」：`if (turnEnds && this.inbox.nextStep.length === 0) break`（`agent.ts:401-405`），即**工具欠不欠下一次请求 / 有没有新 next-step 输入**。**没有 max-turns 硬上限**（全仓未找到 maxSteps/maxTurns 配置），靠 plan 模式、goal、cancel、审批等上层约束。
- 持久化：每一步都 append 到 append-only session log（`turn/start`/`step/start`/`step/end`/`turn/end`，`agent.ts:342,367,394,428`），断了可 `resume`（`index.ts:755-761`）。**Model-visible means logged**（`docs/architecture.md:130`），`deriveMessages()` 从日志重建模型历史。

---

## 7. 【A6/A7】记忆

- 存储形态：**append-only Session 事件日志**是唯一真相源（`packages/session/*`、`session-persistence-jsonl`）；跨会话靠 `session-persistence` + `session-query-sqlite`（可搜历史会话）+ `session-reference`（引用别的会话）。没有独立「记忆库」抽象。
- 工作区常驻指令：`packages/context/agent-instructions` 读 `AGENTS.md`/`CLAUDE.md`/`.local` 基线并注入，文件被工具触碰后把嵌套/变更/删除增量投进 inbox（`agent-instructions/src/index.ts:2-9,141-240`；候选文件名 `config.ts:12-13`；预算截断 `render.ts:382-420`）。这是「按需增量」而非全量常驻，是 C5 的好样板。
- 老化/TTL/向量/冲突消解：**未找到**（全仓无 memory TTL、无 vector/embedding 记忆、无冲突消解；`supersede` 只出现在缓存/标题/流的「后写覆盖」语义里，如 `session-title/src/index.ts:403-527`）。→ A7 = 无。

---

## 8. 【D1–D5】界面

- 技术栈：React（`packages/client/*`）+ 自研 slot 渲染器（`packages/client/ui-slots`），壳 `apps/web`（`apps/web/src/main.ts` 用 `AppWebEntry`）。
- 布局范式：三栏 AppFrame（左 sidebar / 中 main panel / 右 rightbar track），可拖拽 resize、宽度持久化、响应式自动折叠（`packages/client/ui-layout/src/client/AppFrame.tsx:2-14,138-303`；`stores.ts:70-143`；`ctx.layout` 面板导航 `service.ts:56-104`）。主面板按 `main` slot 的 entryKey 切换（`AppFrame.tsx:45-49`）。
- 状态可见性：`ui-trajectory` 给出 turn/step 时间线、TTFT/解码耗时、reasoning 与工具调用、token 用量（`ui-trajectory/src/client/layout.ts:177-260`、`timeline.ts:70-190`、locales 里 `usage.reasoning`/`timeline.ttftDecoding`）；`token-meter` 提供 usage 与上下文压力投影（`packages/llm/token-meter/src/index.ts:87-192`、`usage-projection.ts`）；`ui-session-status` 管会话状态（`packages/client/ui-session-status/src/client/status.ts`）。
- 主题/密度/多工作区：`ui-theme` 是完整 token 化主题（`design-platform.css` 数百个 `--dsw-alias-*` 变量；亮/暗/跟随系统 `boot-theme.ts:20-42`；字号/字体角色 `theme-settings.ts:6-89`）。多工作区：`packages/workspace/workspace` + `experimental/worktree` + 会话/预设（`ui-workspace`）。

---

## 9. ⭐ 最值得抄的 3 条机制

### 机制 1：Cordis 的「注册即 effect」+ 服务/seam 装配（替代我们死掉的 contributes/activate）

```
机制：插件用 ctx.effect()/ctx.tools.register()/ctx.slots.register() 注册一切，返回 disposer，
      卸载时自动逆序回收；插件用 inject 声明服务依赖，由 Cordis 按服务可用性定序装载。
位置：vendor/cordis/src/fiber.ts:443-548（effect+dispose）
      vendor/cordis/src/service.ts:12-62（Service 注册 ctx.<key>）
      vendor/cordis/src/registry.ts:19,300-336（inject 定序 + ctx.plugin）
      vendor/loader/src/config/entry.ts:10-23,225-238（entry 即清单，import→plugin）
为什么好：这正是我们 A12 的地基缺口——我们的 kernel.mjs 只会 topoSort + 冻结 ctx，
          没有 disposer、没有热卸载、contributes/contribute() 是死代码（kernel.mjs:152-170 全仓无消费）。
          Cordis 用 10 个文件把「依赖定序 + 可逆注册 + 热重载」做全了。
我们抄到哪：废弃 tools/plugin/kernel.mjs 的装载层；业务探针改成 Cordis 插件（apply(ctx,config) 或
          Service 子类），用 ctx.effect 注册。若暂不想引入整包，最小可只 vendor/cordis（10 文件）。
```

### 机制 2：plugin-manager 的「安装 / 启停 / 市场」闭环（替代我们缺的整块）

```
机制：把 profile 的 bundle 选择、单插件 enable/disable、pnpm 安装/卸载、版本升级、回滚，
      统一成一个服务 + 一个模型工具 + 一个 Web 页；状态落在 profile 的 package.json + cordis.patch.yml。
位置：packages/boot/plugin-manager/src/index.ts:325,937,955,977,1156（list/setPluginEnabled/
        setBundleEnabled/installBundle/removeBundle）
      packages/boot/plugin-manager/src/tools.ts:87-97（plugin_manager 工具）
      packages/boot/plugin-market/src/index.ts,search.ts（市场检索）
      packages/boot/hmr（热应用） + types.ts:45-52（restart-required 语义）
为什么好：我们的痛点原话「无安装/禁用/市场」，这里全有，而且安装失败会回滚 manifest+lockfile
          （types.ts:170-200 ChangeResult），无 HMR 的 profile 正确返回 restart-required。
我们抄到哪：不要自建；直接复用 dsh 的 `dsh plugin` / plugin-manager 菜单；我们只需在 profile
          里声明 bundle，业务插件作为一个 bundle 发布（package.json 加 dsh.bundle.patch）。
```

### 机制 3：技能的两段式 provider（目录只出 name+description，正文按需 get）

```
机制：ctx.skills 是分层注册表；provider.discover 只产出候选摘要（name/description/frontmatter 校验），
      ctx.skills.get(name) 才懒加载正文——目录进 prompt 极省 token，正文按需进上下文。
位置：packages/skill/skill/src/index.ts:359-463（registerProvider / register / list / get）
      packages/skill/skill-filesystem/src/index.ts:46,187-271,738-843（多根扫描 SKILL.md + frontmatter 校验）
      packages/skill/skill-filesystem/src/index.ts:1019-1051（disable-model-invocation / user-invocable）
为什么好：我们刚做完 tools/skills/loader.mjs + inject.mjs 的「两段式」，但那是自研；dsh 的版本
          已经把「多根（project/custom/user/bundled）+ 增量 watch + per-agent scope 分层 + 调用策略」
          都做了，并且直接接进了 ctx.skills 供 tool-skill / prompt 消费。
我们抄到哪：把 tools/skills/loader.mjs 替换为注册一个 ctx.skills provider（dsh-skill-filesystem 的做法），
          inject.mjs 改为读 ctx.skills.list()（目录）+ ctx.skills.get()（正文）；不要维护第二套。
```

---

## 10. 我们不该抄的

1. **21k 文件的 monorepo 工程机器**：84 个 verify + 29 个 gen + 三语 i18n 成对文件（`*.i18n.yaml`/`*.zh.md`/`docs/i18n/translation-*`）+ `jscpd` 去重 + 多套 tsconfig（`tsconfig.host.json`/`tsconfig.client.json`/…）。这是万人级项目的治理成本，照搬只会把我们压死。
2. **Session 格式的迁移链**（`session-format-v0-to-v1` … `v3-to-v4` + `docs/persistence-changes/*`）：过度设计的持久化版本治理，我们还没到需要它的规模。
3. **把「插件代码 in-process 不受沙箱」当安全模型**（`plugin-manager/README.md:31`）：dsh 自己都说不是沙箱。我们要的是**能力清单 + 审批**（对应 `ctx.tools.restrict`/`guard`/`approval`），别误以为装个插件就隔离了。
4. **超大体量单文件**：`plugin-manager/src/index.ts` 86KB、`app-boot/src/index.ts` 62KB、`profile-resolution/resolver.ts` 48KB。dsh 用 jscpd 控重复但**不控单文件行数**；我们的 `size-guard`（32KB 红线）是对的，别学它。
5. **Electron 桌面打包 / 单 exe / Python runtime / ACP 全套**：这是另一个产品形态，与我们的本地工作台无关，最多借 ACP 作为「跨工具可移植」参考（`packages/acp/acp`）。
6. **不要为了「插件化」再包一层 Cordis 之上的自研内核**：dsh 的教训就是「没有特权 core」——我们若在 Cordis 之上再写 kernel.mjs，等于在无特权核心里又造一个特权核心（`kernel.mjs:13` 自称无特权，实则成了唯一装载入口）。
