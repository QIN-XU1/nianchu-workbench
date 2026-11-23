# NocoBase 拆解（v3 / 仓库 `D:\refs\nocobase`）

> 拆解目标：**我们能抄什么**。重点 A12/B1（插件架构）。
> 重要前置：这是 **NocoBase v3**（重写版，`packages/` 下**没有** `core/` 目录，已实测 `Get-ChildItem packages` 无 core）。
> 经典 2.x 的 `packages/core/server|client` 在本 checkout 不存在；v3 的内核 = `packages/app/*` + `packages/libs/*`。
> 所有结论按本 checkout 的真实代码写，不按产品名/README 推断。

---

## 1. 定位与规模

一句话：**一个「微内核 + 显式组合根」的企业应用平台**——核心只提供 `defineServerPlugin/defineClientPlugin/defineCliPlugins` 与装配器，业务能力全部是 `@nocobase/app-plugin-*` 普通 npm 包，由应用自己的三个 `plugins.ts` 显式 import 进来。它同时自带两套 agent 后端（服务端 native agent + 真机 runner），但那是平台功能，不是插件内核。

- 文件数：任务口径 **5,968**（本机实测 `*.ts` = 6,112，全量文件 = 11,823，差异来自是否计入 node_modules/生成物；按任务口径 5,968）。
- 主语言：TypeScript（`node >= 24`，`pnpm@11.11.0`）。
- 最近提交：`4967900` `Tue Nov 17 17:19:02 2026 +0800` `feat(agents): select a runtime for idle conversations (#11577)`（`git log -1`）。
- star：**未取**（本地源码，无网络元数据，不猜）。
- 证据：`package.json:1-9`（`"name": "nocobase-v3"`, `"packageManager": "pnpm@11.11.0"`, `engines.node >=24.0.0`）；workspace 定义见 `pnpm-workspace.yaml`。

---

## 2. 架构骨架

顶层目录（均为真实目录）：

| 目录 | 职责 | 证据 |
|---|---|---|
| `packages/app/` | 运行时宿主：`app-server`（服务端内核）、`app-client`（浏览器内核）、`app-cli`（CLI/插件管理）、`agent-runner`（真机 agent daemon）、`app-host`、`app-websocket`、`app-skills` | `packages/app/*` 目录清单 |
| `packages/libs/` | 可复用底座：`service-provider`(DI/生命周期)、`config`、`db`+`db-*` 驱动、`i18n`、`jobs`、`queue`、`realtime`、`authorization`、`lifecycle`、`secrets`、`session`… | `packages/libs/*` |
| `packages/plugins/` | **26 个官方插件** `app-plugin-*` | `packages/plugins`（26 个目录） |
| `packages/examples/` | 16 个示例插件（每个能力一个最小样例） | `packages/examples/app-plugin-*` |
| `packages/tools/` | `create-app`、`create-plugin`（脚手架）、`app-installer`、`app-testing`、`dev-config` | `packages/tools/*` |
| `packages/templates/` | **组合根所在**：`app-template-default`、`app-template-examples`（一个可运行应用 = server/client/cli 三个 `plugins.ts`） | `packages/templates/app-template-default/{server,client,cli}/plugins.ts` |

**依赖方向（单向，已实测）**：
- 插件 → 内核，只经公开子路径 `@nocobase/app-server/plugins`、`@nocobase/app-client/plugins`、`@nocobase/app-cli`。例：`packages/plugins/app-plugin-users/server/plugin.ts:3-6`、`.../client/plugin.ts:1-4`。
- 内核 → 插件：**零**。`grep "@nocobase/app-plugin-" packages/app/app-server/src` 与 `packages/app/app-client/src` 均 **0 命中**。
- 组合根（谁 import 谁、谁排第一）只存在于**应用模板**，不在内核：`packages/templates/app-template-default/server/plugins.ts:1-43`、`client/plugins.ts:1-45`、`cli/plugins.ts:1-8`。

**核心/插件边界靠什么强制**：
1. 包边界 + 公开 `exports`（内核只导出 `./plugins` 这类装配 API，`packages/app/app-server/package.json` exports 段）。
2. **反向 import 为 0**（上面 grep）。
3. `peerDependencies` 声明编译期依赖 + CI 脚本 `peers:check`（`package.json:36`）与 `deps:check`（`:37`）。
4. 组合根物理上只在 template 里，内核不知道任何具体插件名。
> 注意：没有 lint 规则/CI 脚本禁止 `app-server` import 插件，属于「目录+包边界约定 + 反向 import 事实为零」，不是类型强制。

