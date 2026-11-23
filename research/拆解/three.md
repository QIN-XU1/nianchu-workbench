# 拆解：pi / open-design / luanyujia-workbench

> 只读源码分析。所有结论标 `路径:行号` 或目录路径。读不到/推断的标「推测」。
> 分析时间：2026-11-15。三个位置均为 main 分支快照（**都不是 git 仓库**，`Test-Path .git` 全为 False）。

**先说三条诚实前提**，否则下面的数字会被误读：

1. **pi 不是「文件数不多」的项目**。4546 文件 / 51.0 MB / TS 源 2656 个文件约 60 万行 —— 比 open-design 的 daemon 还多。它的「精」不在文件数，在**对外暴露的工具面只有 8 个**（见 §pi）。任务描述里「文件数不多」这个前提不成立，我按实测改写了结论。
2. **open-design 的快照是不完整的**。`packages/` 整个目录缺失，而代码里 import 了 19 个 `@open-design/*` workspace 包共 1599 处；也没有 `pnpm-workspace.yaml`、没有 lockfile、没有根 `package.json`、没有 `docs/` `skills/` `plugins/` `tools/` `e2e/`。**所以它的设计系统 token 链路我只读到了一半**（能读的：`apps/web/src/styles/*` 与 `apps/daemon/src/design-systems/*`；读不到的：`@open-design/contracts` 里的 `TOKEN_SCHEMA` 定义本身）。下文凡涉及这一点的都标明。
3. **luanyujia 的 `面板-harness-AI会话.js` 不是「一个 173KB 的面板」**。实测 177,399 字节 / 3,164 行（UTF-8），但其中**只有第 7–813 行（807 行）是 `harness` 渲染器本体**，其余约 2,350 行是**另外 11 个渲染器**被拼进同一个文件。这个发现直接改变了「它是什么模式」的答案（见 §luanyujia）。

---

## 横向对比

| 维度 | pi | open-design | luanyujia |
|---|---|---|---|
| **本质** | 一个**把 agent harness 做成可组合库**的 monorepo + 终端 CLI | 一个**本地优先的 AI 设计工作台产品**（Web + Electron + 本地 daemon），设计系统是它的内容对象 | 一套**方法论 + 脱敏源码摘录**，不是可运行工程 |
| 文件 / 体积 | 4546 / 51.0 MB | 4826 / 89.7 MB | 196 / 21.9 MB（其中 17.7 MB 是 `12-源码照搬`，内含 16 MB 启动视频） |
| 主语言实测 | TS 3399 · JSON 386 · MD 297 · TSX 125 | TS 3104 · TSX 1162 · CSS 166 | MD 93 · JS 22 · MJS 21 |
| 代码量实测 | `packages/` 2656 个 ts/tsx ≈ **599,654 行**；测试 1006 文件 ≈ **292,255 行**（48.7%） | daemon 787 ts ≈ **311,716 行**；web 786 ts/tsx ≈ **463,001 行**；测试 2566 文件 ≈ **796,258 行**；css 166 文件 ≈ **104,455 行** | md 93 篇 **7,763 行**；js/mjs 43 个 **40,643 行** |
| 进程模型 | 单 Node 进程；`tui`/`rpc`/`json`/`print` 四种前端共用同一 `AgentSession` | **三进程**：`apps/web`（Next 16）+ `apps/daemon`（Express + better-sqlite3）+ `apps/desktop`（Electron 壳） | Electron 主进程 + 渲染层 + 内嵌 `webview`（DSH 引擎 UI）+ 按需 MCP 子进程 |
| 状态真相 | **JSONL 会话树**（`id`/`parentId`），分支 = 树路径 | **SQLite + 项目目录**（`.od/app.sqlite` + `projects/<id>/`），前端靠 SSE + 轮询兜底 | **场景 JSON + 引擎会话库**；Shell 内存态为主，顺序交主进程落盘 |
| 扩展机制 | **TypeScript 模块直接加载进进程**（`pi.on()` / `pi.registerTool()` / `registerCommand()`），能力最强也最危险 | 插件市场 + skills(`SKILL.md`) + design-systems(`DESIGN.md`) + 27 个 agent CLI 适配器 | 渲染器表 `renderers.<type> = fn`，按 `type` 查表；**改渲染器不需重启** |
| 对外工具面 | **8 个**：read/bash/powershell/edit/write/grep/find/ls | 无固定集合，取决于接入的 agent CLI | 无工具注册概念；能力靠 `app.*` IPC 桥 + 29 个 `.mjs` 脚本 |
| 前端形态 | 终端 TUI（差分渲染 + CSI 2026）、另有 `apps/p2` Web GUI | 完整 Web 产品：19 语言、528 个组件文件 | Electron 网格面板，37 种面板类型 |
| 有没有测试 | **有，且极重**：1006 测试文件 / 29 万行 | 有，2566 文件 / 79.6 万行 | **没有测试与 CI**（`10-源码/README.md` 自述） |
| 能不能跑 | 能（`npm i --ignore-scripts && npm run build`） | **不能**（快照缺 `packages/`，1599 处 import 无法解析） | **不能**（自述「照抄一定失败」，依赖本机 `app.*`） |

---

## pi

### 一句话定位

**一个把「agent 循环 + 会话树 + 工具 + 扩展契约」做成可单独引用的 TypeScript 库族的 monorepo，`coding-agent` 只是它的一个终端前端。**

证据：`packages/` 下 12 个包按依赖方向严格分层 —— `schema → telemetry → ai → agent → coding-agent`，另有 `chord`（跨进程对象运行时）、`durable`（持久化会话/任务/文档）、`tui`（终端 UI 库）、`mcp`、`codemode`、`env`、`evals`（`packages/*/package.json` 的 `dependencies` 字段）。`README.md:78-90` 明确列出这张表。

### 实测数据（自己数）

| 项 | 数量 | 怎么数的 |
|---|---|---|
| 文件 / 体积 | 4546 / 51.0 MB | `Get-ChildItem -Recurse -File` + `Measure-Object Length` |
| 扩展名分布 | `.ts` 3399 · `.json` 386 · `.md` 297 · `.tsx` 125 · `.mjs` 66 · `.html` 36 · `.css` 27 · `.swift` 22 · `.rs` 17 | 同上 Group-Object |
| workspace 包 | 12（`packages/*`）+ 3 app（`apps/p2` `p2-mac` `p3`） | `package.json` 的 `workspaces` |
| TS 源总量 | 2656 文件 / **599,654 行** | UTF-8 逐文件 `ReadAllText` 切行 |
| 测试总量 | 1006 文件 / **292,255 行** | 同上，`*.test.ts` |
| 测试/源码比 | **48.7%** | 292255/599654 |
| 单包最大 | `coding-agent` 742 文件 / 176,057 行（测试 77,760） | 逐包统计 |
| 次大 | `chord` 842 文件 / 158,760 行（测试 73,307） | 同上 |
| 核心最小包 | `agent` **17 文件 / 7,144 行**（测试 4,243） | 同上 |
| 内置工具 | **8** | `packages/coding-agent/src/core/tools/index.ts:95` 的 `ToolName` 联合类型 |
| 内置扩展 | **4** | `src/extensions/index.ts:8-13`（llama.cpp / codemode / tool-search / mcp） |
| 示例扩展 | **70 个 .ts 文件 + 8 个目录** | `examples/extensions/` |
| 文档 | **42 篇 md** | `packages/coding-agent/docs/` |
| 版本 | 全包统一 `1.5.2` | 各 `package.json` |
| 引擎要求 | Node `>=22.19.0` | 根 `package.json` 的 `engines` |

各包实测（文件数 / 行数 / 测试行数）：

```
agent          17    7,144     4,243
ai            471   83,852    49,546
chord         842  158,760    73,307
codemode       28    5,316     2,116
coding-agent  742  176,057    77,760
durable       285   99,115    55,342
env            22    4,585     1,906
evals          24    3,473       836
mcp            45    8,169     3,177
schema         63    8,875     2,756
telemetry      16    2,719       848
tui           101   41,589    20,418
```

> 另外 `apps/p2` 854 文件 / 162,482 行 —— 这是 Web GUI（React 19.3 + 49 个插件目录）。它**不在**根检查与根测试范围内（`AGENTS.md:84`）。

### 底层架构

**技术栈**（实测自 manifest）：

- 运行时：Node `>=22.19.0`，纯 ESM（`"type": "module"`），**只用 erasable TS 语法**（Node strip-only 模式，`AGENTS.md:38`）
- 构建：`tsc` + `esbuild 0.28.2` 打 bundle；可选 `bun build --compile` 出单文件二进制（`packages/coding-agent/package.json` 的 `build:binary`）
- 校验：`@biomejs/biome 2.3.5` + `typescript 7.0.2`
- 版本锁定：**所有直接依赖钉死精确版本**（`"brace-expansion": "5.0.12"` 而非 `^5`），并有三道 CI 闸：`check:pinned-deps` / `check:runtime-deps` / `check:install-lock`（根 `package.json` 的 `scripts.check`）
- 依赖极克制：`coding-agent` 21 个 direct deps，其中重量级只有 `undici`、`quickjs-wasi`、`@silvia-odwyer/photon-node`；**没有 commander / yargs / chalk 之外的 CLI 框架**（CLI 解析是自己写的 `src/cli/args.ts`，21KB）
- 无 `pnpm` 但 devDeps 里有 `pnpm 11.15.1`（用于发布）；实际 workspace 用 npm workspaces

**目录结构与模块划分**（严格单向，见 `packages/*/package.json` 的 `dependencies`）：

```
schema  ──┬─→ telemetry ─→ ai ─→ agent ─→ coding-agent
          └─→ chord ─→ durable ─→ env
                └─→ codemode / mcp ─→ coding-agent
tui（无内部依赖，只依赖 get-east-asian-width / marked）
```

分层语义：

| 包 | 干什么 | 关键证据 |
|---|---|---|
| `schema` | JSON Schema 构造器，**零依赖** | `packages/schema/package.json` 的 `dependencies: {}` |
| `telemetry` | 厂商中立遥测契约 | 零依赖 |
| `ai` | 多 provider LLM 统一 API；模型目录在 `catalog/` 下按 families/providers 分文件 | `catalog/families/{anthropic,deepseek,google,kimi,openai}.ts` |
| `agent` | **就是 agent 循环本身，7144 行** | `src/agent-loop.ts`(953) + `src/agent.ts`(624) + `src/types.ts` |
| `coding-agent` | 把 agent 包装成 CLI：会话、工具、扩展、compaction、主题、TUI 交互 | 176k 行，其中 `agent-session.ts` 4581 行、`interactive-mode.ts` 7303 行 |
| `chord` | 跨进程对象运行时（契约/facet/热重载） | 158k 行，最大包 |
| `durable` | 持久化会话/任务/文档 | 99k 行 |
| `tui` | 终端 UI 库，**差分渲染 + CSI 2026 同步输出** | `README.md` |
| `env` / `mcp` / `codemode` / `evals` | 环境、MCP 客户端、QuickJS 沙箱脚本、评测 | — |

**状态管理**：

状态真相是**一个 JSONL 文件**。设计见 `docs/how-pi-works.md:22-27` 与 `docs/session-format.md:1-5`：

- 每个 session 是 `~/.pi/agent/sessions/--<path>--/<timestamp>_<id>.jsonl`
- 每条 entry 有 `id` / `parentId`，**构成树**；当前 leaf 决定「活跃分支」，活跃分支就是下一次模型请求的上下文
- 分支 = 从根到 leaf 的一条路径。继续老 entry 就长出新分支，**同一个文件里**
- entry 类型有 14 种：`SessionEntry` 联合（`src/core/session-manager.ts:183`），含 `message` / `thinking_level_change` / `model_change` / `usage` / `compaction` / `branch_summary` / `custom` / `label` / `session_info` / `custom_message` / `context_edit`
- 版本演进到 **v3**，加载时自动迁移（`docs/session-format.md:31-36`）

关键取舍：**append-only + 树 + 投影**。原始 entry 永不改，模型看到的是「投影」——compaction 只是往树里加一条 `CompactionEntry`，旧消息仍在文件里但不进投影（`docs/compaction.md:24-30`）。

**扩展机制**（这是 pi 最值钱的部分）：

扩展是**直接加载进 Node 进程的 TypeScript 模块**，默认导出 `(pi: ExtensionAPI) => void`：

```ts
// docs/extensions.md:76-95
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_e, ctx) => { ctx.ui.notify("Extension loaded!", "info"); });
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event) && event.input.command.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });
  pi.registerTool({ name: "greet", ... });
  pi.registerCommand("hello", { description: "Say hello", handler: async (a, ctx) => {...} });
}
```

可注册的东西（`docs/extensions.md:14-23` 与 `src/core/extensions/types.ts` 2354 行导出）：

- 工具（`registerTool`）、命令（`registerCommand`）、快捷键、provider、虚拟模型、MCP server
- 七类事件钩子：生命周期 / 资源 / 会话 / agent / 模型 / 工具 / 输入
- **能拦截和改写**：`tool_call` 可 `{block: true}`；`context` 事件可改上下文；`session_before_compact` 可自定义压缩
- 能画 UI：`ctx.ui.custom()` 拿整个 TUI 组件能力，示例里有人写了贪吃蛇（`examples/extensions/snake.ts`）和 Doom 覆盖层（`examples/extensions/doom-overlay/`）

**信任模型是「全信」**：扩展同进程、同 OS 权限，能读凭据、改历史（`docs/extensions.md:5-6` 明说）。pi 的对策不是沙箱，是**项目信任（project trust）闸**：项目包只有在你确认信任后才加载（`docs/packages.md:27-31`），且 `README.md:96-101` 直接写「Pi 没有内置权限系统，要隔离请容器化」并给出三种容器方案（`docs/containerization.md`）。

**资源分层**（同一个 npm 包可以带四类东西）：

| 资源 | 形态 | 加载时机 |
|---|---|---|
| 扩展 | `.ts` 模块 | 启动时全加载 |
| 技能 | `SKILL.md` + `scripts/` `references/` `assets/` | **只把 name+description+path 放进 system prompt**，正文按需读（`docs/skills.md:47-51`） |
| Prompt 模板 | 可复用消息文本 | 展开编辑器输入（`docs/how-pi-works.md:19`） |
| 主题 | JSON（56 个 `color` 键 + 8 个 `vars` + 3 个 `export`） | 配色 token |

### 执行逻辑

**一次对话的完整链路**：

```
用户输入
  → [prompt 模板展开 + 文件/图片/粘贴/命令输出转 content]
  → 追加到活跃分支 leaf（新 entry）
  → 组请求：system prompt（base + 发现的 context 文件 + 工具定义 + 技能描述）+ 活跃分支投影 + 模型设置
  → provider 流式返回（可能含 text + toolCall）
  → 记录 assistant 消息
  → 执行每个 toolCall（记录结果）
  → 这一轮结束（turn）
  → 若工具结果或队列消息要求再请求 ⇒ 再开一轮；否则 run 结束
  → 收尾：turn_end → agent_end → [overflow/length 恢复] → compaction
```

