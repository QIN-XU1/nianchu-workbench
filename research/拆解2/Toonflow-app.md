# Toonflow-app 拆解（v2「可抄实现」口径）

> 仓库：`D:\refs\Toonflow-app`（1,149 文件，Vue 3 + TypeScript，HBAI-Ltd/Toonflow-app）
> 本地快照：`master`，HEAD `6086cd`，提交时间 **2026-11-05 15:49 +0800**（`git log -1`）。star 数本地无 GitHub 元数据，**未找到**。
> 重点：**画布**。文末第 9 段给出「抄哪个文件、抄哪几行、解决我们哪个痛点」。

---

## 1. 定位与规模

Toonflow 是一个「AI 短剧/漫剧创作工作台」：本地工作区里每个 `.json` 就是一张画布，画布上是一个个「节点插件」（文本/图片/视频/音频生成、素材、分组），右侧浮层 Agent 通过画布工具直接读写这些节点。

- 1,149 文件；主语言 TypeScript + Vue SFC；包管理器 `bun@1.4.3`（`package.json`）。
- Monorepo：`workspaces: ["apps/*","packages/*","packages/multiTenant/*","packages/nodes/*","packages/tools/*","packages/teams/*","packages/ext/*"]`（`package.json:21-28`）。
- 规模分布（文件数，排除 node_modules/dist）：`apps/server` 334、`apps/web` 183、`apps/desktop` 34、`apps/mobile` 16、`apps/updateServer` 8；`packages` 约 500（`packages/nodes` 93、`packages/tools` 78、`packages/i18n` 56、`packages/multiTenant` 46、`packages/ext` 37、`packages/skills` 34）。
- 证据：`D:\refs\Toonflow-app\package.json`（name/workspaces/scripts/patchedDependencies 全在此）。

> 注意 `patchedDependencies`：`@vue-flow/core@1.48.2 → patches/vueFlowCore.patch`。它**改了 vue-flow 源码**（见 §2.4），这是画布能稳定跑分组的前提。

---

## 2. 架构骨架

### 2.1 顶层目录职责

| 目录 | 职责 | 证据 |
|---|---|---|
| `apps/web` | 前端工作台（Vue3 + element-plus + @vue-flow/core），画布就在这里 | `apps/web/package.json`；`apps/web/src/pages/workspace/` |
| `apps/server` | Express 5 后端：路由、Agent 运行时、插件装载、媒体任务、MCP | `apps/server/src/router.ts`（22KB 路由表）、`apps/server/src/app.ts` |
| `apps/desktop` | Electrobun 桌面壳，内嵌 `@toonflow/server` + `@toonflow/web` | `apps/desktop/package.json` deps |
| `apps/mobile` | 移动端壳（复用 web/server） | `apps/mobile/package.json` |
| `apps/updateServer` | 独立更新服务 | `apps/updateServer/package.json` |
| `packages/nodes/*` | **节点插件**（9 个：text/image/video/audio…Generation、frameAnalysis、director3d） | `packages/nodes/` |
| `packages/ext/*` | **文件扩展插件**（5 个：canvasNode/image/md/media/txt） | `packages/ext/` |
| `packages/tools/*` | **工具插件**（12 个：canvas/browser/ffmpeg/sandbox/webFetch/webSearch/workspace…） | `packages/tools/` |
| `packages/teams/*` | Agent 团队插件（storyboardTeam） | `packages/teams/storyboardTeam/team.json` |
| `packages/nodeScaffold|toolScaffold|extScaffold|teamScaffold` | 各插件类型的**构建脚手架 + 运行时契约** | 见 §3 |
| `packages/{multiTenant,providers,i18n,file,mcp,asr,ffmpeg,skills,…}` | 横切能力 | `packages/` |

### 2.2 依赖方向

单向：`apps/*` → `packages/*` 的公开 `exports`，packages 之间只依赖下层契约包。

- `apps/web` 直接 import 服务端类型面：`import { createCanvasMention, … } from "@toonflow/server/agent/mentionSources"`（`canvasHost.vue:33`），`@toonflow/tool-canvas/runtime`（`canvasHost.vue:25`）、`@toonflow/nodes-scaffold/nodeDocument`（`canvasHost.vue:34`）。
- server 的 `exports` 是显式白名单（`apps/server/package.json` exports 段，:6-27），web 只能走这些入口。
- 没有 CI 依赖方向检查：`.github/workflows` 只有 `debug.yml/release.yml/signPath.yml`，**未找到** dep 边界校验脚本。所以边界靠 **package exports + 目录约定**，不是强制。故 B1 判「部分」。

### 2.3 核心 / 插件边界