---

## 3. 【A12】插件 / 扩展机制（重中之重）

NocoBase v3 的插件机制可以一句话概括：**没有扫描、没有 manifest 校验器、没有运行时热插拔；插件是普通 npm 包，靠应用自己的 3 个「组合根」用 TypeScript `import` 显式列出，靠 `define*` 函数把贡献点冻结成声明。** 下面逐项拆。

### 3.1 插件清单长什么样（文件名 + 字段）

**清单 = 插件包的 `package.json`（npm 清单）+ 一个 `define*` 声明文件**，没有独立 manifest.json。

`package.json` 里关键字段（以 foundation 为例，`packages/plugins/app-plugin-foundation/package.json`）：
- `name` / `version` / `displayName` / `description`（`package.json:1-6`）
- `exports`：**一个插件最多四张面** `./server`、`./client`、`./client/plugin`、`./cli`（+ `./config`、`./client/routes`、`./client/pages` 等）（`package.json:10-45`）
- `peerDependencies`：声明它需要宿主的哪些包/版本（`@nocobase/app-server`、`@nocobase/app-client`、`@nocobase/app-cli`、react 等）（`package.json` peerDependencies 段）
- 组合根识别「这个包装了哪一面」就靠 `exports` 里有没有 `./server`/`./client`/`./cli`：见 `packages/app/app-cli/src/lib/plugin-registration.ts:164-199`（`hasPluginExport` 直接读 `manifest.exports[exportName]`）。

**Server 声明字段**（`packages/app/app-server/src/plugins/types.ts:70-80`）：
```ts
interface AppServerPluginDefinition<TConfig> {
  packageName: string;      // 必须匹配 /^@[a-z0-9-]+\/[a-z0-9-]+$/
  baseDir: string;          // 绝对路径，插件内贡献的相对根
  serviceProviders?: AppPluginProviderConstructor[];   // 生命周期服务
  routes?: AppRouteContribution[];                     // API / root 路由
  database?: { migrations?: string; seeds?: string; connections?: Record<...> };
  queue?: { jobs?: string[] };   // @deprecated，已忽略只告警
  locales?: AppServerPluginLocales;
}
```
真实用法：`packages/plugins/app-plugin-users/server/plugin.ts:12-21`（`baseDir: path.resolve(import.meta.dirname,'..')`, `locales`, `serviceProviders`, `routes`, `database.migrations`）。

**Client 声明字段**（`packages/app/app-client/src/plugins.ts:235-266`）：`packageName` / `serviceProviders` / `reactProviders` / `routes` / `locales` / `options`，外加 `routeComponentOverrides`（`plugins.ts:259-266`）。真实用法 `packages/plugins/app-plugin-foundation/client/plugin.ts:19-25`（`defineClientPlugin({ packageName, locales, routes })`）。

**CLI 声明**：`defineCliPlugins([...])`（`packages/templates/app-template-default/cli/plugins.ts:1-8`）。

### 3.2 怎么被发现（扫描逻辑在哪）

**答：不扫描文件系统。发现 = 读应用的显式组合根。**
- Server：`resolveAppServerPlugins(rootDir, serverPlugins)` 把**已 import 的数组**逐个映射成 `{definition, metadata}`，顺带读出 `package.json` 的 `name/version`（`packages/app/app-server/src/plugins/resolve.ts:18-36`、`112-170`）。
- 组合根就是人写的数组：`packages/templates/app-template-default/server/plugins.ts:23-41`、`client/plugins.ts:23-43`。
- **唯一的「按磁盘发现」只发生在 CLI 命令上，不是插件**：`packages/app/app-cli/src/runtime/discover.ts:20-56` 用 `db/apply.ts → db:apply` 的路径规则发现**命令**，注释还专门说「不再维护索引」。
- 包名正则约束：`packages/app/app-server/src/plugins/define.ts:9` + `74-82`（必须是 scoped 包名）。
- 插件安装后的定位（找 `node_modules` 里的目录）由 CLI 做：`plugin-registration.ts:164-181` + `plugin-install.ts` 的 `installedPluginDirectory`。