证据：`docs/how-pi-works.md:9-17`、`docs/compaction.md:36-46`、`packages/agent/src/agent-loop.ts:47-140`。

**工具注册与调用**：

- 注册分两层：**定义层**（`ToolDefinition`，带 `label` / `promptSnippets` / `guidelines` / renderers）与**运行时层**（`AgentTool`）。两者用 `wrapToolDefinition()` 互转（`src/core/tools/tool-definition-wrapper.ts:29-56`）
- 会话内是**双 Map 注册表**：`_toolRegistry: Map<string, AgentTool>` + `_toolDefinitions: Map<string, ToolDefinitionEntry>`（`src/core/agent-session.ts:507,512`）
- 工具带 `exposure` 分级（`src/core/extensions/types.ts:537`）：`direct`（直接给模型）/ `model-only` / `codemode`（只给脚本）/ `deferred`（不声明，靠 `tool_search` 搜出来）/ `hidden`
- 这套 `exposure` 是给 MCP 用的：MCP 工具默认 `deferred`，所以**接 20 个 MCP server 也不会撑爆 tool 声明**（`docs/codemode.md` 的 `inlineBudget` 3000 tokens）

**并发与取消**：

- 默认**并行执行同一条 assistant 消息里的多个 toolCall**；任一工具声明 `executionMode: "sequential"` 就整批退化为串行 —— `src/agent-loop.ts:520-530`：
  ```ts
  const hasSequentialToolCall = toolCalls.some(
    (tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
  );
  if (config.toolExecution === "sequential" || hasSequentialToolCall) {
    return executeToolCallsSequential(...);
  }
  return executeToolCallsParallel(...);
  ```
- 取消：一条 `AbortSignal` 贯穿；`agent-session.ts` 里为 bash 单独维护 `_bashAbortControllers: Set<AbortController>`（:454），compaction / retry / branch-summary 各有自己的 controller（:437-445）

**上下文管理**（这块是 pi 最成熟的工程）：

- **两套摘要机制**：compaction（上下文超阈值 / `/compact`）与 branch summarization（`/tree` 切分支时）（`docs/compaction.md:17-21` 的表）
- 触发条件：`contextTokens > contextWindow - reserveTokens`，默认 `reserveTokens = 16384`（`src/core/compaction/compaction.ts:128`、`src/core/settings-defaults.ts:11`）
- 保留量：`keepRecentTokens = 20000`（同处 :129）
- 算法：从后往前累加 token 直到 `keepRecentTokens`，得到切点 → 切点前的全部消息交给 LLM 做结构化摘要 → 追加一条 `CompactionEntry{summary, firstKeptEntryId}` → 下次请求用「摘要 + firstKeptEntryId 之后的消息」
- **重复压缩从上次 kept 边界开始**，不是从 compaction entry 开始 —— 避免把上次幸存的消息又吃掉一遍（`docs/compaction.md` 的「On repeated compactions」段）
- **一层兜底**：provider 报 context-overflow 或提前 `stopReason: "length"` ⇒ 触发**一次** compact-and-retry（`_overflowRecoveryAttempted` 标志，`agent-session.ts:439`）
- **工具结果截断**：`DEFAULT_MAX_LINES = 2000` / `DEFAULT_MAX_BYTES = 50KB`（`src/core/tools/truncate.ts:11-12`）；读文件走流式，只保留要显示的行（`src/core/tools/read.ts:73-78` 的 `createReadStream` 可选实现）
- **codemode 再省一层**：模型写 JS 脚本在 QuickJS 沙箱里调工具，**只有脚本输出回到模型**，中间大结果不进来（`docs/codemode.md:3-5`）

**调度机制**：

有两级队列，语义不同（`docs/how-pi-works.md:15`）：

- **steering messages**：在当前 assistant turn 之后插入 ⇒ 相当于「中途改方向」
- **follow-up messages**：等 agent 干完手上的活再进
- abort 时把队列消息**退回编辑器**，不丢

实现在 `agent-session.ts:426-430`（`_steeringMessages` / `_followUpMessages`）。

真正的「调度器」是 agent 循环本身 —— **没有任务图、没有 DAG、没有 cron**。这是刻意的：`README.md:19` 写「Pi ships with powerful defaults but skips features like sub-agents and plan mode」。

### 功能选取

**关键能力清单**：

| 能力 | 位置 |
|---|---|
| 8 个内置工具 | `src/core/tools/index.ts:95-104` |
| 会话树 + 分支 + fork/clone | `docs/sessions.md`、`src/core/session-manager.ts`（4581 行） |
| 自动压缩 + 分支摘要 | `src/core/compaction/{compaction,branch-summarization}.ts`（35KB + 13KB） |
| 四模式前端（interactive/print/json/rpc） | `src/modes/`：`interactive-mode.ts` 7303 行、`rpc-mode.ts`、`print-mode.ts`、`json-event.ts` |
| TypeScript SDK | `src/core/sdk.ts`（18KB），`docs/sdk.md` |
| 扩展系统（事件/工具/命令/UI/provider） | `src/core/extensions/{types,runner,loader}.ts` = 2354 + 1573 + 1320 行 |
| 技能（渐进披露） | `src/core/skills.ts`(14KB)，`docs/skills.md` |
| 包管理（npm/git/本地，带缓存与重装） | `src/core/package-manager.ts` 2968 行 + `src/package-manager-cli.ts` 42KB |
| MCP 客户端（含 conformance 测试） | `packages/mcp`（8169 行）+ `src/core/mcp-servers.ts` |
| codemode（QuickJS 沙箱脚本） | `packages/codemode`（5316 行）+ `src/extensions/codemode/` |
| 工具搜索（BM25，`tool_search`） | `src/extensions/tool-search/` |
| llama.cpp / 本地模型 | `src/extensions/llama/` + `docs/llama-cpp.md`、`nvidia-rtx-llama-cpp.md` |
| 虚拟模型 / 模型路由 | `src/core/virtual-models.ts`、`model-resolver.ts`(25KB)、`model-runtime.ts`(40KB) |
| 主题（含日语/中文宽度适配） | `docs/themes.md`；`packages/tui` 依赖 `get-east-asian-width` / `marked-cjk-friendly` |
| 终端图片（Kitty / iTerm2 协议） | `packages/tui/src/terminal-image.ts`（28KB） |
| LaTeX 渲染 | `packages/tui/src/latex.ts`（37KB） |
| HTML 导出 | `src/core/export-html/` |
| 崩溃上报 / 遥测 | `src/core/{crash-log,bug-report,telemetry}.ts` + `packages/telemetry` |
| 容器化三方案 | `docs/containerization.md`（Gondolin 扩展 / Docker / OpenShell） |

**刻意没做的**（这是 pi 最清晰的自我定位，全在 `README.md:19`）：

> "Pi ships with powerful defaults but skips features like **sub-agents** and **plan mode**. Ask Pi to build what you want, or install a package that does it your way."

「没做」但有**可跑的示例扩展**，这个配对非常聪明：

| 没做 | 示例扩展证明「能做」 | 位置 |
|---|---|---|
| sub-agents | `examples/extensions/subagent/`（含 `agents/` 与 `prompts/`） | `examples/extensions/subagent/` |
| plan mode | `examples/extensions/plan-mode` | 目录 |
| 权限系统 | `permission-gate.ts` / `protected-paths.ts` / `confirm-destructive.ts` | `examples/extensions/` |
| 沙箱 | `gondolin/`（Linux micro-VM） | `examples/extensions/gondolin/` |
| todo / 记账 | `todo.ts` | `examples/extensions/` |
| git 检查点 | `git-checkpoint.ts` / `auto-commit-on-exit.ts` | 同上 |

也就是说：**pi 把「功能」和「扩展点」的边界画在「能不能用 30 行扩展写出来」上**。能，就不进核心。

### 界面

**pi 是终端应用，没有 Web 前端作为主体**。但有两套界面：

**① 主界面：TUI（`packages/tui`，101 文件 / 41,589 行）**

布局骨架（自下而上，`src/modes/interactive/`）：

```
┌─ 顶部：自定义 header（扩展可换）─────────────────────┐
│  状态行 / titlebar-spinner / 模型 / 工作目录            │
├─ 中部：消息流（可滚动，Tool 执行卡片内联）─────────────┤
│  user message  → assistant message（含 thinking 折叠）  │
│  tool call 卡（pending / success / error 三态背景色）   │
│  diff 视图 / bash 执行卡 / 图片（Kitty/iTerm2 协议）    │
├─ widget 区（aboveEditor / belowEditor 两个插槽）───────┤
├─ 编辑器（自定义 editor、自动补全、bracketed paste）─────┤
└─ footer：pwd · git 分支 · token 统计 · 上下文占用 · 缓存命中率 ┘
```

- **footer 的组成**：`pwd`（相对 home 显示 `~/...`，`components/footer.ts:36-51`）+ token 累计 + **上下文占用百分比** + **prompt cache 命中率** + git 分支 + 扩展状态文本（`ctx.ui.setStatus()` 写进 `footer-data-provider.ts:134`）
- token 显示做了压缩格式：`<1000` 原样、`<10k` 一位小数 k、`<1M` 整数 k（`components/footer.ts:26-32`）
- footer 每帧渲染，但 usage 要扫全 session ⇒ 做了带五元组 key 的缓存（session / sessionId / leafId / entryCount / limitsModel 全不变才复用，`components/footer.ts:100-118`）

**颜色体系（有 token，且是 OKHSL 而非 hex）**：`src/modes/interactive/theme/dark.json`

- `vars` 8 个（text/muted/violet/blue/green/red/yellow/blueBg），`colors` **56 个语义键**，`export` 3 个
- 全部用 `okhsl(H S% L%)` 写 —— 显然是为了**亮/暗主题同源可算**（`system-theme.ts` 里用 `oklabToOkhslLightness` 调对比度，:27,:391）
- 亮点：**thinking 强度做成 7 档渐变色**（`thinkingOff` → `thinkingMax`，色相从 229° 一路推到 20°/337°），所以「模型在想多深」是**颜色可读**的，不靠文字
- diff 三色、语法高亮 8 类、markdown 6 类都有独立 token
- **主题 JSON 校验按需加载**：`theme-schema.ts:1-10` 明说「校验需要 typebox，约 17MB 模块图；调色板查找不需要」⇒ 只用内置主题的展示路径永不付这个代价

**② 次界面：`apps/p2` 的 Web GUI** —— React 19.3 + 49 个插件目录，`src/web/style.css` 77KB，`Chat.tsx` 30KB。但它私有（`"private": true`）、不在根检查范围、文档里也没提。**不是 pi 的主界面**。

### 优势

1. **工具面只有 8 个，而扩展面极其宽 —— 这个不对称是设计出来的，不是巧合。**
   - 证据：`src/core/tools/index.ts:95` 的 `ToolName` 联合类型只有 8 个字面量；同时 `examples/extensions/` 有 70 个 `.ts` 示例。
   - 为什么对：每个工具的定义（名称 + 描述 + schema + guidelines）都要进 system prompt，是**每轮都付的固定成本**。8 个工具 ≈ 每轮几千 token 量级；而「能做什么」由扩展决定，扩展的工具数量按需加载（`deferred` exposure + `tool_search`）。**固定成本最小化、可变能力最大化**。
   - 反面对照：很多 agent 项目把「搜索/网页/待办/子 agent/计划」全做成核心工具，工具声明本身就吃掉 1–2 万 token。

2. **把「会话」做成不可变树的 append-only JSONL —— 压缩和分支都是无损的。**
   - 证据：`src/core/session-manager.ts:183` 的 14 种 entry 联合；`docs/compaction.md:24-30` 的「原文仍留在树里」。
   - 为什么对：压缩最怕的是「压完发现压错了，但原文没了」。pi 的做法是 compaction 只是**往树里加一条 entry**，投影时把旧消息排除。所以任何一次压缩都可回退（切回老 leaf 就是压缩前的世界）。这比「重写历史文件」的实现稳健一个量级。

3. **压缩的边界条件被反复打磨过，不是「超了就摘」。**
   - 证据：`docs/compaction.md` 里三条：① 重复压缩从上次 `firstKeptEntryId` 起，保护上次幸存的消息；② `tokensBefore` 从重建后的投影重算，不用旧值；③ overflow / `stopReason: length` 只给**一次** compact-and-retry（`_overflowRecoveryAttempted`，`agent-session.ts:439`）。
   - 为什么对：这三条各对应一类真实 bug —— 消息被连压两次丢掉、token 统计虚高导致无限压缩、失败重试死循环。**这类坑不写注释就一定会被后来的贡献者重新踩**。

4. **扩展的契约（`ToolDefinition`）同时是 UI 契约。**
   - 证据：`ToolDefinition` 里带 `renderShell` / `renderCall` / `renderResult` 渲染器（`types.ts:600-693`），`src/core/tools/renderers/` 给 8 个内置工具各写了一份。
   - 为什么对：工具不只是「返回什么」，还包括「怎么给人看」。把渲染器和工具定义绑在一起，扩展作者写工具时自然会写 UI，不会出现「一堆工具都吐裸 JSON」的局面。

5. **供应链纪律是硬的。**
   - 证据：直接依赖全部钉精确版本；`check:pinned-deps` / `check:runtime-deps` / `check:install-lock` 三道脚本闸；`AGENTS.md:104-113` 写明「lockfile 变更视为需 review 的代码」「新增带 lifecycle script 的依赖需显式 allowlist」；`npm install --ignore-scripts` 是默认姿势。
   - 为什么对：agent 工具的同进程扩展能力等于任意代码执行，供应链是它最真实的攻击面。pi 选择在这一层收紧而不是加运行时沙箱 —— 与其做半吊子沙箱，不如把进入的代码管住。

### 缺点

1. **`agent-session.ts` 单文件 4581 行 / 145 个方法，是这个项目最明显的架构债。**
   - 证据：`wc -l` 实测 4581 行；方法数 145。
   - 什么场景出问题：任何要改「会话生命周期」的需求（新增一种 entry、改 abort 语义、加一类压缩触发）都必须在这个文件里穿行，而它同时持有：工具注册表、扩展 runner、steering/followUp 队列、4 个 AbortController、compaction 状态、model 选择、usage 统计。`interactive-mode.ts` 7303 行同理。
   - 对照：同一项目的 `agent` 包只有 7144 行，`chord` 有严格的「一文件一概念」规约（`AGENTS.md:46`）—— 说明团队**知道**怎么做小文件，但 `coding-agent` 这块没还债。

