# pi-main 拆解（可抄实现口径 v2）

> 仓库：`D:\refs\pi-main\pi-main`（注意：真实根目录在 `pi-main/pi-main/`）
> 4,546 文件 / TypeScript / monorepo（npm workspaces）
> 一句话：Pi 是一个**极简、可扩展的 agent harness**（CLI 版 = `packages/coding-agent`），
> 外加一个跑在它 durable 底座上的全功能工作台 `apps/p2`（React Web + TUI）。

---

## 1. 定位与规模

- 两个层次，别混：
  - **产品层 A：`packages/coding-agent`** —— `pi` 命令行（v1.5.2，bin `pi`），TUI 交互、print/json、RPC。这是 v1 说的「8 工具 + 70 示例扩展 + append-only session」。
  - **产品层 B：`apps/p2`** —— React 19 网页工作台 + TUI + 49 个 app 插件，建在 `packages/durable`（pi-durable）之上。
- 证据：`packages/coding-agent/package.json:2-13`（名/版本/bin）、`packages/coding-agent/src/core/tools/index.ts:95-105`（8 工具名）、根 `package.json:5-12`（workspaces）。
- 规模：`packages/` 下 12 个包（agent/ai/chord/codemode/coding-agent/durable/env/evals/mcp/schema/telemetry/tui），`apps/` 下 p2/p2-mac/p3。
- 语言：全 TS（`package.json:6 "type":"module"`，engine node>=22.19）。

## 2. 架构骨架

- 顶层职责：
  - `packages/agent/` —— **纯 agent 循环内核**（`agent-loop.ts` 952 行、`agent.ts` 623 行、`types.ts`）。不依赖 coding-agent，可独立用。
  - `packages/ai/` —— provider/model 抽象，~30 个 provider（`src/providers/deepseek.ts`/`anthropic.ts`/`openai.ts`…）。
  - `packages/coding-agent/` —— CLI 产品：`src/core/`（tools / session-manager / compaction / extensions）、`src/modes/`、`src/extensions/`（4 个内置扩展）。
  - `packages/durable/` —— 「durable runtime」：append-only 会话树 + sqlite/jsonl 存储 + scheduler + task-graph（`src/harness/scheduler.ts` 3375 行、`src/session/session.ts` 83KB）。
  - `packages/tui/` —— 终端 UI 框架（`pi-tui`）。
  - `apps/p2/` —— 全功能应用：`src/web`（React）、`src/hosts`（server/web/tui 入口）、`plugins/`（49 个插件）。
- 依赖方向（单向）：
  - `agent` 不 import `coding-agent`；`coding-agent` 依赖 `@earendil-works/pi-agent-core`（`packages/coding-agent/package.json:44`）。
  - `coding-agent` **不依赖** `durable`（其 package.json 依赖列表无 pi-durable）；`apps/p2` 才依赖 `pi-durable`（`apps/p2/package.json` deps 含 `@earendil-works/pi-durable`）。→ 说明「durable 会话树」是 p2 那套，CLI 版用的是**自己写的** `session-manager.ts`。
  - 强制边界：`scripts/check-entry-graphs.mjs`、`check-ts-imports.mjs`、`check-runtime-deps.mjs`（根 `package.json:20-28`）+ biome（`biome.json`）。
- 「核心/插件」边界：**没有特权核心**——连 codemode/llama/mcp/tool-search 都是扩展，装在 `builtInExtensions`（`packages/coding-agent/src/extensions/index.ts:7-14`，注释明确 `replaceable: true`：第三方实现可顶替内置）。

## 3. 【A12】插件 / 扩展机制 —— 重中之重

**这是一个「扩展即一切」的极简设计，可直接对照我们 `tools/plugin/kernel.mjs`。**

- 插件清单长什么样：
  - 单个扩展 = 一个 `.ts` 文件，`export default function (pi: ExtensionAPI) { ... }`（`packages/coding-agent/src/core/extensions/types.ts:2094`：`export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>`）。
  - 包级清单：`package.json` 的 `pi` 字段，四条资源数组 `extensions/skills/prompts/themes`（`src/core/pi-manifest.ts:4-42`）。校验是手写 `isObject`+`Array.isArray`+`every(typeof==="string")`，**失败静默返回 null，不抛**（`pi-manifest.ts:18-41`）。