> 对我们的直接含义：我们 `kernel.mjs` 的 `discover`（扫描插件目录）与 NocoBase 的选择相反。NocoBase 用「显式 import 数组」换取零歧义与可 tree-shake；扫描的代价是「谁被加载」变成运行期不确定。

### 3.3 怎么校验（schema？手写？失败怎么报）

没有 JSON-Schema；**校验 = `define*` 函数里的手写断言 + resolve 阶段的路径/目录校验 + inspect 快照**：

1. `defineServerPlugin`（`define.ts:11-56`）：
   - `baseDir` 必须字符串且绝对，否则抛 `Server plugin "X" requires an absolute baseDir...`（`:16-23`）。
   - 包名不合正则抛 `must be a valid scoped package name`（`:74-82`）。
   - `defineServerPlugins` 检测重复注册并抛 `registered more than once`（`:58-72`）。
2. `resolvePlugin`（`resolve.ts:112-213`）：
   - 向上找同名 `package.json`，找不到抛 `has no matching package.json above baseDir`（`:198-213`）。
   - DB connection 名必须 `/^[a-zA-Z0-9_-]+$/`（`:128-133`）。
   - 路径必须 `./` 开头、禁 `..`/`\\`/`//`（`validatePackagePath` `:184-196`），且目录必须真实存在（`resolveOptionalDirectoryPath` `:172-182`）。
3. `inspectResolvedAppServerPlugins`（`inspect.ts:92-255`）产出可机读快照：
   - 错误码 `SERVER_MIGRATIONS_DIRECTORY_MISSING` / `SERVER_SEEDS_DIRECTORY_MISSING` / `SERVER_QUEUE_JOBS_DEPRECATED`（`:180-221`）；
   - `consistent = 无 error 级 issue`（`:251`）；`suggestions` 给出修复建议（`:257-275`）。
4. **Client 侧校验最狠**（`plugins.ts`），全部抛具体错误：
   - 重复 route 名（`:929-934`）、路径冲突（`createRoutePathSignature` `:919-927`）、保留路径 `/`、`/login` 等（`:877-887`）；
   - `auth`/`authz` 取值与继承规则（`:1019-1035`、`:969-1017`）；
   - reactProvider `layer` 只能 root/application/extension，且插件只能用 extension（`:1079-1107`）；
   - `before/after` 引用的 provider 必须存在且同层，**环检测**抛 `Circular client reactProvider order detected`（`:1205-1316`）；
   - 路由组件 override 只能指向存在的 page（`:630-705`）。

### 3.4 怎么装载（动态 import？子进程？沙箱？）

**静态 ESM import + 进程内构造，无动态 import、无子进程、无 VM。**
- 组合根在源码里 `import` 插件（`server/plugins.ts:1-21`），打包时就是普通依赖。
- 应用启动时 `Application.addServerPlugins` 把每个插件的 `serviceProviders` 注册、`routes` 挂上、`locales` 收集（`packages/app/app-server/src/application/index.ts:249-290`）。
- Provider 用 `new Provider(this, ...)` 直接实例化（`:225-230`）。
- 启动顺序固定：`registerAll → bootAll → registerRoutes → startAll → readyAll`（`startServiceProviders` `:355-365`）。
- 路由全部塞进**一个** Hono `/api` 子路由，装配前 `assertNoDuplicateApiRoutes` 检查重复（`registerRoutes` `:443-522`，检查 `:503`）。
- Provider 生命周期接口：`register/boot/start/ready/shutdown`（`packages/libs/service-provider/src/provider.ts:1-26`）。

### 3.5 贡献点：插件能往宿主里加什么

**Server（4 类）**：`serviceProviders`（DI 服务）、`routes`（`scope: 'api' | 'root'`）、`locales`、`database`（migrations/seeds，按连接名）（`types.ts:70-80`；装配 `application/index.ts:273-289`）。

**Client（5 类，这就是「前端插件怎么注入 UI」的答案）**：
- `routes`：页面/分组树，节点字段含 `path/name/auth/authz/navigation/breadcrumb/presentation/componentLoader/children`（`packages/app/app-client/src/plugins.ts:70-99`、`136-178`）。
- `reactProviders`：分层（`root | application | extension`）的 React 包装组件，可 `before/after` 排序（`:185-198`）。
- `serviceProviders`：浏览器侧 DI（`:200-214`）。
- `locales`：i18n。
- `routeComponentOverrides`：按 `routeId` **替换别的插件的页面组件**（`:169-183`、应用逻辑 `:630-705`）。