2. **没有内置权限系统，安全完全外包给使用者 —— 而文档说得很轻。**
   - 证据：`README.md:96-101`「Pi does not include a built-in permission system... By default, it runs with the permissions of the user and process that launched it」；`docs/extensions.md:5-6`「An extension runs inside the Pi process with the same operating-system permissions. It can inspect prompts, tool calls, files, credentials, and session history」。
   - 什么场景出问题：把一个第三方 pi 包（从 npm 或 git 装的）当普通依赖对待 —— 它能在你不知情时读 `~/.ssh`、改会话历史、往外发数据。文档的缓解是「review 第三方源码」和「项目信任闸」，但**项目信任闸只管项目级包，不管你 `pi install npm:xxx` 装的全局包**（`docs/packages.md:27-31` 只写 project packages 需要 trust）。
   - 这跟 pi 自己的「同进程扩展」定位是自洽的，但对「给团队推广」这个场景是硬伤。

3. **跨平台靠「多写一个工具」而不是「一个抽象」。**
   - 证据：`ToolName` 里 `bash` 和 `powershell` 是两个并列工具（`tools/index.ts:95`），各自有独立实现 `bash.ts`(17KB) / `powershell.ts`(3.4KB)、独立 renderer、独立 system prompt 规则（`system-prompt.ts:104-113` 里 `hasBash`/`hasPowerShell` 分支）。
   - 什么场景出问题：模型在 Windows 上仍可能按 `guidelines` 里的 bash 措辞思考（两者都存在时 prompt 是「Use bash or PowerShell for file operations」，:107）；两条路径的测试矩阵翻倍。而且 `powershell.ts` 只有 bash 的 1/5 体量，**能力明显不对等** —— 在 Windows 上它是二等公民。

4. **`chord` / `durable` / `env` 三个大包（158k + 99k + 4.5k 行）与主线的耦合关系，从外部很难判断必要性。**
   - 证据：`chord` 是 158,760 行的「跨进程对象运行时」，只在 `apps/p2`、`durable`、`env` 被用；`coding-agent` 完全不用它（`packages/coding-agent/package.json` 的 deps 里没有 chord）。
   - 什么场景出问题：想只取「CLI agent」这一块的人，会被仓库规模误导 —— 4546 文件里超过 1/3 的代码（chord + durable）跟 `pi` 这个 CLI 无关。`npm run build` 也必须按 `telemetry → schema → chord → tui → codemode → mcp → ai → durable → env → agent → coding-agent` 全链构建（根 `package.json` 的 `build` 脚本把这串 cd 硬编码了）。

5. **版本号与发布节奏不可从快照判断。**
   - 证据：所有包都是 `1.5.2`，根 `package.json` 是 `0.0.3`；`version:patch/minor/major` 三个脚本用 `npm version --workspace packages` 批量刷。
   - 这是「诚实标注」而非「缺点」—— 但它意味着**读快照无法知道哪些 API 是稳定的**。`CHANGELOG.md` 每包一份（12 份），没有统一的上层 changelog。

---

## open-design

### 一句话定位

**一个本地优先（local-first）的 AI 设计工作台产品：把「brief → 原型/设计稿/媒体 → 团队反馈 → agent 迭代」这条链路做成一个带本地 daemon 的 Electron+Web 应用，设计系统（`DESIGN.md`）与 skills（`SKILL.md`）是它的**内容对象**，27 个外部 agent CLI 是它的**执行后端**。**

**它不是设计系统。** 设计系统在它这里是一种**可导入、可评分、可重建的数据资产**：一个目录 + 一份 `DESIGN.md` 就是一个设计系统（`apps/daemon/src/design-systems/index.ts:161` `design: 'DESIGN.md'`），daemon 会解析它、抽 token、算覆盖率、给 grade。

### 实测数据（自己数）

| 项 | 数量 | 备注 |
|---|---|---|
| 文件 / 体积 | 4826 / 89.7 MB | — |
| 扩展名 | `.ts` 3104 · `.tsx` 1162 · `.css` 166 · `.yml` 65 · `.json` 58 · `.md` 48 · `.py` 18 | — |
| app 分布 | `web` 2528 文件/50.08MB · `daemon` 1929/27.15MB · `desktop` 106/2.33MB · `packaged` 56/0.57MB · `closure` 8/0.01MB | 逐目录 |
| web/src | 786 ts/tsx ≈ **463,001 行**；`components/` 下 **528** 个文件 | — |
| daemon/src | 787 ts ≈ **311,716 行**；**37 个 route 文件**分在 `routes/` | — |
| 测试 | **2566** 文件 / **796,258 行**（web 1421 · daemon 1058 · desktop 59 · packaged 27） | 测试/源码 ≈ 1.03:1 |
| CSS | 166 文件 / **104,455 行**；`src/styles/` 占 47 文件 / **77,445 行** | — |
| 颜色字面量 | `src/styles/` 下 raw hex **1221** 处；`var(--…)` **12,199** 处 | 比值 1:10 |
| token 定义 | `tokens.css` **313 行 / 221 个 `--*` 定义** | — |
| 字号阶梯 | `base.css:59-71` **13 档**：12/13/14/16/18/20/24/28/32/36/48/52/64 | — |
| 间距阶梯 | `base.css:72-92` **21 档**：2/4/6/8/10/12/16/18/20/22/24/28/32/36/38/42/48/52/58/62/68 | 非等比，是按实际用到的值收的 |
| 语言 | **19 个 i18n locale** | `i18n/locales/` |
| agent 后端 | **27 个** `RuntimeAgentDef` | `runtimes/defs/*.ts`（含 `pi.ts`、`deepseek-harness.ts`） |
| 集成 | 3 进程（web/daemon/desktop），另 `packaged`/`closure` 两个打包入口 | — |
| Node / pnpm | `~24` / `pnpm@10.33.2` | `AGENTS.md` 环境基线；`.node-version` = 24 |
| 版本 | CHANGELOG 最新正式版 **0.9.0**（2026-05-29），`RELEASE-NOTES-0.10.0.md` 在仓 | — |

**快照缺失（重要）**：`packages/`、`docs/`、`skills/`、`design-templates/`、`design-systems/`、`craft/`、`mocks/`、`tools/`、`e2e/`、`shells/`、`specs/`、`plugins/`、`pnpm-workspace.yaml`、根 `package.json`、lockfile **全部不存在**。

```
Test-Path packages → False   （代码里 import '@open-design/*' 共 1599 处，19 个不同包）
Test-Path pnpm-workspace.yaml → False
Test-Path plugins → False
```

所以：**`web` 与 `daemon` 的内部逻辑可读，但所有跨包契约（`@open-design/contracts`）读不到。** 凡涉及「契约定义在哪」的结论，下面都标「推测」。

### 底层架构

**技术栈**（实测自 `apps/*/package.json`）：

| 层 | 关键依赖 |
|---|---|
| `web` | `next`（Next 16 App Router）+ `react 18`/`react-dom` + `motion`（动画）+ `@lexical/*`（富文本）+ `@excalidraw/excalidraw`（画布）+ `@xterm/xterm`（终端）+ `shiki`（代码高亮）+ `three` + `jspdf` + `dompurify`/`parse5`/`htmlparser2` + `posthog-js` |
| `daemon` | `express` + `better-sqlite3` + `@modelcontextprotocol/sdk` + `node-pty`（终端）+ `chokidar`（文件监听）+ `cheerio`/`htmlparser2` + `pptxgenjs`/`pdf-lib`（导出）+ `@ffmpeg-installer/ffmpeg` + `blake3-wasm` + `prom-client`（指标）+ `posthog-node` |
| `desktop` | 纯 Electron 壳，只依赖内部 8 个包（`@open-design/{contracts,diagnostics,download,host,launcher-proto,platform,release,sidecar,sidecar-proto}`） |

**进程模型（实测可读）**：

```
apps/desktop (Electron 主进程)
   └─ sidecar 客户端边界（@open-design/sidecar）──→ apps/daemon 子进程
                                                        ├─ Express /api/*
                                                        ├─ better-sqlite3: .od/app.sqlite
                                                        ├─ projects/<id>/   ← agent 的 CWD
                                                        └─ spawn 外部 agent CLI（27 种）
apps/web (Next 16)  ── 浏览器/Electron 渲染层 ──→ daemon /api/*
```

证据：`.gitignore` 的运行数据契约注释（`.od` 存 `app.sqlite` / `projects/<id>/` / `artifacts/`）；`AGENTS.md` 的目录说明「`apps/daemon` is the local privileged daemon and `od` bin. It owns `/api/*`, agent spawning...」；`AGENTS.md` 里 `packages/sidecar` = 「the complete business-agnostic sidecar client boundary」。

**状态真相**：

- **服务端权威**：SQLite（`better-sqlite3`，`daemon/src/db.ts`）+ 每个项目一个目录（`projects/<id>/`，agent 的 CWD）
- **前端不自持全局 store**：`apps/web/src/state/` 里最大的是 `projects.ts`（103,672 字节）和 `config.ts`（45,241 字节），都是**模块级缓存 + 函数**，不是 Redux/Zustand。全仓 `useSyncExternalStore` 只用了 **10 处**；没有任何 zustand/jotai/redux 依赖
- **实时更新靠 SSE + 轮询兜底**，而且写得很克制：`hooks/useEventStream.ts:1-34` 的注释说清三件事 —— ① 标签页隐藏 30 秒后**主动关闭** EventSource（连带释放服务端 sink）；② **catch-up 靠重连时重取快照，不靠 Last-Event-ID**（因为事件很薄，不需要服务端事件缓冲）；③ **poll-as-floor**：SSE 连着就放慢轮询，断着就全速轮询 ⇒ 在不支持 SSE 的旧壳/SSR 上**零回归**。同一 URL 的多个订阅者共享一个 EventSource（ref-counted）。

这段注释是整份快照里工程质量最高的 30 行之一。

**依赖方向**：`apps/*` 只能依赖 `packages/*`；`desktop` 只碰 sidecar 边界（`apps/desktop/package.json` 全是 `@open-design/*`，无第三方）。`@open-design/contracts` 是「pure TypeScript web/daemon app contract layer」（`AGENTS.md`）。**但 contracts 本体不在快照里，无法验证。**

**扩展机制（这是它真正的产品架构）**：

四层扩展，从轻到重：

| 层 | 形态 | 注册/发现 | 证据 |
|---|---|---|---|
| **Skills** | 目录 + `SKILL.md`（frontmatter） | daemon 扫多个 root，`id` 冲突时先到先得 | `daemon/src/skills.ts:1-8` 注释 + `:34-36` 的 8 种 `SkillMode` |
| **Design Systems** | 目录 + `DESIGN.md`（+ 可选 manifest） | 导入（GitHub / shadcn / Figma / 手写）→ 抽 token → 评分 | `design-systems/index.ts:161`、`:335`、`:488` |
| **Plugins** | 带 lockfile / trust / marketplace / snapshot 的包 | `plugins/{installer,marketplaces,registry,trust,lockfile,snapshots,verify}.ts`（64 文件） | `daemon/src/plugins/` |
| **Agent runtimes** | 一个 `.ts` 文件导出 `RuntimeAgentDef` | 静态数组 `SHIPPED_AGENT_DEFS` + 本机 local profiles | `runtimes/registry.ts:43-73` |

`SkillMode` 联合类型很能说明它的产品形态：`"utility" | "image" | "video" | "audio" | "deck" | "design-system" | "template" | "prototype"`（`skills.ts:34`）——**它不是「代码 agent 的技能」，是「设计交付物的技能」。**

### 执行逻辑

**一次「做个东西」的完整链路**：

```
① Home composer 提交 brief
     apps/web/src/components/HomeHero.tsx (5,225 行) + ChatComposer.tsx (6,539 行)
     "Chip Rail" 选意图 → 映射到已有 ProjectKind（不新增后端 kind）
     ↓ 见 CONTEXT.md「Home Composer Media Surface」「Chip Rail」
② POST /api/runs  → daemon
     daemon/src/routes/{runs,chat}.ts
③ daemon 组 prompt
     daemon/src/prompts/system.ts:899 `composeSystemPrompt()`
     栈：BASE_SYSTEM_PROMPT (= renderOfficialDesignerPrompt('filesystem'), :439)
        + discovery/philosophy 层 (discovery.ts, 31KB)
        + 当前 design system 的 DESIGN.md
        + 当前 skill 的 SKILL.md（会强制注入 pre-flight 规则让对方先读 seed/references）
        + deck 专用 framework（钉在最后，覆盖前面更软的措辞）
        + PROMPT_INJECTION_RESISTANCE (:1037,:1048)
④ 选 runtime 并 spawn
     daemon/src/runtimes/registry.ts → defs/<agent>.ts
     27 种：claude / codex / opencode / amp / aider / copilot / cursor-agent /
            qwen / qoder / kimi / kiro / kilo / vibe / devin / hermes / trae-cli /
            antigravity / grok-build / mimo / reasonix / atomcode / byok-opencode /
            deepseek / deepseek-harness / pi / amr / codebuddy
     两种协议：ACP（agent-protocol/acp/）与 pi RPC（agent-protocol/pi-rpc/）
⑤ 事件流回前端
     runtimes/{claude,codex,copilot,opencode,qoder}-stream.ts → 归一化 → SSE
⑥ 防线：tool-loop-guard + retry-policy + failure-classification
     daemon/src/tool-loop-guard.ts / run-retry-policy.ts / run-failure-classification.ts
⑦ 产物落盘 + 版本快照
     run-artifact-fs.ts / run-html-version-snapshots.ts / run-produced-files.ts
⑧ 评审回路
     daemon/src/critique/orchestrator.ts (37,785 字节) + conformance.ts (12,969)
⑨ 交付
     pdf-export.ts / deck-export.ts / handoff.ts / deploy.ts
```

**工具注册与调用**：

open-design **自己不定义工具集** —— 它的工具来自：① 各 agent CLI 自带的工具；② MCP server（`daemon/src/mcp*.ts` 共 10 个文件）；③ 它自己的 `od` CLI 暴露的 MCP server（`.claude-plugin/marketplace.json` 的 description：「OpenDesign MCP server (stdio). **139 skills** + projects/files/preview tools, served by your local `od` daemon」）。

它做的是**工具事件归一化**：不管底层是 Claude 的 stream-json、Codex 的 json-event、还是 ACP，都归一成同一种 `tool_use` / `tool_result` 事件 —— 这正是 `tool-loop-guard.ts:14-16` 敢说「a single run-scoped instance covers all of them」的原因。

**上下文管理**（这块有一个非常亮的细节）：

- 系统提示是**稳定前缀**（stable prefix），一旦某个字节变了就得整块重发，并且**把下游的 prompt cache 全部作废**
- `daemon/src/prompts/stable-sections.ts:1-35` 给这件事写了 30 行注释和一个 `SECTION_INPUTS` 归因表：把每个输入分组到它归属的 section（`memory` / `intent` / …），这样 cache miss 时能报「是哪个输入导致前缀漂移」，而不用人去 diff Langfuse trace
- 关键不变量（`:26-28` 原文）：「the sha256 over the whole composed block (`stablePromptHash`) is the only source of truth for cache hit/miss. **Section hashes are attribution metadata and must never gate a re-send decision**」—— 归因表可以错标，但**绝不能因此漏发或伪造一次重发**
- 还有个真实教训（`:38-44`）：`intent` 里的信号原本每轮重算 ⇒ 前缀中途翻转 ⇒ 现在**按会话 latch**（#5709）