- **怎么被发现**：`discoverExtensionsInDir()`（`src/core/extensions/loader.ts:803-835`）三条规则：① `extensions/*.ts|*.js` 直载；② 子目录 `index.ts|index.js`；③ 子目录 `package.json` 的 `pi.extensions` 声明（`resolveExtensionEntries()`，`loader.ts:761-791`）。**只扫一层，不递归**，复杂包必须走 manifest（`loader.ts:801` 注释）。
  - 三个标准位置按序合并去重：项目 `cwd/.pi/extensions/`、全局 `agentDir/extensions/`、显式配置路径（`discoverAndLoadExtensions()`，`loader.ts:840-887`）。
- **怎么装载**：`jiti` 运行时把 TS 直接 import（不清编译），`loadExtensionModule()`（`loader.ts:571-602`）；`moduleCache:false`（`:589`），编译产物/Node 用 virtualModules 别名（`:583-587`、`getAliases()` `:72-132`）。**同进程内 eval，无子进程/无沙箱**。
- **失败怎么报**：`loadExtension()` 把每个扩展的异常吞成 `{ extension:null, error:"Failed to load extension: ..." }`（`loader.ts:646-668`），**一个扩展挂掉不影响其它**；`initializeExtension()` 里 factory 抛错则 `load.discard()` 回滚已注册的 handler/tool（`loader.ts:625-644`）。
- **贡献点**（插件能往宿主加什么，全在 `ExtensionAPI`，`types.ts:1638-1980`）：
  - `registerTool()` `:1717`、`registerCommand()` `:1726`、`registerShortcut()` `:1729`、`registerFlag()` `:1738`、`registerProvider()/unregisterProvider()` `:1907-1923`、`registerToolRenderer()` `:1773`、消息渲染器、`registerMCPserver`（`mcpServers` 见 `:2229`）。
  - 事件面极宽：`on("tool_call" | "context" | "before_agent_start" | "turn_end" | "agent_end" | "session_start" | ...)` 约 30 个钩子（`types.ts:1643-1710`）。
  - 动作面：`pi.setActiveTools/appendEntry/sendMessage/sendUserMessage/getSettings` 等（`types.ts:2238-2254`）。
- **隔离 / 能力限制**：能力面是**类型化的 `ExtensionAPI` 门面**，但扩展跑在同进程 jiti 里，理论上能 `import "node:fs"` 直接碰宿主——**隔离靠 API 约定，不靠进程/沙箱强制**。这点和我们 kernel.mjs 的「冻结 ctx」是同级别约束。
- **热插拔**：`clearExtensionCache()` 清缓存（`loader.ts:145-149`）；`reload-runtime.ts` 示例扩展 + `ctx.reload()`（`types.ts:2307`）；运行时替换后旧实例被 `invalidate()/assertActive()` 标 stale（`types.ts:2213-2216`）。**能重载，但不是每个扩展可单独 disable**（以整体 runtime reload 为主）。

**70 个示例扩展怎么组织**（实测 `packages/coding-agent/examples/extensions/*.ts` = **70 个**，另有 8 个子目录包如 `plan-mode/`、`subagent/`、`gondolin/`）：
- 全是「单文件、`export default (pi)=>`」的扁平产物，一个文件演示一个能力：`plan-mode`、`subagent`、`todo`、`qna`、`questionnaire`、`permission-gate`、`protected-paths`、`confirm-destructive`、`custom-footer`、`status-line`、`theme`、`notify`、`inline-bash`、`git-checkpoint`、`handoff`、`structured-output`…（列表见 `examples/extensions/`）。
- 教科书样例 `plan-mode/index.ts`：一个文件里同时用 `registerFlag:58`、`registerCommand:145/150`、`registerShortcut:162`、`on("tool_call")` 拦 bash `:168`、`on("context")` 过滤陈旧上下文 `:181`、`on("before_agent_start")` 注入 mode prompt `:207`、`on("turn_end")` 追进度 `:258`、`on("agent_end")` 收尾 `:269`、`on("session_start")` 从 `ctx.sessionManager.getEntries()` 恢复状态 `:354`。**这就是「一个扩展怎么覆盖完整功能」的模板。**

## 4. 【A13】MCP / 工具接入