**CLI（1 类）**：命令（`defineCliPlugins`，见 `cli/plugins.ts`）。

**前端注入链路（逐跳，可直接照抄）**：
1. 插件 `defineClientPlugin({packageName, routes, reactProviders, locales})` → 返回工厂（`plugins.ts:294-323`）。
2. 应用 `defineClientPlugins([pluginA(), pluginB(), ...])` 收集并去重（`:328-352`）。
3. `resolveAppRuntime` 把每个插件转成 contribution `{packageName, source:'plugin', routes, reactProviders}`（`packages/app/app-client/src/runtime/index.ts:127-136`）。
4. `resolveAppClientContributions` 合并「应用自己的 contribution + 所有插件 contribution」，校验并生成规范化的 `routes[]` 与排好序的 `reactProviders[]`（`plugins.ts:467-521`；调用点 `runtime/index.ts:133-136`、`:168-173`）。
5. **UI 落地**：`config.routes` 交给 react-router（`app-client.tsx:16-24`）；`reactProviders` 用 `reduceRight` 从内到外包裹（`app-client.tsx:41-47`）；页面外壳从 `routes` 派生侧边菜单 `useRouteNavigation(routes)`（模板 `client/layouts/app-layout.tsx:37`、`50-59`），面包屑来自 `route.breadcrumb`（`:66`）。

> 这正是我们痛点的解药：我们的 `panels` 是「死代码」，NocoBase 的等价物是 **`reactProviders`（分层 + before/after 拓扑序）+ `routes`（带 navigation/breadcrumb/presentation 的树）**，且**由内核统一 resolve + 校验**，不是每个插件自己往某个全局对象里 push。

### 3.6 隔离：插件拿得到宿主内部对象吗？能力怎么限

**没有沙箱隔离。插件是同进程普通包，拿到的是整个 Application。**
- `AppPluginApplication` 直接暴露 `config`、`paths`、`router`(Hono)、`container`(DI)（`types.ts:14-35`）。
- ServiceProvider 构造函数拿到的就是 `app: Application` 本身（`application/index.ts:225-230`，`new Provider(this, ...)`）。
- `grep sandbox|isolate|vm\.|new Worker|child_process` 在 `packages/app/app-server/src` **0 命中**。
- 所以「能力限制」只是 **API 表面 + `ServiceToken`/容器** 的软边界：插件只能 resolve 别人注册的 token；但任何 Provider 都能 `app.container.resolve(...)` 任意已有 token。官方在 runner 侧也自认「不是安全边界」（`packages/app/agent-runner/src/agent/host-tools.ts:12-13`）。
- 真正的强隔离在**业务功能**里而非插件机制：OnlineAgent 的虚拟 shell（见 §5/A2）与真机 runner 的 OS 进程隔离，都是功能级隔离，不是插件沙箱。

### 3.7 依赖与排序怎么解

- **插件之间没有依赖图、没有拓扑排序**。`grep topolog|topoSort` 全仓仅命中一处测试注释（`packages/app/app-cli/tests/tools/build-workspace.test.ts:92`）。
- **加载顺序 = 组合根数组顺序**，代码注释白纸黑字：`// Array order is server composition order. A plugin is enabled by appearing in this list...`（`packages/app/app-cli/src/lib/server-plugins.ts:31-32`）；client/cli 同样（`client-plugins.ts:33`、模板 `cli/plugins.ts:3`）。
- 装配时按数组序号写入 `order = length + index + 1`（`application/index.ts:253-272`）。
- **唯一的排序算法在客户端 reactProviders**：`before/after` 约束 → 按层分组 → 每层 Kahn 拓扑排序 → 环检测抛错（`plugins.ts:1239-1316`，层序 `:1226-1235`）。路由内部菜单顺序用 `navigation.order`（`compareNavigationOrder` `:128-133`）。
- 包级依赖靠 `peerDependencies` + `peers:check` CI（`package.json:36`），是**编译期**依赖，不是运行时依赖解析。