- 宿主内核 = `apps/web`（画布运行时）+ `apps/server`（Agent/插件装载）。
- 插件 = `packages/{nodes,ext,tools,teams}`，**每一种都是「UMD 单文件 + 文件头元数据注释」**，由 server 扫描目录发现（§3）。
- 边界靠 `exports` 白名单 + `toonflowNodeHost` 全局注入（节点代码不能 import vue，只能从 `window.toonflowNodeHost` 拿），见 `nodeScaffold/index.ts:126-142` 与 `canvas/index.vue:1238-1242`。

### 2.4 对 vue-flow 的补丁（重要）

`patches/vueFlowCore.patch`：
1. `createGraphNodes` 用 `nextNodeLookup` 修 **parentNode 与子节点同批 setNodes 时找不到父节点** 的报错（patch:6-24）——分组/复制粘贴一次性 setNodes 必须靠它。
2. 选择框开始时清空 `selectedNodeIds/selectedEdgeIds`（patch:25-33）——修框选残留。

> 👉 我们 React Flow 用 `parentId` 做分组时同样会碰到「父节点后到」问题；这条补丁是明确的坑位提示。

---

## 3. 【A12】插件 / 扩展机制（重中之重）

Toonflow 有 **5 类插件**：`node`（画布节点）、`ext`（文件扩展/画布节点资源）、`tool`（服务端工具）、`skill`（技能 Markdown）、`agent`（A2A 智能体）。清单在插件市场 UI 里枚举：`pluginMarket/index.vue:391-397`。

### 3.1 插件清单长什么样

**不是 JSON manifest，而是「构建产物文件头的注释 + package.json 版本/README」**：

- 节点：构建时把元数据压进 UMD 第一行（`nodeScaffold/index.ts:95-96`）：
  ```
  /*! toonflowNode:{"displayName":…,"author":…,"github":…,"configRules":[…],"version":…,"readme":…,"serverTool":"…"} */
  ```
  版本取 `package.json.version`（`nodeScaffold/index.ts:77-78`），README 取 `readme.md`（:79-84），可选的 `serverTool` 是内嵌的服务端工具源码（:85-94，≤20MB）。
- 扩展：`/*! toonflowExt:{id,displayName,extensions,resourceKind,version,readme,author,github,icon,configRules} */`，zod 强校验（`apps/server/src/utils/plugins/ext.ts:10-40`）；作者的 `metadata.ts` 只写 `id/displayName/icon/extensions/resourceKind`（`packages/ext/canvasNode/src/metadata.ts:3-9`）。
- 工具：`/*! toonflowTool:{name,displayName,description,author,github,components,configRules} */` + 第二行可选的 `/*! toonflowToolClient:{code,css} */`（`apps/server/src/utils/plugins/tools.ts:24-49`）。
- 团队：`team.json`（`packages/teams/storyboardTeam/team.json`：members/director/writer/reviewer + delegates + tools + skills + knowledge）。

### 3.2 怎么被发现

- 节点：`readdir(nodePlugins.nodesDirectory)` 过滤 `/^[a-z][a-zA-Z0-9]*\.umd\.js$/`，目录名=`${conf目录}/nodes`（`apps/server/src/routes/nodes/get.ts:12-18`；`utils/plugins/nodes.ts:9-10,75-89`）。
- 工具：过滤 `/^[a-z][a-zA-Z0-9]*\.tool\.js$/`（`utils/plugins/tools.ts:69-87`）。
- 扩展：`ext-*.umd.js`（`utils/plugins/ext.ts:42-50`）。
- 内置插件首启通过 `initializePlugins(target, source)` 把 `build/nodes|ext` 拷进 `data/nodes|ext`，用 `initialized` 标记文件 + revision 防重复（`utils/plugins/initialize.ts:4-44`）。
- 前端节点发现：`GET /api/nodes/get` 返回 `{name,displayName,url,enabled,builtin,config}`，前端 `loadRemoteNodes()` 拉列表并后台逐个 `loadNode`（`canvas/index.vue:1297-1354`）。

### 3.3 怎么校验

- 节点元数据：正则截第一行 → `JSON.parse` → 字段类型收窄（`utils/plugins/nodes.ts:14-20,37-55`）；`configRules` 用 `z.array(z.record(z.string(), z.json())).max(100)`（:11,43-44）。
- 安装期校验（`utils/plugins/install.ts`）：≤20MB（:16）、必须含 `toonflowNodeHost`（:131）、必须导出 `toonflowNodes.<name>`（:132）、版本必须更新（`requireNewerVersion` :37）；扩展同理校验 `toonflowExtHost` 与 `toonflowExts['id']`（:158）。
- 工具是**可信服务端代码**，`import()` 后断言 `plugin.createTools`/`validateConfig` 都是函数（`utils/plugins/tools.ts:94-102`）。
- 失败策略：读不出来的插件不出现在菜单，`loadError` 回填列表（`nodes/get.ts:21-28`；`tools.ts:82-85`）。