**记忆**：

- 文件系统 Markdown store：`<dataDir>/memory/MEMORY.md`（索引，一 bullet 一 fact）+ `<type>_<slug>.md`（正文 + frontmatter）+ `.config.json`（开关）（`memory.ts:1-23` 的注释就是完整规格）
- frontmatter 明确写着「matches **Claude Code's auto-memory pattern**」（`:11`）
- 两条写入路径：① `memory.ts` 里的正则启发式（只抓显式标记 "remember:" / "记住" / "我喜欢"）；② `memory-llm.ts`（1,413 行）**fire-and-forget 的小模型抽取**，专门抓隐式偏好/角色/在办上下文，`chatExtractionEnabled` 控制开关
- 变更通过 `memoryEvents` EventEmitter → `/api/memory/events` SSE → 前端自动刷新（`memory.ts:44-48`）
- 依赖方向刻意做轻：「The store is intentionally dependency-free」（`:21`），复用 design-systems 的 `frontmatter.ts`

**调度**：

- `routines.ts` + `automation*.ts`（4 个文件）＝定时/自动化
- `run-retry-policy.ts:12` 把「同一次 run 内自动重试」**硬限为 1 次**（`DEFAULT_SAFE_RUN_RETRY_MAX_ATTEMPTS = 1`），并按失败类别给不同 backoff（rate_limit 基数更大）
- 中断恢复：`run-restart-recovery.ts` + `agent-session-resume.ts`；`POST_TOOL_RESUME_CONTINUATION_PROMPT`（`run-retry-policy.ts:19-22`）明确告诉 agent「已提交的工具结果算完成，别重跑」

**并发**：`run-steering.ts`（中途 steer）+ `chat-run-lifecycle.ts` + `chat-run-records.ts`。前端侧 `HomeRequestConcurrencyRejection` / `AmrConcurrencyDialog` 说明有显式并发闸与拒绝路径。

### 功能选取

**关键能力清单**：

| 能力 | 位置 |
|---|---|
| 27 个 agent CLI 适配 | `daemon/src/runtimes/defs/*.ts` |
| 两种 agent 协议（ACP / pi RPC） | `daemon/src/agent-protocol/{acp,pi-rpc}/` |
| 设计系统导入（GitHub / shadcn / Figma） | `design-systems/{github-import,shadcn-import,figma-extract}.ts` |
| **token 契约与评分** | `design-systems/{token-contract,token-evidence,token-contract-rebuild}.ts` |
| 设计系统 showcase 生成 | `design-systems/showcase.ts`（40KB，把 DESIGN.md 渲成一整张产品落地页） |
| 技能注册（8 种 mode） | `daemon/src/skills.ts` |
| 插件市场（installer/lockfile/trust/snapshot/marketplace） | `daemon/src/plugins/`（64 文件） |
| MCP（10 个模块 + 139 skills 的 stdio server） | `daemon/src/mcp*.ts` + `.claude-plugin/marketplace.json` |
| 评审回路 | `daemon/src/critique/`（27 文件，orchestrator 37KB） |
| 记忆（MD store + LLM 抽取 + SSE） | `memory.ts` / `memory-llm.ts` + 4 个模块 |
| 媒体生成（图像/视频/音频） | `daemon/src/media/`（23）+ `media-adapters/`（5） |
| 幻灯片/PDF 导出 | `deck-export.ts` / `pdf-export.ts` / `pptxgenjs` |
| 协作与评论 | `daemon/src/collab/`（113 文件）+ `apps/web/src/collab/`（36）+ `components/share/`（41） |
| 实时通道（SSE + 轮询兜底 + 共享连接） | `apps/web/src/hooks/useEventStream.ts` |
| 终端（xterm + node-pty） | `daemon/src/terminals.ts` + `routes/terminal.ts` |
| 可观测性 | `daemon/src/{observability,metrics,logging}/` + `langfuse-*.ts` + `prom-client` + PostHog |
| 打包与自动更新 | `apps/packaged` + `tools/pack`（**缺**） |
| i18n 19 语言 | `apps/web/src/i18n/` |

**刻意没做的**：

1. **不做「代码编辑器」** —— 它是设计工作台，不是 IDE。对比 pi 的 8 个文件系统工具，open-design 的 agent 用自己 CLI 的工具。
2. **不给单一 agent 做深度绑定** —— 27 个适配器 + 「do not restore apps/nextjs」这种历史包袱警告（`AGENTS.md`）都说明它在**避免被任何一个 agent 的 API 绑住**。
3. **不做服务端渲染的设计稿存储格式** —— 产物是**文件**（`projects/<id>/`），不是数据库里的 JSON 文档。所以 agent 可以直接 `Read`/`Edit`，跟人的工作流一致。
4. **不做「设计系统即代码」的编译步骤** —— `DESIGN.md` 是 Markdown，daemon 每次需要时解析（`showcase.ts` 的注释说「Same parsing utilities as preview.js — kept inline rather than imported **so the two views can evolve independently**」）。这是刻意的重复换独立演进。
5. **不做 Windows 一等公民** —— `AGENTS.md`「Windows native is best-effort」；`better-sqlite3` 在 win32/Node24 无预编译需现场 node-gyp 编译。

### 界面

有完整前端（`apps/web`，528 个组件文件 / 46.3 万行 tsx+ts / 7.7 万行 CSS）。

**布局骨架**（三层壳）：

```
WorkspaceTabsBar（44px，跨项目标签栏，可拖拽，-webkit-app-region: drag）
  └─ workspace-shell__body
       ├─ EntryShell  ← Home / projects / plugins / design-systems /
       │   │             library / brands / integrations / tasks / settings…（18 个 view）
       │   ├─ EntryNavRail（左侧导航栏，236px，可折叠）
       │   └─ Entry main（居中 hero + 最近项目 + 插件区）
       └─ ProjectView ← 项目内
           ├─ 左：ChatPane / ChatComposer
           └─ 右：FileWorkspace / FileViewer（20,131 行的巨兽）
```

证据：`src/styles/shell.css:1-28`（`.app` 是 `grid-template-rows: auto 1fr`；`.workspace-shell` 是 `grid-template-rows: 44px minmax(0, 1fr)`）；`src/styles/home/entry-layout.css:1-15`（`--entry-rail-width: 236px`）；`src/router.ts:16-40`（18 个 `EntryHomeView` 字面量）。

**导航层级**：

- **一级**：`WorkspaceTabsBar` 的 44px 顶栏（项目标签，可拖拽，`-webkit-app-region: drag` ⇒ 无框窗口）
- **二级**：`EntryNavRail`（图标+文字的左栏，可折叠成 icon-only；含账户区、账单 chip、Recents、Community、Team 区）
- **三级**：视口内的 tab / panel（Design Files、Artifacts、Design Browser、Terminal、Theater、Memory…）

**信息密度**：这是它最极端的地方 ——

- `FileViewer.tsx` **20,131 行 / 874 KB**
- `ProjectView.tsx` **16,253 行 / 748 KB**
- `SettingsDialog.tsx` **9,036 行 / 373 KB**
- `ChatPane.tsx` **6,459 行 / 320 KB**；`ChatComposer.tsx` **6,539 行 / 270 KB**

单个组件文件 2 万行（≈ 一个中型项目）是明确的架构缺陷，不是密度优点。

**状态呈现**（做得细）：

- loading：`components/Loading.tsx` 的 `CenteredLoader`
- 错误：`TooltipLayer` / `Toast` / `MemoryToast` / `ProjectWorkspaceRecoveryTip` / `UpdateDialog`
- 进度：`useGlideIndicator` + `projectRunStatus.ts`（97,912 行到 14,665 字节的 run 状态机）
- **成本**：`components/CodingPlanUsage.tsx` + `WorkspaceQuotaPopover.tsx` + `AmrArtifactUpgradeGate` + `HomeAmrBalanceGateDialogs` ⇒ 余额/配额是一等公民，且在**提交前**就拦（gate dialogs）
- 按钮的瞬时成功态：`ghost.is-success-flash`（2 秒绿闪 + `role="status"` 隐藏 live region，`primitives.css:76-96` 有完整理由注释）

**颜色体系（这是它的核心资产，也是最能验的部分）**：

`src/styles/tokens.css` 313 行 / **221 个自定义属性**，结构非常清晰：

| 组 | 内容 |
|---|---|
| 中性面 | `--bg` `--bg-app` `--bg-panel` `--bg-subtle` `--bg-muted` `--bg-elevated` + 3 档 `--bg-fill-*` |
| 描边 | `--border` `--border-strong` `--border-selected` `--border-soft` |
| 文本 5 档 | `--text` `--text-strong` `--text-muted` `--text-soft` `--text-faint` |
| accent | `--accent` `-contrast` `-strong` `-soft` `-tint` `-hover` |
| **品牌绿** | `--brand:#87ea5c` `-weak` `-soft` `-text` + **`--brand-ink/--brand-surface`**（选中态专用对，注释说清楚了为什么不能复用：`#00D007` 在底色上只有 ~2.0:1，不达 WCAG AA） |
| 语义色 5 组 | green/blue/purple/red/amber，每组 `-bg` `-border` 用 `color-mix()` 派生 |
| 项目类型 tag | prototype / live-artifact / web-clone / slide / media 各一对 ink+tint |
| 阴影 4 档 | `--shadow-xs/sm/md/lg` |
| **z 轴 2 档** | `--z-hint: 4000` / `--z-menu: 9000`，注释写明「menu ABOVE hint is the point, not an accident」+ 承认还有约 40 个 z-index 字面量是 ad-hoc |
| 圆角 | 1 套几何命名（`--radius-{none,small,medium,large,xlarge,2xlarge,circular}`）+ 1 套语义别名（`--radius-{xs,sm,,md,lg,xl,2xl,pill}`），注释说 off-scale 值（7px/9px/10px）是 drift，要收敛 |
| 动画 | 8 档时长（50/100/150/200/250/300/400/500ms）+ 4 条贝塞尔曲线 |
| 字体 | `--sans/--serif/--mono`，`--prose-font-size: 13px`、`--code-font-size: 13px` |

**主题实现三路同源**（这是可抄的工程点）：`:root`（浅色）+ `[data-theme="dark"]` + `@media (prefers-color-scheme: dark) { html:not([data-theme]) }` ——**同一组变量定义三遍**（`tokens.css:4` / `:227` / `:290`）。用重复而不是 `@import` 是为了让「系统模式 = 没有 data-theme 属性」这个语义成立。

材质层独立成文件：`src/styles/material.css` 给了 4 档模糊（8/16/24/40px）+ 每档一个 `-backdrop` 组合变量（`blur + saturate(1.6)`），并把**无障碍降级写在 token 层**（`prefers-reduced-transparency` 时变量直接退回实色，所有消费者一次性降级）。

**文字排版基线是一条「500」的声明**：`base.css:50-56` 的 12 行注释解释为什么 `@font-face` 的 `font-weight` 写 500 而不是 400（文件只有一份 Regular，500 是**声明这份字节是哪一档**，让 CSS Fonts 4 的匹配规则选它而不是合成加粗）。

**token 体系怎么做（回答任务里的问题）**：

它是**两套并存，各管一段**：

**A. 产品自己的 UI token**（`apps/web/src/styles/tokens.css`）
手写 CSS 自定义属性，221 个，带长注释解释每个决策。**这是给人读的、给设计师/前端协作的。**

**B. 设计系统的 token 契约**（`apps/daemon/src/design-systems/token-contract.ts`）
这是**机器算的**，给 AI 用的，分四层：

| 层 | 含义 | 代码 |
|---|---|---|
| `A1-identity` | 品牌身份必需 token（如 `--bg` `--surface` `--fg` `--accent`） | `token-contract-rebuild.ts:43` `KEY_A1_TOKENS` |
| `A1-structure` | 结构必需 token | 同上 `TokenLayer` |
| `A2` | 可回退到默认值的 token | `token-contract.ts:240` |
| `B-slot` | 别名槽（指向别的 token） | `token-contract.ts:231` |

流程：
1. **取证**（`token-evidence.ts:53-75`）：扫源文件，用 10 条正则抽 `#hex` / `rgba()` / `hsla()` / `--custom-prop` / `font-family` / spacing px / `border-radius` / `box-shadow` / Tailwind 里的 hex
2. **绑定**（`token-contract.ts:152`）：对 `TOKEN_SCHEMA` 里每个 spec，按 `ROLE_HINTS` 的 `needles`（名字匹配）+ `validator`（值类型校验）去找最像的源 token，给出 `confidence: high|medium|low|fallback|alias` 和 `reason`
3. **评分**（`token-contract.ts:297-298`）：
   ```ts
   const score = Math.max(0, Math.min(100, Math.round(
     (a1Coverage * 0.7 + nonFallbackRatio * 0.2 + nonAliasRatio * 0.1) * 100
   )));
   const grade = score >= 80 ? 'excellent' : score >= 60 ? 'usable'
               : score >= 40 ? 'needs-review' : 'needs-rebuild';
   ```
   **A1 覆盖率占 70% 权重** —— 也就是说「你的品牌身份 token 有没有真的接上」是主要判据
4. **重建**（`token-contract-rebuild.ts`）：分数不够就给 `recommendRebuild` 决策，生成 patch
5. **自证**（`report.selfCheck`）：`{ok, errors, warnings}` + 完整 `tokens[]` 逐条绑定证据

**诚实边界**：`TOKEN_SCHEMA` 本体的定义在 `@open-design/contracts/design-systems/token-schema`（`token-contract.ts:1-5` import），**该包不在快照里**，所以「schema 具体定义了哪些 token」我只能从 `token-contract.ts:78-104` 的 `DEFAULT_TOKEN_VALUES`（约 28 个默认值）反推：`--bg` `--surface` `--fg` `--muted` `--border` `--accent` `--font-display` `--font-body` `--text-{xs..4xl}`(9档) `--leading-{body,tight}` `--tracking-display` `--section-y-{desktop,tablet,phone}` `--container-max` `--container-gutter-{desktop,tablet,phone}`。**这是推测，不是实读。**

**字号阶梯 / 间距体系 / 圆角阴影动画**（上表已列）：字号 13 档（12→64）、间距 21 档（2→68 非等比）、圆角 7+9 档双命名、阴影 4 档、动画 8 档 × 4 曲线。

**颜色字面量的真实状况**：`src/styles/` 下 **1221 处 raw hex vs 12,199 处 `var()`** —— 比值 1:10。也就是说 **token 化做到了 ~91%**，但仍有 1221 处硬编码，`tokens.css` 自己的注释也承认「Roughly forty other z-index literals are still ad-hoc」。这是个**诚实的中期状态**，不是「已完成」。

### 优势