> 对我们：`kernel.mjs` 的 `topoSort` 在 NocoBase 里**不存在对应物**。它用「组合根顺序」把排序问题转化成「人写清楚」，只在真正需要并发/顺序语义的地方（React provider 包裹）才上拓扑排序。这是可以借的思路：**插件装载不要做通用 topo，贡献点内部才做局部排序**。

### 3.8 热插拔：能装/卸/启用/禁用吗？状态存哪

**能装/卸/启用/禁用/升级，但全部是「改源码 + 装依赖」，不是运行时热插拔。**
- 没有运行时安装钩子；`assertRoutesMutable` 明确 `Routes cannot be added after the application starts.`（`application/index.ts:557-561`）。
- **状态存三处文件（没有数据库）**：
  1. 应用的 `package.json` `dependencies`（是否安装）；
  2. 三个组合根 `server/plugins.ts` / `client/plugins.ts` / `cli/plugins.ts`（是否启用哪一面）；
  3. `.agents/skills`（插件附带的 skills 拷贝）。
- 命令与实现：
  - **安装+注册**：`nocobase plugin register`（`packages/app/app-cli/src/commands/plugin/register.ts:186-207`）→ `planPluginRegistration` 计划改哪些文件（`plugin-registration.ts:205-317`）→ `applyPluginRegistration` 落盘（`:388-404`）。`registerInManifest` 写 `dependencies`（`:596-636`）。
  - **禁用安装**：`--disabled` 只装依赖、跳过 client/server/cli 条目（`register.ts:204-207`；`plugin-registration.ts:229-263`）。
  - **卸载**：`plugin unregister`（`commands/plugin/unregister.ts:139-177`）→ 删三根条目 + 删 `dependencies` + 删 skills（`plugin-registration.ts:638-678`）。
  - **升级**：`plugin update` = 跑包管理器升级 + 重新同步 skills（`commands/plugin/update.ts:99-183`；计划 `lib/plugin-update.ts`）。
  - **查询状态**：`plugin inspect` 里 `enabled = client.registered || server.registered || cli.registered`（`commands/plugin/inspect.ts:198-201`，结果结构 `:244-267`）。
- 关键实现技巧：改 `plugins.ts` 用的是**窄文本切片编辑器**，保留注释与格式、按需插入 import 和数组项（`lib/client-plugins.ts`、`server-plugins.ts:96-100`、`plugin-registration.ts` 的 plan/apply 分离）；TypeScript 缺失时降级为「打印两行手工指令」（`register.ts:453-475`）。
- `package.json` 里还有一个 `nocobase.plugins` 字段，但**只在 unregister 时被删除**（`plugin-registration.ts:659-675`），不是启用状态的主存储——主存储是组合根。

---

## 4. 【A13】MCP / 工具接入

**结论：仓库内没有自研 MCP client/server，也没有 MCP server 管理 UI。MCP 是「外部编码 CLI 的原生能力」，本仓只把 `mcpServers` 以空数组透传。**

- ACP 桥建立会话时 `const mcpServers: acp.McpServer[] = []` 并原样带给 agent 进程（`packages/libs/acp-bridge/src/session.ts:450-457`）；`client.ts:123,131` 同为 `[]`。
- agent-runner 的 ACP 适配器同样 `mcpServers: []`（`packages/app/agent-runner/src/agent/adapters/acp.ts:217,596`）。
- MCP 真实加载发生在外部 CLI 自己（Claude Code 读 `~/.mcp.json` / 项目 `.mcp.json`），测试即证据：`packages/app/agent-runner/tests/adapters/claude.settings.test.ts:332-410` 写入 `mcpServers` 配置后断言 MCP 工具被发现。
- 没有 MCP 管理页面/路由：`grep mcp` 在 `packages/plugins/*/client/routes*` 无 MCP server 管理实现。
- 工具暴露给模型的方式是「自带工具注册表」而非 MCP：OnlineAgent 通过 `configurator.registerTool(name, {definition, execute})` 注册 `bash`/`skill` 等（`packages/plugins/app-plugin-agents/server/online/sandbox/tools.ts:6-37`）；runner 侧工具由外部 CLI 决定。

> 判：**部分**——跨工具接入走的是 ACP + 外部 CLI 原生 MCP，本仓零 MCP 协议实现；我们要抄 MCP 的话，这里**抄不到**。

---

## 5. 【A11】调度 / 后台任务

有。`app-plugin-scheduler` 是完整实现：