### 3.4 怎么装载

- 节点（浏览器）：`loadNodeComponent` 用 `<script src>` 加载 UMD，成功后从 `window.toonflowNodes[name]` 取组件；同名只加载一份、force 时加 `?reload=uuid`（`canvas/loadNodeComponent.ts:14-57`）。全局宿主对象由画布注入：`window.toonflowNodeHost = { vue, vueFlow, elementPlus, three, modelIcons, ai }`（`canvas/index.vue:1238-1242`）。
- 服务端工具：`Bun.plugin` 提供虚拟模块 `toonflow:tool-zod`，`import(pathToFileURL(path))` 直接执行（`utils/plugins/tools.ts:15-20,94-97`）——**无沙箱**。
- 节点配套服务：把内嵌 `serverTool` 源码按 sha256 落到 `data/nodes/pluginResources/<name>/server<rev>.tool.js` 再 import（`utils/plugins/nodes.ts:91-119`），并校验缓存文件内容与已装版本一致（:116）。

### 3.5 贡献点（插件能往宿主加什么）

| 插件 | 贡献点 |
|---|---|
| node | 一个画布节点组件 + 声明 `handles`（端口）+ `outputs`（输出）+ 可选 `configRules`（配置表单）+ 可选 `serverTool`（同名服务端工具）+ `readme`；节点还可注册 `node:xxx` 工具给 Agent（`nodeScaffold/src/nodeTools.ts`） |
| ext | 按扩展名接管文件打开方式，或 `resourceKind: "canvasNode"` 把「节点文档视图」挂到宿主（`packages/ext/canvasNode/src/index.vue:17-35` 调 `context.mountNode`） |
| tool | `createTools(ctx)` 返回一批 `ToolDefinition`，进 Agent 工具表（`agent/tools/index.ts:188-196`） |
| team | 一套多成员 Agent 编排（director 委派 writer/reviewer） |
| skill | 一段 Markdown，按需注入 prompt |

### 3.6 隔离 / 能力限制

- 节点运行在**宿主页面同上下文**（同一个 Vue 实例、同一份 DOM），没有 iframe/Worker 隔离；只能通过 `nodeScaffold` 暴露的 `useNode/files/ai/ffmpeg/asr/canvas` 拿能力（`nodeScaffold/src/useNode.ts:22-71`）。
- 服务端工具**完全可信**（注释明说「工具是可信的服务端代码，不是沙箱」`utils/plugins/tools.ts:95`）。
- Agent 调节点工具受权限开关约束：`agentNodeToolPermissions`（`useCanvasTools.ts:4,13`；`agent/tools/index.ts:39-45`）。
- 安装插件必须本机请求 + 用户在宿主确认：`getInstallTarget` → `callControl(connection.id,"confirmPluginInstall",…)`（`utils/mcp/tools.ts:59-75`）。

### 3.7 热插拔

- 装/卸/启用/禁用/改配置全有 REST：`/api/nodes/{install,save,setEnabled,uninstall}`（`router.ts:376-381`）、`/api/ext/*`、`/api/tools/*`。
- 启用状态 = 同目录下一个 `<name>.disabled` 哨兵文件；`setEnabled` 建/删它（`routes/nodes/setEnabled.ts:19-35`），`files.ts` 见 disabled 就 404（`routes/nodes/files.ts:21-25`）。
- 状态存 `conf`：`pluginInstalledAt`、`nodeConfigs`、`toolConfigs`、`extConfigs`（`nodes.ts:141-143`，`tools.ts:61-67`，`ext.ts:52-55`）。
- 前端热更新：安装完成 `dispatchEvent("toonflow:plugin-installed")`，画布监听后 `loadRemoteNodes(name,true)` 重新拉该节点（`canvas/index.vue:388-393,1203-1215`）。

---

## 4. 【A13】MCP / 工具接入（双向）

Toonflow **既是 MCP server，又是 MCP client**——这是它最值得看的接入设计。

### 4.1 作为 MCP server 暴露自己（给外部 Claude/Cursor 用）