- **MCP 本身就是一个内置扩展**：`src/extensions/mcp/index.ts`（56KB），登记在 `builtInExtensions` 且 `replaceable:true`（`src/extensions/index.ts:13`）。
- 工具暴露命名：`mcp__<server>__<tool>`（`src/extensions/mcp/index.ts:9`、`registerToolRenderer` 正则 `:383-384`）；`registerTools(connection)` 把 server 工具逐个 `pi.registerTool()`（`:388-461`），默认 `exposure:"codemode"`（工具只对 code 模式可见，不进模型直调列表），资源定义也注册成工具（`:489`）。
- 结果回填：走标准 `registerTool` 的 execute，返回 content 数组（同其它工具）。
- 起 server：支持 stdio / streamable-http，OAuth（`src/extensions/mcp/oauth.ts`、`runtime.ts`），配置校验 `validateMcpServerConfig`（`loader.ts:19` 引入）。
- **UI 管理**：`apps/p2/plugins/mcp/` 是一整套 server/worker/web facet（`server.ts`/`routes.ts`/`pages.ts`/`instances.ts`/`credentials.ts`/`probe.ts`/`sign-in.ts`），用户可增删改/探活/登录。CLI 侧还有 `/mcp` 命令注册（`src/extensions/mcp/index.ts:1261`）。
- 变化事件：`pi.on("mcp_servers_change", ...)` 重建工具（`src/extensions/mcp/index.ts:1218`）。

## 5. 【A11】调度 / 后台任务

- **在 `packages/durable`，不在 coding-agent**：`src/harness/scheduler.ts`（3375 行）是任务调度核心，`src/timers.ts`、`src/signals.ts`（sleep/wake 信号）配合；`src/harness/task-graph.ts` 管任务图。
- 形态：把「run/turn」当可中断、可恢复的 task-state，`endToolRound` 里 `maxTurns` 超限就 `endFailedRun(... reason:"turn_limit")`（`src/harness/generation.ts:1297-1306`）。
- **注意**：CLI 版 coding-agent **没有 scheduler/cron**（grep `maxTurn|cron|schedule` 在 `coding-agent/src/core` 无命中）。定时任务能力属于 p2/durable 层。

## 6. 【C1 / C2】agent 循环与停止条件（我们最关心）

- **主循环在 `packages/agent/src/agent-loop.ts`**：`runLoop()` `:172-330`。`Agent` 类（`agent.ts:194`）通过 `createLoopConfig()`（`agent.ts:476-515`）把 `finishTurn/getSteeringMessages/getFollowUpMessages` 注入，然后调 `agentLoop`。
- 一轮的定义 = 模型流式出 `AssistantMessage` → 抽 `toolCall` 执行 → 把 `ToolResultMessage` 塞回 context（`agent-loop.ts:250-296`）。
- **停止条件是「事件钩子族」而非单一 maxTurns**：
  1. 模型返回 `stopReason==="error"|"aborted"` → 硬退（`:254-265`）；
  2. 没有 tool call + 无 steering + 无 followUp → break（`:268-272`、`:310-327`）；
  3. `finishTurn()` 返回 `{action:"end"}` → 退（`:295-301`，`types.ts:256-264`）；
  4. 工具返回 `terminate:true` 且一批全 terminate → 提前结束（`shouldTerminateToolBatch` `:690-692`、`:281`）；
  5. `stopReason==="length"` → 该批 tool call 全判失败不执行（`:272-279`、`:488-513`）；
  6. steering / followUp 队列有货 → 继续（`:304-317`）。
- **关键事实：CLI 产品层没有 turn 上限**。全仓 `coding-agent` 搜不到 `maxTurns`（只有 `durable` 有）。**唯一的上限 `maxTurns` 在 `packages/durable`**：`generation.ts:1274` 读 `agent.maxTurns`，`:1197-1199` 每轮回 +1，`:1297-1306` 到限即 `turn_limit` 失败；校验非正整数抛 RangeError（`src/harness/agent.ts:164-168`）。→ **这正好对上我们 dsh 只有 `maxTurns` 的处境**。
- **循环状态持久化 = 见 §C1 session tree**：每消息 append 到 JSONL，断了可从 leaf 续。

## 7. 【A6 / A7】记忆 / append-only session tree（重点核实 v1「无损压缩」）