- **任务定义**：`defineSchedule({key,title,schedule:{cron,timezone,from,to,limit},target:{type,config}})`，校验 5/6 段 cron、时区、禁止 target.config 出现凭据类键（`packages/plugins/app-plugin-scheduler/server/schedules/define.ts:42-111`）。
- **存储**：`ScheduleStore` + `ScheduleOccurrenceStore` 落数据库，插件带两个 migration（`server/store.ts`、`server/occurrences.ts`；`database/migrations/202609020001_scheduler_create_definitions.ts`）。
- **四/五态**：`ScheduleOccurrenceStatus = pending | running | waiting | succeeded | failed`，`TERMINAL` 集合 = succeeded/failed（`server/occurrences.ts:12-17`、`45-47`），非法迁移抛 `INVALID_STATE`（`:150-153`）。
- **谁 tick**：应用进程内的 `SchedulerProvider`（`ServiceProvider`），`start()` 里 `service.sync()` 注册 handler、`executor.setup()`、`service.activate()`，并起 **60s** 的 occurrence 对账定时器（`server/providers/scheduler.ts:72-104`，timer `:98-102`）。
- **执行器**：来自 `@nocobase/jobs` 的 `JobExecutorService.getScheduleExecutor(scope, jobsConfig)`（`providers/scheduler.ts:142-151`），`jobs` 后端可配（`libs/jobs`，含 `schedule/memory` 后端）。
- **失败重试/超时**：并发与 attempts 由所选 jobs 配置决定；一次 dispatch 的失败会记为 occurrence 结果，重试同一 firing 会因已记录而不重复（`providers/scheduler.ts:139-151` 注释）。CLI 侧另有 `nocobase scheduler sync` 只同步不常驻（`schedulerStartupModeToken` `:29-37`）。
- **常驻进程**：没有 systemd 集成，就是应用进程内 provider + interval；真正的常驻外部进程是 `agent-runner` daemon（pid 文件、心跳、claim 循环，`packages/app/agent-runner/src/core/loop.ts:246-500`）。

---

## 6. 【C1/C2】agent 循环与停止条件

**有自研循环**（v3 新增，和「把活干在真机上的 runner」是两套后端）：

- **主循环**：`NativeOnlineAgent.run` 用 Vercel AI SDK `streamText({ model, tools, messages, system, abortSignal, maxRetries:0, stopWhen: stepCountIs(20) })`（`packages/plugins/app-plugin-agents/server/online/agent/native/execution.ts:448-463`），再接 `toUIMessageStream` 流式投影（`:495-522`）。一轮 = 模型 → 工具调用（`onToolExecutionStart/End` `:464-489`）→ 再模型，由 SDK 的 step 机制驱动。
- **停止条件**：① `stepCountIs(20)` 步骤上限（`:463`）；② `finishReason !== 'stop'` 且无待审批 → 判 `failed`（`:523-532`）；③ `abort.signal` 中止（`:461`、`:525`）；④ 工具审批 `approval-requested` → 进入 `waitingApprovals` 持久等待（`:365-372`、`:609-611`、`:649`）；⑤ 后台任务要求 output schema 且校验警告（`:533-539`）。
- **另一条后端**：runner（真机）把循环交给外部 CLI（`packages/app/agent-runner/src/agent/adapters/{claude,codex,opencode,pi,acp}.ts`），本仓负责进程/工作区/配额/心跳，不实现模型循环。
- **状态持久化**：会话/执行状态落 `online/agent/persistence/{store,state,manager}.ts`，含 native/runner 双绑定的判别（`persistence/state.ts:7-45`）；审批可持久重放（`execution.ts:365-398` 注释「The answer is durable...」）。

> 对我们：如果我们要「自己的 agent 循环」，`native/execution.ts:448-539` 是最值得读的一段（工具注册 + 步数上限 + 审批挂起 + 流式投影），但它重度依赖 `ai` SDK。

---

## 7. 【A6/A7】记忆