- `packages/mcp/src/index.ts`：`createMcpRouter` 用 `@modelcontextprotocol/server` 的 `McpServer` + `NodeStreamableHTTPServerTransport`，实现 `tools/list`/`tools/call`/`resources/list`/`resources/read`（:48-88）。Bearer token + Origin 校验（:92-98）。
- 启动时在**独立端口**只暴露 `/mcp`（默认 10588，最多试 32 个相邻端口），并写 `mcpRuntime<port>.json` 给 stdio 桥用（`apps/server/src/utils/mcp/runtime.ts:58-111`）。stdio 入口 `packages/mcp/src/stdio.ts`。
- 工具表 `appOperations` 在 `utils/mcp/operations.ts`（如 `listNodes`→`GET /api/nodes/get`，:35-46），画布工具由 `createAgentTools` 复用（`agent/tools/index.ts:171-198`）。

### 4.2 作为 MCP client 接入外部 server

- `packages/mcp/src/client.ts:50-91`：`StdioClientTransport` / `SSEClientTransport` / `StreamableHTTPClientTransport` 三选一，15s 连接超时，stderr 脱敏。
- 配置模型 `mcpServerSchema`（`client.ts:17-32`）：stdio{command,args,env,cwd} 或 http/sse{url,headers}，最多 128 个（`utils/mcp/servers.ts:53`）。
- 管理 UI 齐：设置面板 `components/settings/panels/pluginMarket/mcpServers.vue`（24KB）+ `mcpImportForm.vue`（导入 DXT/JSON），路由 `/api/mcp/servers/{list,save,remove,setEnabled,test,importJson,importDxt,…}`（`apps/server/src/routes/mcp/servers/*`）。
- 外部工具并入 Agent：`createMcpAgentTools()` 塞进工具表（`agent/tools/index.ts:24,197`）。

### 4.3 工具调用结果怎么回填（**画布专用，最该抄**）

画布/节点操作**不在服务端直接改 JSON**，而是通过一条「HTTP 控制通道」把调用回推到浏览器执行、再把结果带回：

- 浏览器侧：`lib/mcpControl.ts` 注册 `WorkspaceControl{getState,call,flushSave}`（:10-21），把每个 tool call 转给画布 `context.call`；`useCanvasTools.ts:73-120` 负责超时（默认 120s、developPlugin 360s）、串行、切画布重定向。
- 服务端侧：`utils/mcp/control.ts` 维护 `connections`（SSE），`callControl(connectionId,name,args,signal,directory)` 下发并等回执（:8-23,69-80）。
- 前端工具清单也在握手中上报：`controlStateSchema.tools`（`node:xxx` 名称/参数）最多 10000 条（`control.ts:13-17`）。
- 👉 结果：**「Agent 改画布」= 浏览器里的真实编辑器执行**，天然拿到最新 DOM/尺寸/撤销栈；服务端只做协议与权限。

---

## 5. 【A11】调度 / 后台任务

**没有 cron / 用户定时任务**（全仓 grep `cron|定时` 无产品命中）。有的是**媒体生成的后台任务管理器**，做得很扎实，可抄它的「可恢复状态机」：

- 任务记录 zod schema，五态 `running|interrupted|succeeded|failed|cancelled`（`apps/server/src/utils/media/tasks.ts:40-65`）；带 `checkpoint{assetCount,assets,files,providerData}` 断点（:59-64）。
- 启动/恢复：`start` 建 `state:"running"`（:487），`wait` 时若 `!active && state==="running"` 则 `launch` 重启（:517-521），`interrupted` 可 resume（:521）。
- 取消：`controller.abort`（:212）。
- 清理：每 30s 扫一遍，settled 超过 5 分钟且无操作即删（:587-593，`unref()` 不阻退出）。
- 计费对账：`prepareCharge/settleCharge/releaseCharge`（:325-394）。
- 另有 SSE 心跳保活：`setInterval(...write(": keepalive\n\n"),20000)`（`utils/mcp/control.ts:92`、`utils/media/billing.ts:175`）。

---

## 6. 【C1/C2】agent 循环与停止条件

### 6.1 循环在哪

主循环**委托给 `@earendil-works/pi-coding-agent` 的 `session.prompt()`**，Toonflow 做编排与事件投影：

- `apps/server/src/agent/runtime/index.ts:451-489`：订阅 SDK 事件 → `await session.prompt(content)` → 处理 `compactionError/modelError`。
- 底层流式在 `agent/runtime/requests.ts:330-366`：`for(;;)` 读 `iterator.next()`，`done/error` 收束，413 时 `offloadBytes` 重试（:343-352）。
- 一轮定义 = 模型流 → `tool_execution_start/end`（index.ts:401-422）→ 再进模型；工具结果回填在 `requests.ts` 的工具调用分支。
- 单轮临时对话另一条：`utils/singleAgent/index.ts`（`compaction:{enabled:false}` :223）。

### 6.2 停止条件（比我们多）