**核实结论：v1 的「append-only session tree 支持无损压缩」属实，但要说清楚——「无损」来自 append-only 树本身（历史永不删，可 branch 回任意节点）；「压缩」是另存的 compaction 摘要条目，不是覆盖原历史。**

- 存储形态：**append-only 树，每会话一个 JSONL 文件**。类注释直说（`packages/coding-agent/src/core/session-manager.ts:985-994`）：每条 entry 有 `id`+`parentId` 组成树，`leaf` 指针指当前位置，append 建当前 leaf 的子节点，branch 把 leaf 挪回旧节点形成新分支，**历史不可改不可删**。
- 写入：`_appendEntry()`（`:1199-1214`）push 内存 + `appendFileSync` 逐行写 JSONL（`_persist` `:1195`）；写失败会回滚内存 leaf 防悬空父指针（`:1204-1213`）。
- 各类 append：`appendMessage:1222`、`appendThinkingLevelChange:1235`、`appendModelChange:1248`、`appendCompaction:1279`、`appendBranchSummary`（见 `branchWithSummary`）、`appendCustomEntry:1308`（扩展状态就存这，如 plan-mode）、`appendContextEdit:1378`（分支局部改写，不改旧条目）。
- 分支/回滚：`branch(branchFromId)` 只挪 leaf 指针（`:1592-1603`）；`branchWithSummary()` 挪 leaf 并追加一条 `branch_summary` 摘要（`:1614-1642`）；`createBranchedSession(leafId)` 把 root→leaf 单路径导出成新会话文件（`:1646-1760`）；`forkFrom()` 从源会话 fork（`:1833`）。
- 读上下文：`buildSessionProjection(entries, leafId, byId)` 从 leaf 沿 `parentId` 上溯、遇 `compaction`/`branch_summary` 按规则展开（`:471-583`）。
- 压缩：`src/core/compaction/compaction.ts`（1104 行，纯函数，I/O 交给 session manager，见文件头 `:1-6`）；摘要作为独立 `CompactionEntry` append，文件操作清单 `readFiles/modifiedFiles` 记在 details（`:52-88`）。
- **A7（向量/TTL/冲突消解/跨会话召回）：未找到**。全仓无 embedding / 向量库 / memory TTL / 冲突消解；跨会话只有 `forkFrom` / `session-reference` 式的会话引用。

## 8. 【D1–D5】界面

- 两套 UI：CLI = `pi-tui`（`packages/tui`）；网页 = `apps/p2/src/web`（**React 19**，`react "19.3.0"`）。
- 布局：`apps/p2/src/web/AppLayout.tsx`、`Chat.tsx`、`Code.tsx`、`CostPanel.tsx`、`composer-state.tsx`、`drag-size.ts`/`drawer-swipe.ts`（可拖拽尺寸、抽屉）。TUI 侧 `tui-modes.ts`/`tui-mouse.ts` 等。
- 状态可见性：`CostPanel.tsx` 显示成本；token 用量 `src/core/usage-totals.ts:1-12`（input/output/cacheRead/cacheWrite/cost）+ `footer-data-provider.ts`（11KB footer 数据）+ `cache-stats.ts`。
- 多工作区：`apps/p2/plugins/workspace`、`projects`、`history`、`sessions`。
- 主题：TUI `src/modes/interactive/theme/*.json`；网页 `apps/p2/src/web/elanor.css` + `@earendil-works/design-tokens`。

## 9. ⭐ 最值得抄的 3 条机制

```
机制：8 工具 = 4 原语 + 只读变体，其余能力全靠扩展组合
位置：packages/coding-agent/src/core/tools/index.ts:95-105（ToolName 全集 read/bash/powershell/edit/write/grep/find/ls）
      index.ts:164-211（core 编码只用 read/bash/edit/write；只读组 read/grep/find/ls）
为什么好：我们用「工具太多太散」治不好，根因是把「能力」当「工具」。Pi 只有 4 个会改变世界的原语
          （读/写/改/bash），grep/find/ls 只是只读裁剪；plan-mode、todo、subagent、question、网页搜索
          全是扩展（examples/extensions/*.ts）。工具数不随场景膨胀，场景靠扩展加载/卸载。
我们抄到哪：tools/plugin/kernel.mjs 的工具注册层——把内置工具收敛到 read/write/edit/bash 四原语，
          其余（web/记忆/subagent/问答/PPT…）改写成扩展，按需 setActiveTools。
```