1. **把 prompt 前缀当成有成本的字节序列来工程化 —— cache 命中率是一等指标。**
   - 证据：`prompts/stable-sections.ts` 的 `stablePromptHash` 不变量 + 归因表；`prompts/system.ts:899` 的 `composeSystemPrompt` 分层栈（base → discovery → DESIGN.md → SKILL.md → deck framework 钉最后）。
   - 为什么对：长会话的 agent 里，prompt cache 命中率直接决定成本（通常 5–10 倍差价）。大多数项目只在「别乱加时间戳」这个层面注意；open-design 把「哪个输入导致前缀漂移」做成了可观测字段（`stable_prompt_cache_miss_reason`），并且**明确禁止归因表反向影响发送决策** —— 这条不变量防止了「归因 bug 变成漏发 bug」。

2. **`useEventStream` 的「共享连接 + 快照补偿 + 轮询兜底」三件套，是所有带实时 UI 的产品的正确解法。**
   - 证据：`apps/web/src/hooks/useEventStream.ts:1-34`。
   - 为什么对：① 标签隐藏就关流 → 省客户端连接 + 服务端 sink（`res.on('close')`）；② 不用 Last-Event-ID 补洞，重连时重取快照 → **服务端不需要事件缓冲**，实现简单一个量级；③ poll-as-floor → 在 SSE 不可用的环境（旧壳的 `od://` 代理会缓冲 SSE、SSR/测试无 EventSource）**零回归**；④ 同 URL ref-count 共享 → 一个页面 4 个订阅者只占 1 个浏览器连接（浏览器对单 host 只有 ~6 个）。
   - 这是「降级不是 fallback，是设计的一部分」的范本。

3. **`tool-loop-guard` 用「归一化事件流」而不是「各 agent 各写一套」来治死循环。**
   - 证据：`daemon/src/tool-loop-guard.ts:14-31`，两个独立触发器：① **连续失败** N 次（成功就清零，因为成功是真进展）；② **同一 (tool, action) 签名失败** K 次（**只读成功不清零**，因为卡住的 agent 常常反复重读）。
   - 为什么对：它挂在「每个 agent 都吐的 tool_use/tool_result 归一化事件」上，所以一个实例覆盖 27 种后端。触发它的真实事故写在注释里（把按钮移进 `titlebar-left`，真实 class 是 `tb-left`，80+ 次调用、19 次报错，全在同一个虚构标识符上打转）—— **这类注释比任何设计文档都有说服力**。
   - 「只读成功不清零」这个细节尤其对：它区分了「进展」和「忙」。

4. **重试策略把「同 run 内自动重试」硬限为 1 次，且中断恢复有明确续跑语。**
   - 证据：`run-retry-policy.ts:12` `DEFAULT_SAFE_RUN_RETRY_MAX_ATTEMPTS = 1`；`:19-22` 的 `POST_TOOL_RESUME_CONTINUATION_PROMPT`（「已提交的工具结果算完成，别重跑」）。
   - 为什么对：一次失败可能瞬时可能结构性，重试 1 次能区分两者；无限重试是最贵的 bug。续跑语显式列出「别重跑工具」是因为模型看到历史里的 tool_result 会本能重放 —— 这个提示词是在**修一个具体的模型行为**，不是通用套话。

5. **设计系统是「可评分的数据」而不是「一份文档」—— 这一条决定了它的 AI 可行性。**
   - 证据：`token-contract.ts:297` 的加权评分公式；`token-evidence.ts` 的 10 条抽取正则；`token-contract-rebuild.ts` 的 `recommendRebuild` 决策。
   - 为什么对：让 AI「按设计系统做」的最大障碍是「设计系统是散文」。open-design 把它变成 `{name, value, layer, confidence, reason, sources[], sourceName?}` 的绑定表（`token-contract.ts:17-24`），每个 token 都有**证据来源**。这样模型可以机械地消费，而人也可以审计「这个 `--accent` 是从哪一行 CSS 推出来的」。
   - 顺带：`showcase.ts`（40KB）把 `DESIGN.md` 直接渲成一整张产品落地页 —— 这是**给设计系统做可视化验收**的廉价办法。

6. **供应链/发布纪律比 pi 更制度化，但代价是复杂度。**
   - 证据：`plugins/lockfile.ts` / `plugins/trust.ts` / `plugins/verify.ts` / `plugins/snapshot-diff.ts` + `plugin_manager` 里的 `engines.dsh` 版本约束概念。
   - 为什么对：插件市场要能长，必须有 lockfile + trust + 可复现快照。

### 缺点

1. **单文件 2 万行 —— `FileViewer.tsx` 20,131 行，这不是「信息密度高」，这是失控。**
   - 证据：实测 `FileViewer.tsx` 20,131 行 / 874 KB；`ProjectView.tsx` 16,253 行 / 748 KB；`SettingsDialog.tsx` 9,036 行。
   - 什么场景出问题：① 任何人在这个文件里改一行，热更新/typecheck 都要吃完整 2 万行；② 无法 review —— 一个 PR 改 30 行，reviewer 看不到它在这个 2 万行文件里处于什么上下文；③ 冲突率极高（528 个组件文件但最大的几个吃掉绝大部分改动）；④ 代码分割天然失效（这些必然是巨型 chunk）。
   - 对照：同一项目的 `router.ts` 只有几百行且注释精炼 —— 团队有能力写小文件，只是没在这个文件上做。

2. **快照级缺陷：`packages/` 全缺，导致 1599 处 import 无法解析，项目实际不可构建、不可运行。**
   - 证据：`Test-Path packages → False`；`rg -o "@open-design/[a-z-]+"` 得 19 个不同的包；`apps/web/package.json:36` 有 `"@open-design/components": "workspace:*"` 但无 workspace 定义文件。
   - 什么场景出问题：任何人拿到这份快照都无法 `pnpm install`，所有 `@open-design/contracts` 的**契约定义**（包括 `TOKEN_SCHEMA`）都读不到 ⇒ **无法验证任何跨包契约的正确性**。本次拆解中设计系统 token 体系只能说实话到「机制可读、schema 不可读」。
   - 这不是项目的缺点，**是这份资料的限制** —— 但必须写明，否则会把「推测」当成「实读」。

3. **Windows 是二等公民，而它宣称跨平台桌面应用。**
   - 证据：`AGENTS.md`「macOS, Linux, and WSL2 are the primary supported paths. **Windows native is best-effort**」；同节列出 5 个历史 Windows issue（#10/#96/#100/#203/#315）；`better-sqlite3` 在 win32/Node24 **无预编译二进制**，必须现场 node-gyp（需 VS Build Tools 2022）；`corepack enable` 在 Windows 上 EPERM。
   - 什么场景出问题：目标用户里 Windows 占比最高的那部分（就是做设计稿的普通用户）第一次 `pnpm install` 就要装 VS Build Tools。

4. **架构复杂度与产品复杂度不匹配：一个「设计工作台」有 37 个 route 文件、113 个 collab 文件、24 个 strategy 文件、14 个 observability 文件。**
   - 证据：目录文件计数（`routes` 47、`collab` 113、`strategies` 24、`observability` 14、`plugins` 64、`brands` 36）。
   - 什么场景出问题：这是「企业级团队协作 + 计费 + 遥测 + 插件市场」的重量。一个只想「本机生成设计稿给 agent 改」的用户，被迫加载整套 SaaS 骨架（账户、计费、workspace、team、invite、quota、referral）。`CONTEXT.md` 里 `AMR Cloud` / `AMR CLI` / `Workspace Quota` / `Referral` 这些词条的存在本身就说明产品重心在商业化层。

5. **设计系统的抽取是纯正则，没有 AST —— 会在「非 CSS 中央化」的项目上系统性失败。**
   - 证据：`token-evidence.ts:36-45` 全部是 `RegExp`（`HEX_COLOR_RE` / `RGBA_COLOR_RE` / `CUSTOM_PROPERTY_RE` / `FONT_FAMILY_RE` / `SPACING_PX_RE` / `RADIUS_RE` / `SHADOW_RE` / `TAILWIND_HEX_RE`）。
   - 什么场景出问题：① 设计 token 在 JS 对象里（`theme.ts` 导出对象、styled-components 主题）⇒ 只有 `extractTailwindHexes` 能捞到一部分 hex，**名字与语义全丢**；② 颜色用 `oklch()`/`color(display-p3 …)`/CSS 变量二次派生（`--a: var(--b)`）⇒ 不在 4 条颜色正则里，抽不到；③ 主题有条件分支（`prefers-color-scheme`）⇒ 同一个名字两个值，`Map<name, entry>` 只能留一个（`token-evidence.ts:52-57` 的 5 个 Map 都按 name/value 去重）。
   - 讽刺的是：**它自己的产品 token 用的就是 `color-mix()` 和 `okhsl` 派生的**（`tokens.css:100-120`），按它自己的抽取器大概抽不全。

6. **1221 处 raw hex 说明 token 化只做到 ~91%，且 z-index 层已承认失控。**
   - 证据：`rg -o '#[0-9a-fA-F]{3,8}' src/styles → 1221`；`tokens.css:145-148` 注释「Roughly forty other z-index literals are still ad-hoc; naming them is a separate job. **Do not invent a third token here**」。
   - 什么场景出问题：换主题/换品牌时，这 1221 处不会跟着变 ⇒ 深色模式出现「亮色残留」。注释里已经记录过这个 bug（`tokens.css:106-112`：`--send-ground`/`--send-ink` 在合并 main 时被 revert 掉，剩 4 处引用在静默画错，因为「CSS 对未定义变量不报错」）。

---

## luanyujia-workbench

### 一句话定位

**一套「多场景 AI 工作台」的方法论 + 脱敏实现摘录：它本身不是可运行工程，而是一份把「一个人如何用多个常驻 AI 会话分工干活」的隐性经验写成可执行规矩的文档仓库，附带从真机上剪下来的 12 份参考源码。**

证据：`10-源码/README.md` 开头「这些代码**仅供学习参考**」+ 文末「为什么不是可运行项目」三条自述（依赖壳注入的 `app.*`、单机假设、无测试无 CI）；`README.md` 的「⚠️ 新手请谨慎：**这不是"装完就能用"的软件**」。

**它卖的不是代码，是判据。** 每一篇文档的核心都是「怎么判断该不该做 X」，且每条判据后面挂一个真实事故。

### 实测数据（自己数）

| 项 | 数量 | 备注 |
|---|---|---|
| 文件 / 体积 | **196 / 21.9 MB** | — |
| 扩展名 | `.md` 93 · `.js` 22 · `.mjs` 21 · `.png` 19 · `.json` 15 · `.svg` 8 · `.mp4` 2 · `.css` 2 | — |
| **体积构成** | `12-源码照搬` **17.74 MB / 96 文件**；`配图` 3.16 MB / 14；`10-源码` 0.43 MB / 13 | 逐目录 |
| **真正的代码体积** | 43 个 js/mjs / **40,643 行**；其中 `renderers.js` **1.12 MB**、`main.js` 263 KB、`styles.css` 294 KB | — |
| 文档正文 | 93 篇 md / **7,763 行** | UTF-8 实测 |
| **16 MB 是什么** | `12-源码照搬/外壳/renderer/assets/boot-video.mp4` = 13,364,807 B + `boot-video-720p.mp4` = 2,594,993 B | 启动动画视频占全仓 72% |
| 面板类型（真机 `renderers.js`） | **37 种** | 正则统计 `renderers.X=` / `renderers['X']=` |
| 面板类型（`10-源码` 3 个文件合计） | **14 种** | harness 文件 12 + file 1 + view 1 |
| 场景数 | 仓库里 **4 个**（command / bilibili / self-review / pc-cleanup）；文中提到真机 **10 个** | `12-源码照搬/外壳/scenarios/` |
| 工具脚本（铁律里点名） | **29 个 `.mjs`** | 从 `05/一-全局铁律.md` 正则抽 |
| CSS | `styles.css` **4,956 行**；raw hex **411** 处；`var(--)` **871** 处 | — |
| 测试 | **0**（自述无测试无 CI） | — |
| 许可 | MIT | `LICENSE` |

**体积这一项必须说清楚**：21.9 MB 里 **17.74 MB 是 `12-源码照搬`，而其中 16 MB 是两段启动动画 mp4**。真正的代码 + 文档合计约 **1.5 MB**。所以「22MB / 196 文件」这个描述会严重高估它的代码量。

### 底层架构

**技术栈**（从 `12-源码照搬/外壳/main.js` 与 `package.json` 实读）：

- Electron 主进程（无框窗口）+ 渲染层（纯 JS，无框架）+ `<webview>` 内嵌 DSH 引擎 UI
- **渲染层没有 React/Vue**：`renderers.js` 1.12 MB 是手写 DOM 操作（`el()` 工具函数 + `addEventListener`）
- 内嵌 DSH 引擎：通过 HTTP + token 认引擎，**不 import 引擎代码**（`main.js:4`「壳与 Harness 解耦——只通过 HTTP+token 认识它」）
- 数据盘隔离：`app.setPath('userData', PROFILE_DIR)` 强制指到项目目录，绝不落 C 盘（`main.js:68-76`）
- 端口：引擎 3083 / 界面静态 31238 / 网页版 AI 桥 31239
- Node 要求 `>=24.9`（比 pi 的 22.19 更严）

**目录结构与模块划分**：

```
12-源码照搬/                      ← 「能跑」的那份（96 文件 / 17.7 MB）
├── 外壳/                         ← Electron shell
│   ├── main.js  (263 KB)         ← 主进程：引擎拉起、静态服务、IPC、窗口
│   ├── preload.js (22.9 KB)      ← contextBridge 暴露 window.app.*
│   ├── renderer/
│   │   ├── renderers.js (1.12 MB)← 37 个面板渲染器
│   │   ├── renderer.js  (72 KB)  ← 建标签栏 / 场景切换
│   │   ├── topbar-status.js (98 KB)
│   │   ├── webai-bridge.js (128 KB)
│   │   ├── mcp-panel.js (29 KB)
│   │   └── styles.css (294 KB / 4,956 行)
│   ├── scenarios/                ← 4 个场景 json + 4 张定位卡 + 身份索引 + 协作约
│   └── scripts/                  ← 8 个 .mjs（sessions/建会话/换会话/归档/自检/refresh/check-gui/sidebar）
├── 工具/场景记忆.mjs (32.6 KB)
└── 启动.vbs

10-源码/                          ← 精选 12 份摘录（13 文件 / 0.43 MB）
├── 会话与切换/  sessions.mjs (51.7 KB) · 换会话.mjs (13 KB)
├── 免费AI桥/    webai.mjs (24.5 KB)
├── 启动链路/    1-引擎目录推导.js · 2-拉起引擎与等就绪.js
├── 面板实现/    面板-harness-AI会话.js (177 KB) · 面板-view-预览.js (107 KB) · 面板-file-文件管理.js (13.6 KB)
└── 机制小工具/  临时路径.mjs · 临时哨兵.mjs · 发布.mjs · 负载闸.mjs (23.1 KB)

11-最小可运行壳/index.html        ← 单文件 452 行 / 23.8 KB，零依赖 demo
00-核心机制/ ~ 08/ 13/ 模板/ 配图/  ← 方法论文档
```