`stopReason` 枚举：`pending|stop|length|toolUse|error|aborted|deferred`（`routes/ai/generate.ts:27`）；`requests.ts:364-366` 把 `error/aborted` 转错误、其余按 `stop|length|toolUse` 完成。

实际刹车：
1. `length` → 标 `AGENT_LENGTH`「被长度截断」（index.ts:442-444,492）；
2. `aborted` → 用户停止/超时（`routes/agent.ts:48-50` 的 `stop()` 用 `AbortError("已停止生成")`）；
3. 提问挂起 `question`（`agent/bridge/question.ts`，等待用户选择，超时/取消走 abort）；
4. 工具错误 → 记 `toolFailure` 继续或抛（`requests.ts:61-77`）；
5. 子代理状态 `cancelled|limited|error|completed`（index.ts:516）。

### 6.3 持久化（断了能续）

- 会话是 **workspace 内 `.agent/sessions/<id>.jsonl`**（`agent/runtime/sessions.ts:178,201,402`），逐条 append，支持分支 `history.branch(parentId)`（index.ts:464-472）。
- 消息队列持久化：`delivery.savePendingMessages/sendUserMessage`（index.ts:498-502）。
- 子代理写回父会话：`updateSubAgent`（index.ts:459-462,512-518）。

---

## 7. 【A6/A7】记忆

- 形态：**一份全局 Markdown 文件** `memories/memory.md`（`apps/server/src/utils/personalization.ts:10`），上限 20000 字（:12）。没有向量库、没有 DB。
- 工具：`memory`（`agent/tools/memory.ts:5-36`），`action: read|save`，save 必须带 `revision`。
- 冲突消解：`revision = sha256(content)`；save 时若 revision 不等于当前内容则 409「文档已被其他操作更新」（`personalization.ts:19-21,60-73`）。**乐观锁，不是自动合并**。
- 溯源：靠 prompt 要求「项目相关事实必须注明项目，记录来源/适用范围」（`memory.ts:19-20`），无结构化溯源字段。
- 跨会话召回：全局记忆**自动加载进 prompt**（`memory.ts:18`「全局记忆已自动加载」），因此无需检索。
- TTL/老化：**未找到** → A7 判「部分」。

---

## 8. 【D1–D5】界面

### 8.1 技术栈与布局

- Vue 3 `<script setup>` + Pinia + element-plus + `@vue-flow/core` + `@vue-flow/minimap` + `@tiptap/*`（富文本）+ `three`（3D 节点）+ `@dagrejs/dagre`（自动布局）。`apps/web/package.json`。
- 布局：`pages/workspace/index.vue` = **画布全屏 + 顶部分段切 canvas/document**（:30,152,168-172）+ **右侧浮层 Agent**（`floatingAgent` :113，可 resize `--agentWidth` :2）+ 底部工具条（:29-112）。
- 状态可见性：节点自身有 generating/error/输出预览；Agent 面板有 `stats`（token/耗时/速度）与 `contextUsage`（`agent/runtime/index.ts:448,474,511`）；后台任务有 `taskId/state`。
- 主题/密度/多工作区：`defaultUiSettings = { theme:"dark", language:"system", primaryColor, fontScale:100, mobileScale:75, radius:8 }`（`stores/settings.ts:50`）；多画布 + 多工作区（projectList 在 controlState `control.ts:12`）。

### 8.2 D 维度小结

D1 有（分栏+浮层+面板切换）；D2 部分（画布本身/媒体预览/素材库是可视化，**未找到** diff/图表/dashboard）；D3 有；D4 有；D5 部分（CSS 变量 token + 少量设置项，无主题编辑器）。

---

## 9. ⭐ 画布深挖 + 最值得抄的机制

### 9.1 画布文件格式（核实 v1 结论）

v1 说格式是 `{toonflowCanvas,nodes,edges,viewport}`，**核实为真**，但校验在 `canvasHost.vue:93-99`（:96 就是那一行），**写入在 `canvas/index.vue:705`**：

```js
writeJson(fileName, { toonflowCanvas: true, nodes: flow.nodes, edges: flow.edges, viewport: flow.viewport })
```

`canvasFiles.ts:7` 把它类型化为 `CanvasFile = { toonflowCanvas: true; nodes: Node[]; edges: Edge[]; viewport: ViewportTransform }`。

### 9.2 节点 / 边数据模型（字段级）