- **存储形态**：`app-plugin-knowledge` = 关系库 + **向量索引**。插件声明 migrations（`packages/plugins/app-plugin-knowledge/server/plugin.ts:47-49`），索引后端可插：`pgvector` 与 `sqlite-vec` 两个 extension（`server/extension/pgvector/backend.ts`、`server/extension/sqlite-vec/backend.ts`，注册于 `plugin.ts:11-12,39-44`）。
- **能力面**：`Knowledge`（文档/搜索/提案/快照）+ `KnowledgeIndexing` + `KnowledgeAccess`（`server/tokens.ts` 导出 `Knowledge`、`KnowledgeIndexing`、`KnowledgeAccessResolver`、`DocumentService`、`ProposalService`、`Snapshot*`、`PermissionService`）。
- **溯源**：有快照与提案（`ProposalService`/`KnowledgeSnapshot`），文档级权限（`doc-permissions`）。
- **TTL/老化/冲突消解**：**未找到**（`grep ttl|decay|supersede|老化` 在 knowledge 无记忆淘汰实现）；跨会话召回靠「知识空间 + 向量检索」，不是「会话记忆」。
- 会话侧另有一套 transcript/read-position 的持久化（`app-plugin-agent-sessions` migrations 7 个），但那是对话题，不是记忆库。

> 判：A6 有（DB+向量知识库）；A7 部分（有快照/提案/权限，无 TTL/老化/supersede）。

---

## 8. 【D1–D5】界面

- **技术栈**：React 19 + `react-router`（`app-client.tsx:1-24`）；组件库 shadcn/base-ui + Tailwind（`packages/plugins/app-plugin-foundation/client/components`）。
- **布局范式**：经典「左侧栏 + 顶栏 + 主内容 + 面包屑」的 App Shell（`packages/templates/app-template-default/client/layouts/app-layout.tsx:32-85`）；侧栏可折叠且偏好持久化（`layouts/components/app-sidebar.tsx:44-55`）。页面呈现支持 `content / child-page / dialog / drawer` 四种容器（`plugins.ts:53-68`，模板 `components/route-{dialog,drawer,child-page,overlay}.tsx`）。
- **状态可见性**：agent 会话面有较高可见性——transcript 折叠 thinking/tool 调用、单独展示 plan 与**待审批的 permission 卡片**（`app-plugin-agent-sessions/client/components/transcript-view.tsx:1-3,271-315`），会话列表有未读/「等你允许」标签（`session-list.tsx:483` 及 locales `permission: 'Waiting for your permission'`）。
- **主题/密度/多工作区**：主题 `light | dark | system`（`client/theme/theme-settings.tsx`）+ 密度预设 `compact | default`（`theme-presets.ts:1-3`）；i18n 12 种语言（每插件 `locales/{de-DE..zh-TW}.ts`）。**多工作区 UI 未找到**（多工作区只在 runner 的 worktree/工作目录层面）。

---

## 9. ⭐ 最值得抄的 3 条机制

### 机制 1：显式组合根 + 三面对称的 `define*` 清单（插件 = 普通 npm 包）

```
机制：应用自己写 server/client/cli 三个 plugins.ts 显式 import 插件；插件只需 define* 声明贡献点，
      内核只负责 resolve/校验/装配，不扫描、不猜。
位置：packages/app/app-server/src/plugins/{define.ts:11-82, resolve.ts:18-36, types.ts:70-80}
      + packages/app/app-client/src/plugins.ts:294-352
      + packages/templates/app-template-default/{server,client,cli}/plugins.ts
      + packages/app/app-server/src/application/index.ts:249-290, 355-365
为什么好：我们的 kernel.mjs 靠 discover 扫描 + validateManifest 校验 + topoSort 排序，
      三个都是「运行期猜」；NocoBase 把「加载什么」变成编译期事实，零歧义、可 tree-shake、
      重复注册/坏路径在启动期就报错。我们的贡献点 commands/panels/verifiers 死掉，
      根因就是没有「统一 resolve + 统一装配」这一层。
我们抄到哪：tools/plugin/kernel.mjs —— 砍掉 discover 的隐式扫描与通用 topoSort，
      改成「应用侧显式 plugins 清单 + 每面 definePluginXxx 冻结声明 + resolve/validate 一次过」；
      贡献点从 3 个死字段改成「由装配器真正消费的 contributions」。
```

### 机制 2：客户端插件 → 受校验的路由树 + 分层 React Provider（前端注入 UI 的正解）