**状态管理**：

四层，各归各的权威：

| 状态 | 权威在哪 | 证据 |
|---|---|---|
| **场景/面板布局** | `scenarios/*.json`（文件即真相，`col/row/w/h` 是数据不是代码） | `01-场景模式/布局与网格.md` |
| **面板 ↔ 会话 绑定** | 场景 json 的 `sessionTitle` / `sessionId` / `pinTarget` 三字段 | `02-会话定位与跟随/二-会话绑定三字段.md` |
| **标签顺序** | **主进程**（`data/scene-tab-order.json`），渲染层只上报不存 | `07-顶栏与菜单栏/README.md` 的「单一权威」段 |
| **AI 记忆** | **文件**（`引擎\场景记忆\<场景>\场景私有记忆.md`），不在会话里 | `00-核心机制/二-记忆机制.md:10-19` |

**「单一权威」这条被反复强调**（`07/README.md`）：「两份顺序同时存 = 迟早打架，重启后还会'复位'」。

**扩展机制**：只有一种，但极简有效 —— **渲染器表**：

```js
renderers['hello'] = function (body, meta, head) { ... };
// 返回值可以是 cleanup 函数，切场景时调用
```

- 查表渲染：`type` 没注册就显示灰字「未知面板类型」，**不报错**（`01-场景模式/面板类型与注册.md`）
- 三个参数：`body`（正文容器）/ `meta`（该面板 json）/ `head`（标题栏）
- **不需要动场景配置结构**就能加面板类型
- 热更新分两侧：`renderers.js` / `styles.css` / `scenarios/*.json` 改完跑 `刷新面板.mjs` 即可；`renderer.js` / `main.js` / `preload.js` **必须重启**（`05/一-全局铁律.md`）

这个「把改动按代价分两侧」的架构决定，作者自己说是「这套壳里最值得抄的一个架构决定」：**手感类的东西（拖拽、收起、动画）全放热更新侧，调手感不用重启。**

### 执行逻辑

**启动链路**（四个进程谁拉起谁）：

```
启动.vbs
  → Electron 主进程 main.js
      ├─ 推导引擎目录（优先"与本工作台同级"，推不出来才兜底；换盘符不用改代码）
      ├─ rotateLog()（>4MB 轮转，只留 1 份）
      ├─ 设置 PROFILE_DIR（userData/sessionData 都不落 C 盘）
      ├─ spawn 引擎（DSH_HOME 显式指向数据目录；直接跑已构建 CLI 跳过三层转译）
      ├─ 等引擎就绪（IPC 'harness:ready'）
      ├─ 起静态服务（官网 31238 / 网页版 AI 桥 31239）
      └─ 建 BrowserWindow → 渲染层
            └─ 读 scenarios/*.json → buildTabs() + buildGrid()
                  └─ 每个面板按 type 查 renderers 表 → 调用渲染器
                        └─ harness 面板：建 <webview> 嵌入引擎 UI + 注入 CSS/JS 钉会话
```

证据：`main.js:33-46`（引擎目录推导）、`:53-63`（日志轮转）、`:66-76`（数据盘隔离）、`12-源码照搬/外壳/scripts/建会话.mjs`、`04-工作台搭建/技术栈与启动链路.md` 的「四个进程谁拉起谁」图。

**会话绑定的实际机制**（这是全仓最核心也最脏的部分）：

数据链路：

```
场景 json 的 sessionId / sessionTitle / pinTarget
   ↓ 注入字符串常量到注入脚本
<webview> 内部 JS（HARNESS_PIN_JS）
   ↓ 读 document.title 去掉后缀得会话名
   ↓ 全文档找标题匹配的可点元素（排除聊天区、排除分组头）
   ↓ 合成 pointerdown/mousedown/pointerup/mouseup/click 五连发
   ↓ 失败则：写 localStorage['dsh.sessions.current'] + reload（预算 5 次，8s/25s 递增）
```

关键设计（`面板-harness-AI会话.js:137-330`）：

- **幂等守卫**：`GEN = 'pin_v3:' + BIND_KEY`，`window.__pinGen === GEN` 就直接 return，只跑一次轻量 tick。原因写在注释里：宿主每 5 秒重注入一次脚本，不守卫就攒出几十个 4 秒循环，「用户实感『每隔一会跳一下』」
- **绑定键带面板 id**：`'app_pin_bind_v2:' + PANEL + ':' + PIN_SIG`，`PIN_SIG` 含当前钉配置 ⇒ 改了场景配置旧记忆立刻失效，避免「场景 json 里已经删了 id，面板还按记住的标题去点旧会话」的鬼绑定
- **归一化必须保留空格**：`norm()` 只把连续空白压成一个（注释记了事故：两个孪生会话「DSH 改造」/「DSH改造」因全删空格而完全相等，面板把空会话当目标还报「✓ 已钉绑定」）
- **不限定搜索容器**：注释记了 2026-09-14 的坑 —— `[data-side="sidebar"]` 实际挂在拖拽手柄上、不是会话列表容器，限定范围后候选恒为空，一个会话都点不到
- **reload 预算记在 sessionStorage**（跨 reload 存活），因为 localStorage 会被应用改写
- **节流时间戳也放 sessionStorage**：原先放 `window.__pinReloadAt`，reload 后归零 ⇒ 8 秒间隔实际失效 ⇒ 一个场景挂两个 AI 面板时会互抢当前会话键

**「精简模式」的 DOM 整形**（`HARNESS_FIX_JS`，:596-695）：

目标是把引擎 UI 削成「只有聊天框」—— 隐藏左菜单栏、右详情列、对话区顶部标题栏、turn rail、宽度拖条。

实现是**三重法**：
1. **CSS 优先**（`HARNESS_CHAT_CSS`，:53-70）：`insertCSS` 注入一组 `[style*="grid-template-columns"][style*="minmax(0"]` 选择器 + `!important`
2. **结构法**（`fix()`）：找到唯一带内联 `grid-template-columns` 且含 `minmax(` 的元素（实测只有 1 个 = 应用框架），强制成单轨道，然后**按 DOM 位置**隐藏非中心列子元素
3. **常驻兜底**：`MutationObserver` + `setInterval(fix, 1000)` 纠正 React 重渲染

注释里有两段「别再改」的考古：

- 「⚠ 这条规则是实测有效的版本（display:flex + min-width:0）。上一版改成 position:fixed/visibility:hidden 后虚拟列表不再渲染列表项 → 反而『一个会话都切不进去』，已回退」
- 「这里以前还有一行 `r.style.setProperty('--dsh-chat-content-width','100%','important')`，2026-09-20 第三波删掉：本版 `[data-phase]` 是连接状态小圆点按钮，不是会话相位容器，写在上面的宽度变量压根到不了会话列（实测列仍被 clamp 到 887px）」

**记忆/上下文管理（文件式的，不是 token 式的）**：

这是整个仓库最有原创性的部分。三层结构（`00-核心机制/二-记忆机制.md:23-40`）：

| 层 | 放什么 | 体量红线 | 谁读 |
|---|---|---|---|
| ① 注入层（全局铁律） | 不读就会白干的铁律 | 越短越好（原文从 46.8 KB 瘦到 15.8 KB） | **每轮自动注入** |
| ② 私有层（场景记忆 `§〇 交接`） | 我是谁/干到哪/下一步/卡在哪 | **≤ 4 KB** | 本场景开场读 |
| ③ 共享层（四块板） | 通知看板（发生了什么）/ 待办板（该做什么）/ 总索引（东西在哪）/ 体检（机器健康吗） | 各有上限 | 谁需要谁读 |

判据一句话（:62-63）：「**这东西谁会读？多久读一次？**」

真实失败模式写得比设计还细（:216-225），六条：

| 症状 | 根因 | 修法 |
|---|---|---|
| 记忆越写越肥，最后没人读 | 把过程/搜索结果/报错原文都写进去 | 写回判据 + 体量红线 |
| 两份数字打架 | 同一事实存在两处 | 单一权威，另一处只放指针 |
| 切换场景后「失忆」 | `sessionId` 指向旧会话 | 换会话协议第 ③ 步（同步三处） |
| 别人的判断出现在我记忆里 | 跨场景直接写对方记忆 | 只许写请求 |
| 「体积正常」但内容没用 | 只盯体量不看「读完能不能开工」 | 判据改成「30 秒内能说出下一步」 |
| **压力数字骗人** | 拿「会话占用百分比」当压力（**不含工具定义，低估 2~3 倍**） | 只信专门体检工具当场那一条 |

最后一条是**可验证的技术判断**，而且 `sessions.mjs` 里有一段对应的更正记录（`10-源码/会话与切换/sessions.mjs:76-92`）：原来自算一套 160000×0.8=128k 报警线，后来发现 ① 160000 是人为调小的不是实测值（实测 79.2 万 token 的 prompt 真发出去过、从未被拒）⇒ 真实默认是 1000000（线 80 万）；② 口径是 surface 不含工具定义，低估 2–3 倍 ⇒ 「把 139k/140k 的健康会话（实际 17%）标成 ⚠」。结论：「判据两处各算一套，就是虚警的来源」⇒ 改成只读现成工具的 `pct/win/line/projected`，读不到就不标。

**调度机制**：

有两套「调度」，一套是机械的、一套是社会的：

**机械**：`负载闸.mjs`（23.1 KB）—— 派活前查水位

```
CPU  = 采样 3 次、间隔 1.5s、取均值（单次太抖）
内存 = (totalmem - freemem) / totalmem
两者都 <90%  ⇒ ✓ 可派单   exit 0
任一 ≥90%    ⇒ ⚠ 停止派单  exit 10（不许派子代理、不许 --wake）
任一 ≥95%    ⇒ ⛔ 停重活   exit 20（连体检/批量/构建都别跑）
闸门本身跑不成 ⇒ exit 3（⚠ 3 不是 0，调用方一律当"别派"）
```

这段代码里最值钱的是一段**性能实测考古**（`负载闸.mjs:22-31`）：原定用「3 次 `Get-CimInstance Win32_Processor` 取 LoadPercentage」，实测单次 WMI 调用 **1.05~1.33 s**，3 次 ≈ **7.8 s**，顶破了用户要的「全程 <4 s」。所以改成 ① Node `os.cpus()` 累计 tick 差分（精确落在 0/1.5/3.0 s 三个时刻，全程 3.0 s）；② WMI 只在**后台并行**跑一次当旁证，到点就杀。而且明确写了「⛔ 那是"工具跑不了"，**不是**"可以派单" —— 调用方别把 3 当 0」。

**社会**：`派单机制`（`00-核心机制/四-派单机制.md`）—— 这是「多 AI 之间的消息协议」，把「公告」和「派单」严格区分：

| | 派单 | 公告/知悉 |
|---|---|---|
| 对方要做什么 | **动手** | 只是知道 |
| 要不要唤醒 | ✅ 必须（花对方一轮） | ❌ 不唤醒（只落盘） |
| 预期回复 | **带证据**的回执 | 无（⛔ 收到知悉一个字都不许回） |

**真实事故**（:44-48）：一天发 36 条「通知」，其中**只有 8 条真的发进了对方会话**，其余躺在对方记忆文件里等机主点开面板才看得见。机主原话：「你这边派单他们没反应啊」。⇒ **8/36 的执行率**。

配套：状态机（`未回执` 是独立状态）、四件套（现象/照哪做/怎么验/回一句）、台账（`{hash, from, to, at, kind, delivered, ack}`）、销账、分诊、上限（同一件事 **≤3 条**、单条 ≤200 字、末行 `【结束】`）。

### 功能选取

**关键能力清单**：

| 能力 | 位置 |
|---|---|
| 网格面板工作台（37 种面板类型） | `12-源码照搬/外壳/renderer/renderers.js` |
| 场景 = 「一类活」的打包（六件套） | `00-核心机制/三-场景体系.md:51-88` |
| 会话三字段绑定 + 钉会话 | `02-会话定位与跟随/二-会话绑定三字段.md` + `面板-harness-AI会话.js:7-813` |
| 内嵌 AI 引擎（webview + 独立分区登录态） | `harness` 渲染器 |
| 免费网页版 AI 当工具调（不花 API token） | `10-源码/免费AI桥/webai.mjs`（380 行） |
| 三层文件记忆 + 体量红线 + 换会话协议 | `00-核心机制/二-记忆机制.md` |
| 派单/回执/台账/销账/分诊 | `00-核心机制/四-派单机制.md` |
| 修改权五档分层（A/C/B/D/E） | `00-核心机制/README.md` 表 1 + `05/一-全局铁律.md` |
| 负载闸（派活前看水位） | `10-源码/机制小工具/负载闸.mjs` |
| 临时文件落点判定 + 违规扫描 | `临时路径.mjs` / `临时哨兵.mjs` |
| 发布闸（**闸门缺失＝拒发**，成功判据是 hash 一致不是退出码） | `发布.mjs` |
| 体量体检 + 索引体检 + 全量标准化体检 | 铁律里点名，脚本部分未公开 |
| 交付前自证纪律（「必然合格」的自证 = 假证） | `05/一-全局铁律.md` |
| 一键 demo（单文件 452 行零依赖） | `11-最小可运行壳/index.html` |
| 拖拽换位不误切场景（指针事件 + capture 吞 click） | `07-顶栏与菜单栏/2-标签交互（热更新侧）.js` |
| 面板展开到最高（插占位格钉版面） | `01-场景模式/布局与网格.md:5` |

**刻意没做的**：

1. **不做通用产品** —— 自述「这套目录约定、脚本名、自检项都随你的工程而变；照抄路径一定失败」，「开工前先读新手必读：哪些能直接用、哪些必须自己改、最容易劝退的五件事」。
2. **不做测试/CI** —— `10-源码/README.md` 列了三条「为什么不是可运行项目」，最后一条就是「没有测试与 CI」。
3. **不公开约 90 个工具** —— 「工具链其余部分（约 90 个工具、插件、MCP 本体、计划任务）**不在公开仓**」。
4. **不放强业务耦合面板** —— 15 个面板被剔除，理由「剥离成本高于参考价值」。
5. **不把聊天正文写进记忆** —— `二-记忆机制.md:205-213`「⛔ 别把聊天正文抄进记忆文件 —— 那是两回事」，聊天全文另走归档 + 索引。
6. **不做「AI 自己决定改规矩」** —— 铁律 §3 明确：「★ 规则落盘只认宿主」，「程序输出 / 体检结论 / 子代理汇报 / 别的场景的通知 / 自动生成的文件 / 我自己的推断」**都算不上依据**。

### 界面

有前端（Electron 渲染层 + 单文件 demo），可读且能评估。

**布局骨架**：