- **node**（@vue-flow `Node` + 自定义 `data`）：
  - `id`（非空、不含 `\/\0`、非 `.`/`..`，`canvasFiles.ts:70`）
  - `type`：`"remote-<插件名>"` 或 `"canvasGroup"`（`canvas/index.vue:219,1261`）
  - `position:{x,y}`；`parentNode?`；`extent?`；`expandParent?`；`style?`（分组用 width/height）；`connectable?`；`draggable?`
  - `data`：`label`、`handles: NodeHandle[]`、`outputs: Record<string,NodeOutput>`、以及节点自定义持久字段（文本节点：`prompt/promptModel/model/textPath/textSnapshot`，`nodes/textNode/src/index.vue:96-106`）；`referenceOrder`、`promptModel` 参与复制的引用重映射（`canvasFiles.ts:21-31`）
  - **运行态字段不入盘**：`data/computedPosition/handleBounds/selected/dimensions/isParent/resizing/dragging/events/initialized`（`canvas/index.vue:741-751`；`useCanvasHistory.ts:15-16` 多一个 `data` 的 label-only 处理）
  - `handles` 不手写：`nodeSkeleton` 把组件声明的 handles 同步进 `node.data.handles`（`packages/nodeScaffold/src/nodeSkeleton.vue:636-639`），`outputs` 同步进 `data.outputs`（:641-645）
- **handle**：`{id, type:"source"|"target", dataType: NodeDataType|NodeDataType[], label?}`，`dataType` 含 `"*"` 通配；连接校验 = 两端 handle 存在 + 类型兼容 + 目标端 `isValidTargetPos`（`nodeScaffold/src/connection.ts:7-12,33-55`）
- **edge**：`{id, source, target, sourceHandle?, targetHandle?, type:"simplebezier", animated:false, interactionWidth:40, selectable:false, updatable:false}`（`canvas/index.vue:1356-1367`）；加载时**剥掉 interactionWidth 用统一值**（`canvasMenu.vue:395-396`）
- **group**：`type:"canvasGroup"`，`connectable:false, expandParent:false, style:{width,height}, data:{label}`，子节点 `parentNode=groupId` 且 `position` 变相对坐标（`selectionToolbar.vue:202-218`）

### 9.3 视口持久化与恢复

- **存**：`watch(() => [viewport.x, viewport.y, viewport.zoom], scheduleCanvasSave)`（`index.vue:827`）→ 500ms debounce `saveCanvas`（:699-721）→ 与节点同一份 JSON 写 `viewport`。拖动/缩放都触发；保存队列串行，防慢请求覆盖（:702-720）。
- **恢复**：打开画布读 JSON（`canvasMenu.vue:380-388`）→ `setNodes` → `setEdges` → `await setViewport(nextCanvas.flow.viewport)`（:394-397）。多处校验 `x/y/zoom` 有限且 `zoom>0`（`canvasHost.vue:96-97`、`canvasMenu.vue:383-384`、`canvasFiles.ts:68-70`）。
- **新建**默认 `viewport:{x:0,y:0,zoom:1}`（`canvasMenu.vue:491`）。

### 9.4 节点菜单

- 组件：`components/nodeMenu.vue`（19KB 右键菜单）+ `nodeMenuItems.vue`（节点类型列表）+ `nodeSearch.vue`（搜索）。
- 打开：`openMenu(event, nodesOnly, selection, handle, group)`（`nodeMenu.vue:239-267`），画布双击 `openNodeMenu` 仅当 target 是 `.vue-flow__pane`（`index.vue:657-659`）。
- 添加节点：`addNode(type,{x,y})` → `runCommand` → `addNodes({id:randomUUID(), type, position, data:{label}})`（`nodeMenu.vue:277-282,344-358`）；若从端口拖出则自动 `validateConnection` 建边（:382-405）。

### 9.5 分组（含「拖进分组」）

- 打组/解组/合并：`selectionToolbar.vue:193-222`（groupNodes，算 bbox 后插入 canvasGroup 并改子节点相对坐标）/ `:224-246` / `:249-279`。
- 分组框组件：`components/groupNode.vue`（四角 resize，`startResize/moveResize/finishResize` :89-141；拖动子节点时 `expandParent=false`，松手再贴合 :150-158）。
- 几何核心：`selectionNodes.ts` —— `getSelectionRoots/getSelectionTree`（:3-37，递归父子树，防环）、`fitGroupBounds`（:39-56，按子节点 bbox 反算组框，先算子再算组 `reverse()`）、**`finishGroupDrag`（:58-113，松手时按矩形相交自动 re-parent / 退出分组）**。
- 撤销友好：resize 包在 `batchHistory` 里算一步（`groupNode.vue:93-107`）。

### 9.6 复制 / 粘贴