```
机制：append-only session tree + leaf 指针，压缩不覆盖历史
位置：packages/coding-agent/src/core/session-manager.ts:985-994（设计说明）、1199-1214（append）、
      1592-1603（branch 只挪 leaf）、1614-1642（branchWithSummary）、1646-1760（createBranchedSession）、
      471-583（buildSessionProjection 沿 parentId 回溯 + 展开 compaction/branch_summary）
      compaction 独立成条目：src/core/compaction/compaction.ts:1-6,52-88
为什么好：这就是我们 C1「循环状态持久化」一直做不对的形态——不是存一份会滚动的消息数组，而是存一棵
          追加不改的树。压缩＝追加一条摘要、branch 回滚＝挪指针，都无损，断了能 resume、能 fork、
          能从任意历史点开新分支。我们的循环状态现在只有内存 messages，断了就没了。
我们抄到哪：C1 循环状态层 + tools/plugin/kernel.mjs 的会话存储：新建 <session>.jsonl，entry={id,parentId,type,message}，
          leaf 指针，append/branch/projection 三个纯函数照抄。
```

```
机制：finishTurn 决策钩子 = 可插拔的停止条件，而不是硬编码 maxTurns
位置：packages/agent/src/agent-loop.ts:295-301（读 finishTurn 的 {action:"end"|"continue"}）
      agent-loop.ts:690-692/281（工具 terminate 提前结束）、:254-265（error/aborted 硬退）
      packages/agent/src/types.ts:256-264（finishTurn 契约）
      turn 上限单列在 durable：packages/durable/src/harness/generation.ts:1274,1297-1306
为什么好：我们的 agent 循环只有 maxTurns 一个刹车（_清单.md §八.3 已确认）。Pi 把「停不停」做成
          finishTurn(turn,signal)=>decision 钩子：扩展/上层可返回 end/continue，再叠加 error/aborted/
          length/terminate/steering/followup 五种自然信号；maxTurns 只是 durable 层额外的一道保险。
          于是「停止条件族」的扩展不需要改内核。
我们抄到哪：dsh agent 循环（现仅 maxTurns）——加 finishTurn 钩子点 + terminate 透传；maxTurns 保留为兜底。
```

## 10. 我们不该抄的

- **同进程 jiti 无沙箱装扩展**：`loader.ts:571-602` 直接 eval TS，隔离只靠 API 约定。我们的 kernel.mjs 已有「冻结 ctx」，别退回到「靠自觉」。
- **`packages/durable` 的存储/调度重工程**（`scheduler.ts` 3375 行、`session/transaction.ts` 55KB、sqlite/jsonl/cached-storage 多套）：p2 的全功能底座，对我们过重。我们只需要 session-manager 那 200 行 append-only 树，不需要 durable 的 task-graph/事务/多存储后端。
- **CLI 版没有 turn 上限**（`coding-agent` 搜无 maxTurns）：这是它的缺口不是优点，别照抄成「循环永不设限」。
- **超大文件**：`agent-session.ts` 170KB、`package-manager.ts` 95KB、`extensions/runner.ts` 52KB——是历史包袱，别以「一个文件装下所有编排」为荣。
- **70 个示例扩展的「平铺单文件」**适合演示，不适合产品；我们抄机制（一文件一扩展）但要有 manifest + 分类，别真的堆 70 个裸文件。

---

### 附：核实 v1 三句话

| v1 说法 | 核实 | 证据 |
|---|---|---|
| 只 8 个工具 | ✅ 属实（ToolName 恰 8 个；core 编码只用 4 个） | `tools/index.ts:95-105`、`:164-211` |
| 70 个示例扩展 | ✅ 精确 70 个 `.ts`（+8 个子目录包） | `examples/extensions/*.ts`（`Get-ChildItem -Filter *.ts` = 70） |
| append-only session tree 无损压缩 | ✅ 属实：append-only 树 + leaf/branch 无损；压缩是独立摘要条目不覆盖历史 | `session-manager.ts:985-994,1199-1214,1592-1642,471-583`、`compaction/compaction.ts:1-6` |