```
机制：前端插件不往全局槽里 push，而是声明 routes（带 navigation/breadcrumb/auth/authz/
      presentation/componentLoader）与 reactProviders（root/application/extension + before/after），
      内核 resolveAppClientContributions 统一校验、建树、拓扑排序后交给 react-router 和布局。
位置：packages/app/app-client/src/plugins.ts:70-178（路由/导航/呈现类型）
      :235-266（贡献声明） :467-521（resolve+校验） :1239-1316（provider 拓扑排序+环检测）
      packages/app/app-client/src/runtime/index.ts:127-136, 168-173
      packages/app/app-client/src/app-client.tsx:41-47（reduceRight 包裹）
      packages/templates/app-template-default/client/layouts/app-layout.tsx:37,50-59（菜单从 routes 派生）
为什么好：我们的 panels 是死代码、WorkbenchScene.tsx 手写死面板；NocoBase 让「加一个面板/页面」
      = 声明一个 route + 一个 provider，内核保证路径不冲突、权限继承、顺序稳定、可被别的插件
      override（routeComponentOverrides plugins.ts:169-183,630-705）。这才是可扩展的 UI 注入。
我们抄到哪：apps/vouch-web/src/web-ui/src/app/scenes/workbench/WorkbenchScene.tsx
      —— 把写死的面板区改成「消费 runtime.routes + reactProviders」；
      tools/plugin/kernel.mjs 增加 client 侧 resolve（route id 冲突检查 + provider 层序）。
```

### 机制 3：ServiceProvider 生命周期 + 单一 API 路由装配 + 重复路由检测

```
机制：每个插件贡献 serviceProviders（register/boot/start/ready/shutdown）与 routes；
      应用按固定五阶段启动、把全部 API 贡献塞进一个 Hono 子路由，装配前检测重复路由。
位置：packages/libs/service-provider/src/provider.ts:1-26（五段生命周期）
      packages/app/app-server/src/application/index.ts:225-230（实例化）
      :355-365（registerAll→bootAll→registerRoutes→startAll→readyAll）
      :443-522（单 /api 路由装配） :503（assertNoDuplicateApiRoutes）
      packages/app/app-server/src/plugins/inspect.ts:92-255（装配前可机读快照）
为什么好：我们的 activateAll 只做排序+调用，没有生命周期分段、没有路由冲突检测、
      没有「装配前快照」；插件之间抢同一路由会静默后者失效（Hono 首个匹配胜），
      NocoBase 用 :503 在启动期直接失败，避免死代码。
我们抄到哪：tools/plugin/kernel.mjs 的 activateAll —— 改成显式五阶段生命周期，
      并在激活前跑一遍「贡献点冲突检测」（commands/panels/verifiers 同名冲突直接抛）。
```

---

## 10. 我们不该抄的

1. **三个组合根的「源码级文本手术」编辑器**：`app-cli/src/lib/{client,server,cli}-plugins.ts` + `plugin-registration.ts`（740 行）为了「在用户的应用源码里精确插入 import/数组项、保留注释」而生。我们的插件清单是 JSON/数据，不该有 TS 文本编辑这一层，否则白白引入 AST/格式化的复杂度。
2. **「启用/禁用 = 改源码 + 重新构建」**：NocoBase 明确没有运行时热插拔（`application/index.ts:557-561`），启停要改 `plugins.ts` 再重启。我们要的是「装/卸/启/停」可在管理台即时生效，这段设计不能照搬。
3. **`peerDependencies` 版本矩阵 + 多 DB driver peer**（`app-server/package.json` 里 mssql/oracle/dameng/kingbase/oceanbase…）：企业私有化包袱，我们小内核不需要。
4. **两套 agent 后端 + ACP 桥的体量**：native（`ai` SDK + 虚拟 shell）与 runner（真机 daemon + 5 个 CLI 适配器 + 进程/工作区/配额）加起来远超我们当前形态；只抄 **seam**（`ServiceProvider` + 工具注册 + 审批挂起 + 步数上限），不要抄整套进程编排。
5. **兼容层残留**：`queue.jobs` 字段已废弃但仍在类型/校验/inspect 里留告警（`types.ts:55-62`、`inspect.ts:209-221`、`application/index.ts:388-398`），说明「先加后废」的字段设计会长期拖累；我们定义贡献点时要一次想清楚。
6. **`packages/libs/lifecycle`**：名字像「应用生命周期」，实际是业务工单/计划/评审引擎（`tickets/plan/reviewers`），与本报告 §3 的插件生命周期无关，别被名字误导去抄。