- 文件：`canvas/nodeClipboard.ts`。设计很巧：
  - 剪贴板文本只放一条**命令串** `toonflow:paste-node:<uuid>`（:5,42,57），真正的节点快照进 **IndexedDB** `toonflow.nodeClipboard`（:10-33，只留最近一次 `latest`）。
  - 复制时剔除运行态字段与 `mediaTask`（:44-55），只保留「分组/尺寸/自定义持久配置」。
  - 粘贴时**严格校验**：node id 去重、parentNode 必须存在且不成环（:66-92）、端口 handle 类型（:75-78）、跨项目引用本地文件则拒绝（:93-97）。
  - 粘贴落地：重映射 id → `addNodes`（相对坐标平移）→ `addEdges` 全部包在 `canvasHistory.batch`（`index.vue:1027-1052`）。
- 画布内副本：`selectionToolbar.vue:156-191`（`duplicateNodes`：`toObject()` 快照 + 每节点 `useNodeEvent().emit("copy")` 拿可复制 data patch + 重映射 `referenceOrder`）。
- 拖拽复制：`flow.onNodeDragStart` 里按快捷键 `startDragCopy`（`index.vue:259-274`；`selectionToolbar.vue:291-356`）。

### 9.7 撤销 / 重做

`canvas/useCanvasHistory.ts`（180 行，整份都可抄）：

- 快照 = `{nodes,edges,key}`，`key` 用「排除运行态字段 + data 只留 label」的 JSON 字符串做去重/相等判断（:22-34）。
- **最多 100 步** `.slice(-101)`（:40-42）；只记结构，不记节点内容/生成结果（注释 :40）。
- 恢复 `restore`：先 `emit("save"/"delete")` 收尾被删节点，再逐字段 `restoreFields`（只回写非运行态字段，:51-58），引用 Map 保住被删节点的 data（:13-14,88-101）。
- 拖拽/批量聚合：`onNodeDragStart` `grouping++`，`onNodeDragStop` `grouping--` 后一次 commit（:146-162）；任何多步操作包 `batch(action)`（:128-144）。
- 切换画布按 binding 重置（:164-176）。

### 9.8 小地图

`components/canvasControls.vue:2-10`：`<mini-map position="bottom-left" :pannable :zoomable nodeColor maskColor @click=setCenter(...)>`，来自 `@vue-flow/minimap`（:122）；`showMap` 默认 false 由按钮切换（:40-50,136）。

### 9.9 自动布局 arrangeCanvas（整幅）

`canvas/arrangeCanvas.ts`（90 行）：

1. `updateNodeInternals` 确保尺寸（:10）；
2. 只排 `!node.parentNode` 的顶层节点，先校验尺寸/位置/可拖（:14-26）；
3. 间距按节点尺寸中位数自适应：`nodeGap∈[96,160]`、`rankGap∈[160,320]`、`groupGap=1.5×`（:28-32）；
4. **dagre `rankdir:"LR"`** 逐连通分量布局（`graphlib.alg.components` + `graph.filterNodes`，:33-58）；
5. 按连通分量**分行排布**（不追全局最紧凑矩形，:59-83）；
6. 应用坐标 + `fitView`（:84-89）；返回 `{snapshot,viewport,arrangedNodeIds}` 供「撤销整理」（`canvasControls.vue:172-208`）。
   - 局部对齐：`arrangeSelection.ts`（horizontal/vertical/grid，:4-6）。

### 9.10 画布工具 API（给 Agent 的编排面）

`packages/tools/canvas/src/runtime.ts:28-112` 定义 18 个操作：`getCanvas / findCanvasNodes / getCanvasNodes / getCanvasEdges / getNodeTools / addCanvas / switchCanvas / renameCanvas / addNode / deleteNodes / moveNodes / renameNodes / connectNodes / deleteEdges / selectNodes / arrangeCanvas / fitCanvas / nodeTools`，每个都有 zod schema + 中文 description（教模型「先 getCanvas 再 getNodeTools 再调用，不要直接改 JSON」）。

### 9.11 ⭐ 三条最值得抄

```
机制：画布文件 = {toonflowCanvas,nodes,edges,viewport} + 「排除运行态字段」白名单 + 500ms debounce 串行保存
位置：apps/web/src/pages/workspace/panels/canvas/index.vue:699-721（写）、:741-751（字段白名单）、:827（viewport 监听）；
      canvasMenu.vue:380-397（恢复 setViewport）；canvasFiles.ts:7,68-74（类型+校验）；useCanvasHistory.ts:15-16
为什么好：它把「拖拽位置持久化」拆成三件事——哪些字段算持久化（白名单，不是全量 JSON）、何时写（debounce+串行，防覆盖）、
        怎么读回（setNodes 后 setViewport）。我们现在是整对象序列化，运行态字段写进盘、慢请求还会覆盖新位置。
我们抄到哪：apps/vouch-web/.../WorkbenchScene.tsx —— 用同一份白名单 reducer 出 `toFlowObject()`，配 500ms debounce + 保存 promise 链。
```