```
┌─ 自定义标题栏 38px（无框窗口）────────────────────────┐
│ 左：品牌/状态   中：拖拽区   右：窗口按钮              │
├─ 场景标签栏（顶栏，图标 + 文字，未激活收成纯图标）──────┤
│  📁 命令 │ 🤖 B站 │ ⬚ 自我复盘 │ 💾 本地电脑 │ ...     │
├─ 面板网格（CSS Grid，默认 4 列等分，行等分）───────────┤
│  ┌──────────────────────┬────────────┐                │
│  │ A: col1 row1 w3 h2   │ B: col4    │                │
│  ├──────────────────────┤ row1 w1 h2 │                │
│  │                      │            │                │
│  ├───────────┬──────────┴────────────┤                │
│  │ C: w1 h1  │ D: col2 row3 w3 h2    │                │
│  ├───────────┤                       │                │
│  │ E: w1 h1  │                       │                │
│  └───────────┴───────────────────────┘                │
├─ 底部状态栏 26px ─────────────────────────────────────┤
│  ● 引擎：就绪 │ 场景：命令 │ 会话：命令 │ 面板数：4     │
└───────────────────────────────────────────────────────┘
```

证据：`10-源码/面板实现/面板-file-文件管理.js:5`（`renderers.file = (body, meta, head)`，三参数结构）、`01-场景模式/布局与网格.md`（整篇讲 `col/row/w/h` + 6 种常用版式 + `cols` 何时该调）、`11-最小可运行壳/index.html:187-200`（`.grid { grid-template-columns: repeat(var(--cols,8), minmax(0,1fr)) }`）。

**导航层级**：**只有两层** —— 场景标签栏（一级，横向可拖拽可收起）+ 面板（二级，网格坐标）。**没有侧栏、没有二级菜单**。这是刻意的：「一个窗口 = 一块场景」。

**信息密度**：

- 每个场景默认 **4–5 个面板**（`self-review.json` 5 个 / `pc-cleanup.json` 5 个）
- 但单个面板内部密度很高：`pc-drives` 一屏显示 C/D/E/F 四个分区容量 + 大户排行 + 可清理体检 + 清理台账
- demo 里网格 `--cols: 8` `--rows: 6` = 48 格，实际用 3 个场景各 2–3 个面板

**状态呈现**（粒度很细，这是它的强项）：

| 状态 | 呈现 | 证据 |
|---|---|---|
| 引擎就绪 | 底部状态栏 `● 引擎：模拟就绪` + 绿点 | demo `.status` |
| 引擎启动进度 | 启动动画视频 + 「引擎启动失败 100%」文案 | `12-源码照搬/README.md` 排障表 |
| 钉会话进行中 | 面板标题行右侧**状态小字**：「精简模式：注入中…」 | `面板-harness-AI会话.js:21` |
| 钉会话结果 | 小字变「✓ id 命中（身份校验通过）」；**可点击**清绑定重找 | `:22-40` |
| 诊断详情 | 鼠标悬停小字看完整说明（`window.__pinDiag`：targets/stored/reloads/claim/rows/cands 十几个字段） | `:380-410` |
| 加载失败 | 面板内红色文案「加载失败：<message>」 | `:805-806` |
| 文件大小/时间 | 每行右对齐灰字 | `面板-file-文件管理.js:12-25` |
| 未注册面板类型 | 一行灰字「未知面板类型: xxx」，**不报错** | `01/面板类型与注册.md` |
| 同步按钮防误点 | 默认显示 `🔒 同步`，点开才显 `↑推送/↓拉取` | `面板-file-文件管理.js:45-53` |

**颜色体系（有 token，但只做到基础层）**：

`styles.css:1-15` 的 `:root` 只有 **13 个变量**：

```css
--bg:#0b0d12  --bg-panel:#131722  --bg-panel-hover:#1a2030  --border:#232a3a
--text:#e6e8ee  --text-dim:#8b93a7  --accent:#4f8cff  --accent-soft:rgba(79,140,255,.14)
--ok:#34c98f  --warn:#e5b355  --err:#ef5d6d  --mono  --sans
```

实测：**411 处 raw hex vs 871 处 `var(--)`** ⇒ 比值 **1:2.1**。对比 open-design 的 1:10，token 化程度低一个量级。而且**没有深色/浅色双主题** —— 只有一个暗色（`README` 说「暗色主题」写在 `styles.css` 首行注释）。demo 壳则用了完全不同的青蓝配色（`--cyan:#22d3ee`），两套色不共享 token。

**字号 / 间距 / 圆角 / 动画**：

- 字号：`body` 13px 基准；实读 `styles.css` 里 11/12/12.5/13/13.5/14 等密集小字档次，**没有阶梯变量**
- 间距：写死 px，没有基数体系
- 圆角：面板 6px、按钮 3px 量级
- 动画：`transition: background .12s, color .12s, opacity .12s`（demo）；真机版本有 FLIP 让位动画（`07/2-标签交互`）
- `user-select: none` 全局 + 网格 `overflow: hidden` + 面板内部滚动 ⇒ **整页不滚**

诚实结论：**它的界面工程是「够用 + 手感打磨过」，不是「体系化」。** 值得抄的是几个具体交互决策（拖完不误切、未激活收成图标、上限 10+ 场景也不挤、面板展开插占位格），不是颜色/字号体系。

### 优势

1. **「判据 + 事故」的写法让规则可执行 —— 每条规矩都能被验证，因为它附了失败案例。**
   - 证据：`二-记忆机制.md:216-225` 的失效模式表（6 条，每条「症状 → 根因 → 修法」）；`四-派单机制.md:143-151`（6 条）；`三-场景体系.md:201-211`（6 条）；`04-工作台搭建/踩坑总表.md` 收了 **26 条**「看起来成功其实没生效」。
   - 为什么对：规则文档最常见的死法是「写了但没人遵守，因为看不出违反的后果」。「8/36 执行率」「记忆涨到 100KB 后没人读」「把 139k/140k 健康会话标成 ⚠」这类**带数字的事故**，让读者能自己判断「我这儿会不会也这样」。这比任何 lint 规则都更容易被记住。

2. **体量红线是硬数字，且配了「减肥必须可证明」的验收流程。**
   - 证据：`二-记忆机制.md:157-175`：场景记忆主文件 ≤25 KB / `§〇 交接` ≤4 KB / 技能单篇 ≤12 KB / 注入层越短越好。减肥流程四步：① 存"搬之前"快照 → ② 搬 → ③ **跑核对脚本逐行比对"搬前非历史行 == 搬后非历史行"，命中 0 差异才算没丢** → ④ 跑索引体检。
   - 为什么对：注释里记了真实教训（:174）「有一次没存快照就动手拆，结果核对脚本根本跑不了 —— 你无法证明自己没丢东西。从那以后规矩改成：**先快照，再动手**」。这是把「重构安全」落实到文件级记忆上的正确姿势 —— **没有差异证明的搬迁等于破坏**。

3. **把「判定逻辑」从「人记」搬到「工具拦」，且工具自己也守纪律。**
   - 证据：`负载闸.mjs` 的退出码三层（0/10/20/3）+ 明确「3 不是 0」；`发布.mjs` 的「闸门缺失＝拒发（不是跳过）」+「成功判据是 fetch 后 hash 一致，不是退出码」；`临时路径.mjs --check` 直接判违规并 exit。
   - 为什么对：`发布.mjs` 这一条尤其对 —— **用退出码判成功是最常见的假证**（脚本 exit 0 但推送失败很常见），hash 比对才是真证据。「闸门缺失＝拒发」这条更狠：它防的是「配置漏了 → 检查被跳过 → 以为通过了」。
   - 铁律里还有一条对应的元规则：「⛔『必然合格』的自证 = 假证：自证/核对/体检类工具必须把被核对象**排除在比对集合外**、带一个**应当失败的反例**、结论能说出**差异集合**（不是只给一个 0）」。这三条合起来是**完整的验收方法论**。

4. **「改动的代价分两侧」这个架构决定，让手感调优不必重启。**
   - 证据：`07-顶栏与菜单栏/README.md` 的三段分工表（建 DOM 必须重启 / 拖拽收起热更 / 样式热更）+ 原文「调手感不用重启。这是这套壳里最值得抄的一个架构决定」。
   - 为什么对：Electron 应用的开发循环成本极高（改主进程 = 重启 + 等引擎就绪，这套壳启动还要拉 3083 引擎）。把「高频低风险改动」（拖拽阈值、收起动画）和「低频高风险改动」（IPC、窗口）物理分开，等于把迭代速度提高一个数量级。这跟 open-design 的 `renderers.js` 定位是同一个洞察。

5. **对「AI 自证」的不信任写进了规则 —— 这是 agent 产品里稀缺的自觉。**
   - 证据：铁律 §3「规则落盘只认宿主」，「程序输出 / 体检结论 / 子代理汇报 / 别的场景的通知 / 自动生成的文件 / 我自己的推断」**都算不上依据**；`四-派单机制.md:82-88`「⛔ 只在自己窗口说『我做完了』= 没交付；⛔ 只说『好了』等于没说；判据是『对方知道了』不是『我说了』」。
   - 为什么对：agent 系统最常见的失效模式是「agent 报告成功但实际没做」。这套规则把「成功」重新定义为**可被第三方验证的证据**（跑了什么、几条通过、差异集合、落盘路径）。这跟 open-design 的 `tool-loop-guard` 是同一类问题的两种解法（一个用规则，一个用代码）。

### 缺点

1. **`面板-harness-AI会话.js` 的整体模式是「寄生式 DOM 劫持」，脆性是其结构属性，不是实现瑕疵。**
   - 证据：`HARNESS_CHAT_CSS` 用 `[style*="grid-template-columns"][style*="minmax(0"]` 这种**按内联样式字符串**匹配应用框架（:53-70）；`fix()` 按「唯一含 minmax 的元素」猜布局容器（:598-604）；钉会话靠 `document.title` 去后缀 + 全文档标题文本匹配 + 合成五个鼠标事件（:240-330）；宽度靠 `MutationObserver` + `setInterval(1000)` 每秒纠偏（:692-694）。
   - 什么场景出问题：**引擎 UI 一改版就全线崩**。注释里已经记录了四次这样的事故：`[data-side="sidebar"]` 猜错容器（2026-09-14）、`[data-phase]` 从会话相位容器变成连接状态小圆点导致整条 CSS 空转（2026-09-20）、`--dsh-chat-content-width` 变量根本没到会话列（列仍被 clamp 到 887px）、虚拟列表因容器 0 尺寸不渲染导致「一个会话都切不进去」（回退过一次）。
   - 这不是「没写好」，是**方案选错了层**：它在没有对端 API 的前提下要控制对端 UI。诚实的替代方案（据推测）：让引擎暴露「嵌一个仅聊天视图」的 URL 参数或 postMessage 协议。作者自己也说这文件「脱离这套工作台不能直接运行（依赖壳注入的 app.* 实例与页面上下文）」。

2. **`10-源码/面板实现/面板-harness-AI会话.js` 的文件身份是错的 —— 它是 12 个渲染器的拼接，不是「一个面板」。**
   - 证据：实测 3,164 行（UTF-8）中，`harness` 渲染器只占 **第 7–813 行（807 行）**；其后是 `site-folder`(851) / `site-preview`(994) / `site-about`(1067) / `site-media`(1101) / `site-projects`(1129) / `site-urls`(1186) / `bl-live`(1314) / `bl-folder`(1509) / `file`(1603) / `review-files`(2438) / `review-doc`(2598) —— 共 **12 个 `renderers.X =` 赋值**。
   - 什么场景出问题：① **文件命名与实际内容不符**，读者会以为「AI 会话面板 = 3164 行」而实际是 807 行；② 文件内混了 4 个互不相关场景（个人站 / Blender / 自我复盘 / 通用文件）的代码，**边界完全丢失**；③ `10-源码/README.md` 把它标为「2,717 行」，与实测 3,164 行不符（且 `file` 渲染器被重复——`面板-file-文件管理.js` 里也有一个 `renderers.file`，两处定义，读者无法判断哪个生效）。
   - 这不是致命缺陷（它是「摘录」不是工程），但**它让「这份源码能学到什么」这件事变模糊了**：真正可学的是那 807 行的注入/钉会话/幂等守卫模式，其余 2,350 行是各场景的业务面板，价值低得多。

3. **没有任何可执行验证 —— 全部「自检」都是本机脚本，别人 clone 下来跑不起来。**
   - 证据：`10-源码/README.md` 的「为什么不是可运行项目」表：内部 API 依赖（`app.*`）、单机假设（路径/端口 3080/exe 名/GCM 凭据）、**没有测试与 CI**。
   - 什么场景出问题：任何结论都无法被独立复现。比如「负载闸 3.2~4.0 s」这个数字，只能在作者那台机器上成立；「8/36 的执行率」是历史统计，无法验证。**整个仓库的价值依赖于读者信任作者的诚实度** —— 而作者确实很诚实（大量写明「这是占位符」「照抄一定失败」），但这不改变「不可验证」这个事实。
   - 对照：pi 有 29 万行测试、open-design 有 79.6 万行测试，两者的结论都能被跑一遍。

4. **文档自身的体量已经开始违反它自己的规矩。**
   - 证据：`05-协作与规矩/二-标准化规范.md` **105,264 字节 / 778 行**；`05/三-跨场景协作.md` **60,666 字节**。而记忆机制规定「注入层越短越好」、「技能单篇 ≤12 KB」、「`§〇` ≤4 KB」。
   - 什么场景出问题：这套体系的核心判据是「**这东西谁会读？多久读一次？**」，而 105 KB 的规范文件显然不是「每轮读」也不像「需要时查」——它是一个**没有分层成功的中间态**。铁律里也承认「⚠ 与细则层重复的地方（例如换会话的完整命令），**一律以二-标准化规范 为准**」⇒ 说明存在**同一事实两处**，恰好是它自己列的失效模式「两份数字打架」。
   - 这很有意思：**它自己诊断出了这个病（「同一事实只存一处」），但没在自己身上治好。**

5. **「22 MB / 196 文件」这个规模描述严重失真：72% 是两段启动动画视频。**
   - 证据：`12-源码照搬/外壳/renderer/assets/boot-video.mp4` 13.36 MB + `boot-video-720p.mp4` 2.59 MB = **15.96 MB**，占全仓 21.9 MB 的 72.9%。
   - 什么场景出问题：任何按体积评估「这个项目有多大」的判断都会错。真实的代码 + 文档约 **1.5 MB**（43 个 js/mjs 40,643 行 + 93 篇 md 7,763 行 + 少量配置）。
   - 而且这两段视频是**启动动画**（`boot-animation.json` 配套）—— 也就是说它为了一个纯装饰效果把仓库放大了 3.7 倍。

---

## 值得抄的

按「抄了就能用 / 抄了要改造」分两档，每条给具体模块。

### 直接抄（放进我们代码里就能跑）