```
机制：撤销/重做 = 结构快照 + 字段级 restore + 拖拽合并成一步（batch）
位置：apps/web/src/pages/workspace/panels/canvas/useCanvasHistory.ts:22-47（capture/commit）、:51-114（restore）、
      :128-162（batch / onNodeDragStart|Stop）、:40-42（100 步上限）
为什么好：不是整图深拷贝，而是「结构 JSON 去重 + 引用保留 data」；拖拽/缩放/分组/粘贴全用 batch 包成一步，
        不会出现「拖一次产生 60 步撤销」。我们 WorkbenchScene.tsx 现在完全没有 undo 栈。
我们抄到哪：apps/vouch-web/.../WorkbenchScene.tsx —— 直接移植这 180 行为 `useCanvasHistory(reactFlowInstance, bindingKey)`。
```

```
机制：Agent 改画布走「HTTP 控制通道」回推到浏览器执行（不是服务端改 JSON）
位置：apps/web/src/pages/workspace/panels/canvas/useCanvasTools.ts:73-120（call 超时/串行/切画布重定向）；
      apps/web/src/lib/mcpControl.ts:10-42（注册 WorkspaceControl）；apps/server/src/utils/mcp/control.ts:8-23,69-80（SSE connections + callControl）；
      packages/tools/canvas/src/runtime.ts:28-112（18 个画布操作 schema）
为什么好：画布状态（尺寸、选中、撤销栈、节点内部编辑态）只存在于前端；让工具调用回到浏览器执行，天然一致。
        我们若让后端直接改 React Flow 的 nodes，会与本地未保存状态打架。
我们抄到哪：apps/vouch-web/... 若加 Agent，直接照搬这个「服务端发 tool call → 前端 canvas context 执行 → 回执」的桥。
```

> 备选第 4 条（直接解决「无分组/复制粘贴」）：
> `selectionToolbar.vue:193-279` + `selectionNodes.ts:39-113` + `nodeClipboard.ts` + `groupNode.vue`。
> 这是 1:1 的「分组 = parentNode + 相对坐标 + bbox 贴合 + 拖入自动 re-parent」实现，React Flow 的 `parentId/parentExtent` 语义可直接映射。

---

## 10. 我们不该抄的

1. **整套插件体系别照搬**：它的插件是「UMD 单文件 + 文件头注释元数据 + window 全局注入 + 服务端 `import()` 无沙箱」。这套是给「桌面端、本机可信、Bun 运行时」设计的；我们的 Web 形态若照抄，会得到一个既无沙箱又难调试的加载器。**只抄「元数据注释 + 目录扫描 + disabled 哨兵 + 安装确认」四点**，装载层用成熟方案。
2. **`node.data.handles` / `outputs` 双向同步**（`nodeSkeleton.vue:636-645`）是「组件即真相、画布只存快照」的权宜；它依赖 mutation 同一个 reactive 对象。React Flow 里照抄会踩不可变数据的坑，建议单向：组件 -> store -> 持久化，不要回写。
3. **`index.vue` 1458 行单文件**把画布、保存、剪贴板、缩放、快捷键、插件加载全塞在一起（`canvas/index.vue`）。**不要抄它的文件组织**；只抄其中的算法片段。
4. **无测试**（0 个 `*.test.*`，grep 全仓）——它的正确性靠运行时防御（大量 `throw new Error("节点已变化")`）。我们抄机制时**必须自带反例测试**，否则会把它「宁可报错」的体验一起抄过来。
5. **旧画布兼容逻辑**（如删除 `remote-videoNode.data.exportProgress`，`canvasMenu.vue:385-386`）是历史包袱，不必抄。
6. **`flow.viewport` 直接塞 JSON**（`index.vue:705`）依赖 vue-flow reactive store 的 ref 解包；我们若照写 `viewport` 要显式 `.getViewport()`。

---

## 附录：34 维判定速览

见 `_cells/Toonflow-app.json`。核心结论：
- **画布（用户最关心）**：A12 插件机制「有」、A13 MCP「有」、D1-D5 界面「部分~有」；画布 5 大件（视口/菜单/分组/剪贴板/撤销）全部「有」且都是独立小文件，**可整文件移植**。
- **最弱**：C3 测试「无」（0 测试文件）、A10 IM「无」、B1 边界「部分」（无 CI 强制）、A11 调度「部分」（只有后台任务机，无 cron）。