1. **pi 的 `CompactionEntry` 设计：压缩是「追加一条 entry」，不是「改写历史」。**
   - 抄什么：`packages/coding-agent/src/core/compaction/compaction.ts` 的 `{summary, firstKeptEntryId, tokensBefore}` 三元组 + 「重复压缩从上次 kept 边界起」的规则。
   - 为什么：任何压缩实现都会遇到「压错了怎么办」。追加式压缩让回退免费（切回老 leaf 即可）。

2. **pi 的 `exposure` 工具分级 + `tool_search`。**
   - 抄什么：`src/core/extensions/types.ts:537` 的 `"direct" | "model-only" | "codemode" | "deferred" | "hidden"` + `src/extensions/tool-search/`（BM25）。
   - 为什么：这是「接 N 个 MCP server 而不撑爆 prompt」的唯一可扩展解。open-design 的 139 skills 也是同一个问题的另一种解法（按需扫目录），但 pi 的 `deferred + 搜索` 更省。

3. **open-design 的 `useEventStream` 三件套。**
   - 抄什么：`apps/web/src/hooks/useEventStream.ts` 整文件（约 12 KB）。① 隐藏 30s 关流 ② 重连重取快照（不用 Last-Event-ID）③ poll-as-floor ④ 同 URL ref-count 共享。
   - 为什么：这是带实时 UI 的产品最容易做错的地方，而它把「降级路径」当成主路径设计（注释原话「ZERO regression」）。

4. **open-design 的 `stable-sections.ts` 归因表 + 单 hash 不变量。**
   - 抄什么：`apps/daemon/src/prompts/stable-sections.ts` 的 `SECTION_INPUTS` 结构 + 那句话「the sha256 over the whole composed block is the only source of truth; section hashes are attribution metadata and must never gate a re-send decision」。
   - 为什么：如果我们做长会话 agent，prompt cache 是成本主项。归因能省掉「人去 diff trace」这个手工步骤；而「归因不得影响决策」这条不变量防止归因 bug 升级成漏发 bug。

5. **open-design 的 `tool-loop-guard` 双触发器。**
   - 抄什么：`apps/daemon/src/tool-loop-guard.ts` 全部（触发阈值可调）。特别是「**只读成功不清零**」这一条。
   - 为什么：死循环是 agent 最贵的失败模式，而且它**不报错**。挂在归一化事件流上 ⇒ 一套代码覆盖所有后端。

6. **luanyujia 的「判据 + 事故」文档模板。**
   - 抄什么：`00-核心机制/二-记忆机制.md` 的「失效模式」表格式（症状 / 根因 / 修法，每条附真实数字）+ 每篇末尾的「最小可用（先只做这几条）」段。
   - 为什么：这是让规则被真正遵守的最省成本的写法。我们的 skill / 规范文档全都可以套。

7. **luanyujia 的「闸门缺失＝拒发 + hash 判成功 + 反例自证」三件套。**
   - 抄什么：`10-源码/机制小工具/发布.mjs` 的判据结构；`负载闸.mjs` 的退出码语义（尤其「工具跑不了 ≠ 可以放行」）。
   - 为什么：我们的验收脚本极易滑向「exit 0 就算过」。hash 比对 + 反例 + 差异集合是唯一可靠的替代。

### 改造后抄（思路对，实现要重做）

8. **pi 的扩展契约（`ToolDefinition` 内含渲染器）—— 但必须加权限层。**
   - 改造点：pi 的做法是「同进程全信」。我们要保留「定义即 UI」这个好处，但把扩展放进**受限执行环境**（worker / 独立进程 + 能力授权），而不是靠「让用户 review 源码」。
   - 为什么：`deferred` + 同进程 + npm 分发 = 一个 `pi install` 就获得 RCE。这个组合在产品化时不可接受。

9. **open-design 的 token 契约评分 —— 但要把正则换成 AST。**
   - 改造点：保留 `layer(A1-identity/A1-structure/A2/B-slot) + confidence + reason + sources[]` 这套数据结构，以及 `A1 覆盖率 ×0.7` 的加权。把 `token-evidence.ts` 的 10 条正则换成 PostCSS / TS AST。
   - 为什么：纯正则在「token 在 JS 对象里」「颜色是 `oklch()`/`color-mix()` 派生」这两类项目上系统性失效 —— 而这两类恰好是主流设计系统的形态（含 open-design 自己）。

10. **luanyujia 的三层记忆结构 —— 但把「红线」变成可执行的自动拦截。**
    - 改造点：保留「注入层 / 私有层 ≤4KB / 共享层四块板」的分层与判据（谁会读、多久读一次），但把「≤4 KB」做成**写入时的硬闸**（超了拒绝写 + 提示搬归档），而不是靠人记得跑 `交接瘦身.mjs`。
    - 为什么：它的规矩全靠「人记得跑工具」，而它自己的 105 KB 规范文件就是这套机制失效的活证据。

11. **luanyujia 的「改动的代价分两侧」—— 推广成「热更面 / 重启面」的显式清单。**
    - 改造点：不止渲染层，把整个产品的可改项标成两档并自动化（改热更面 → 自动 reload；改重启面 → 提示并解释原因）。
    - 为什么：目前它是手工维护的清单（`05/一-全局铁律.md` 里那句「⛔ 能自动生效的不许让宿主动手」）。做成机制才不依赖记性。

---

## 我们要超过的

每条给「超过什么 + 怎么验证超过」。**验证必须是可跑的命令或可数的指标**，不接受「感觉更好」。

1. **超过 pi 的单文件失控：核心会话模块不能超 1500 行。**
   - 超过什么：pi 的 `agent-session.ts` = **4,581 行 / 145 个方法**；`interactive-mode.ts` = **7,303 行**。
   - 怎么验证：`git ls-files '*.ts' | xargs wc -l | sort -rn | head -5` —— 断言最大值 < 1500，且 CI 里加一条 `max-file-lines` 检查（超过就 fail）。

2. **超过 open-design 的组件巨型化：单前端组件文件不能超 1500 行。**
   - 超过什么：`FileViewer.tsx` **20,131 行**、`ProjectView.tsx` **16,253 行**、`SettingsDialog.tsx` **9,036 行**。
   - 怎么验证：`npx eslint --rule '{"max-lines":["error",1500]}' src/**/*.tsx` 全绿；并在 CI 里统计 `top-10 largest tsx` 的 P50/P90 行数并设阈值。

3. **超过 open-design 的 token 化残留：raw 颜色字面量必须为 0（在 token 文件之外）。**
   - 超过什么：`src/styles/` 下 **1221 处 raw hex**，`tokens.css:145` 自承认「~40 个 z-index 字面量 ad-hoc」。
   - 怎么验证：CI 跑 `rg -o '#[0-9a-fA-F]{3,8}\b' src/ --glob '!**/tokens.css' --glob '!**/fonts/**' | wc -l` ⇒ 断言 `0`。以及 `rg -c 'z-index: *[0-9]+' src/` 断言只出现在 `--z-*` 定义处。

4. **超过 luanyujia 的「不可验证」：每条机制都要有可跑的测试。**
   - 超过什么：luanyujia **0 测试 / 0 CI**，全部「自检」是本机脚本。
   - 怎么验证：① `npm test` 存在且能跑；② 对每个机制（记忆分层、派单状态机、负载闸阈值、换会话三步同步）各至少 1 个单测 + 1 个反例测试；③ 在 CI 里断言覆盖率下限，并**断言至少存在一个必然失败的反例**（防止「必然合格的自证」）。
   - 硬指标：测试行数 / 源码行数 ≥ 0.5（pi 是 0.487，open-design 是 1.03 ⇒ 直接对标 open-design）。

5. **超过三个项目共同的最大盲区：UI 集成的**协议化**程度。**
   - 超过什么：luanyujia 靠合成鼠标事件 + `document.title` 猜会话（`面板-harness-AI会话.js:240-330`）；open-design 靠 27 个 shell 适配器各写一套 CLI 包装（`daemon/src/runtimes/defs/`）。两者都没有一个「宿主 ↔ 嵌入视图」的双向契约。
   - 怎么验证：① 我们对外暴露**嵌入协议**（一条 `postMessage` 或 URL 参数即可声明「我要哪个会话 / 只要聊天区 / 我要读写哪些状态」），并用**契约测试**固定住（producer + consumer 各一份 fixture，双向验证）；② 断言：改嵌入视图中任意 DOM/CSS 后，集成方的测试**仍然全绿**（因为不依赖 DOM 结构）—— 具体做法：在 CI 里跑一个「故意改掉宿主 UI 的 class 名与 DOM 层级」的 conformance 用例，断言 embed 集成不失败。luanyujia 的 4 次事故（`[data-side]` / `[data-phase]` / 变量名 / 虚拟列表）在这个用例下**全部会 fail**，这就是要超过的量。

6. **超过 luanyujia 的「文档自身违反自己的红线」：规则文件必须可被自己的检查器检查。**
   - 超过什么：luanyujia 规定「技能单篇 ≤12 KB」「`§〇` ≤4 KB」，但它自己的 `05/二-标准化规范.md` 是 **105,264 字节**。
   - 怎么验证：写一个 `check-docs.mjs`，对所有 `docs/**/*.md` 断言：① 单文件 ≤ 设定上限（我们定 32 KB，比它的 12 KB 宽松但比它的实际 105 KB 严格）；② 同一事实不在两处出现（用「同一组数字/命令字符串出现在多个文件」的启发式检测）；③ 每条规则必须有一个可跑的 checker 或明确写「无 checker」。CI 里跑它，**包含我们自己** —— 规则文件超标就 fail。

7. **超过 pi 的「三套并存的工具抽象」：一个工具面，跨平台不靠多写工具。**
   - 超过什么：pi 的 `bash` 与 `powershell` 是两个并列工具（`tools/index.ts:95`），能力不对等（17 KB vs 3.4 KB），prompt 里要写「Use bash or PowerShell」二选一。
   - 怎么验证：① 我们的工具集里只有一个 `shell` 语义工具，平台差异在**实现层**（`ShellOperations` 接口，pi 自己已经有了 `BashOperations` / `PowerShellOperations` 这个模式，只是没统一到工具层）；② 断言：跨平台测试矩阵里，同一个 tool schema 在 Windows/Linux/macOS 上跑同一组用例，**通过率一致**；③ 断言 tool 声明数量与平台数无关（即 `OS=windows` 与 `OS=linux` 的 tool 列表完全相同）。

---

## 附：本次拆解的取证边界（诚实交代）

| 项目 | 我读了 | 我**没**读 |
|---|---|---|
| pi | 根 `package.json`、`README.md`、`AGENTS.md`、12 个包的 `package.json`、`docs/how-pi-works.md`、`docs/extensions.md`（前 120 行）、`docs/compaction.md`（前 80 行）、`docs/session-format.md`、`docs/skills.md`、`docs/packages.md`、`docs/codemode.md`、`tools/index.ts`、`tool-definition-wrapper.ts`、`read.ts`（前 90 行）、`system-prompt.ts`（前 120 行）、`agent-loop.ts`（440–580）、`agent-session.ts`（类字段全段）、`dark.json`、`theme-schema.ts`、`footer.ts`、`executionMode` 相关 | `chord` 158k 行 / `durable` 99k 行 / `ai` 84k 行的实际逻辑；`interactive-mode.ts` 7303 行；`resource-loader.ts`(1320) / `package-manager.ts`(2968)；`apps/p2` 的 Web GUI；`evals/` |
| open-design | `README.md`、`AGENTS.md`、`CONTEXT.md`（前 100 行）、`CHANGELOG.md`（前 30 行）、5 个 app 的 `package.json`、`tokens.css`（全文 313 行）、`base.css`、`primitives.css`（前 90 行）、`material.css`（前 30）、`app-wash.css`、`shell.css`（前 80）、`entry-layout.css`（前 40）、`router.ts`、`useEventStream.ts`、`token-contract.ts`（前 110）、`token-evidence.ts`（前 80）、`token-contract-rebuild.ts`（前 60）、`showcase.ts`（前 40）、`memory.ts`（前 60）、`memory-llm.ts`（前 30）、`tool-loop-guard.ts`（前 30）、`run-retry-policy.ts`（前 25）、`stable-sections.ts`（前 50）、`prompts/system.ts`（前 60）、`skills.ts`（前 40）、`runtimes/registry.ts`、`agent-protocol/README.md`、`.claude-plugin/marketplace.json` | **`packages/` 全部缺失（含 `@open-design/contracts` 与 `TOKEN_SCHEMA` 定义）**；`FileViewer.tsx` 2 万行；`critique/orchestrator.ts` 37KB；`runtimes/defs/*` 27 个适配器实现；`plugins/` 64 个文件；`collab/` 113 个文件；i18n 19 个 locale |
| luanyujia | `README.md`、`00-核心机制/{README,二-记忆机制(全文253行),三-场景体系(全文231行),四-派单机制(全文166行)}`、`01/布局与网格.md`(全文)、`01/面板类型与注册.md`(全文)、`02/二-会话绑定三字段.md`(前 70 行)、`04/工作台搭建/README.md`、`05/一-全局铁律.md`(前 75 行)、`07/README.md`(前 60 行)、`10-源码/README.md`(全文)、`10-源码/面板实现/面板-harness-AI会话.js`(第 1–830 行、596–700、1298–1320、2199–2222)、`面板-file-文件管理.js`(前 70 行)、`sessions.mjs`(前 80 行)、`webai.mjs`(前 60 行)、`负载闸.mjs`(前 55 行)、`11-最小可运行壳/{README.md, index.html 前 110 行}`、`12-源码照搬/README.md`(前 60 行)、`12-源码照搬/外壳/main.js`(前 70 行)、`preload.js`(前 80 行)、`scenarios/*`(全部 4 个 json + 4 张卡 + 索引) | `05/二-标准化规范.md` **105 KB 未读**；`05/三-跨场景协作.md` **60 KB 未读**；`renderers.js` 1.12 MB 未读（只做了正则统计）；`main.js` 263 KB 只读前 70 行；`styles.css` 4,956 行只做统计；`12-源码照搬` 的 `renderer.js` / `topbar-status.js` / `webai-bridge.js` / `mcp-panel.js`；`06/` `08/` `13/` `模板/` |

**所有数字都是本次实测**（`Get-ChildItem -Recurse` + UTF-8 `ReadAllText` 切行 + `rg -o | Measure-Object`），没有从 README 抄。

**一处需要特别说明的不一致**：`10-源码/README.md` 声称 `面板-harness-AI会话.js` 是「2,717 行」，实测 UTF-8 为 **3,164 行**。

我试过用编码差异解释这个差距，但**解释不成立**：按 GBK(936) 解码该文件得到 2,816 行，也不是 2,717。所以我没有可信解释，只能说 README 的这个数字与文件实际内容不符（可能是更早版本的计数，也可能是笔误）。**我按 UTF-8 实测 3,164 行为准**，并已核实文件无截断（末尾三行为完整的 IIFE 收尾 `console.log('[park] 场景 webview 停车机制已装…')`）。
