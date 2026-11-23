# omp-studio 拆解（可抄实现口径）

> 口径：每个结论带 `文件:行号`；没找到写「未找到」；不复述 README。
> 判断基准：它是 **oh-my-pi（OMP）Agent Runtime 的桌面控制台**，不是 agent 框架本身。
> 关键事实：真正的 agent 运行时（循环/工具/子agent/MCP 连接）在 `omp-patch/vendor/oh-my-pi` 子模块里，**本 checkout 该目录为空**（见 §0），
> 所以「运行时内部怎么实现」多数只能从**接缝补丁**与**类型契约**反推。这恰好符合我们的处境——我们缺的也正是「宿主如何把 Runtime 能力接出来给 UI/插件」。

---

## 0. 定位与规模

- 一句话：Electron 桌面工作台 + 类型化 **Studio Bridge**，把 OMP Runtime 的对话/审批/子agent/Git/终端/浏览器/模型配置放进一扇可拖拽分屏的窗口。
  - `package.json:4-5`（description：Desktop console for OMP Runtime — typed Studio Bridge, Electron workbench）
  - `AGENTS.md:5`（「不要以 slash 文本、ANSI 输出解析或按键宏模拟控制」——这是我们最该学的：**别解析 TUI**）
- 规模 / 语言：TypeScript；workspaces = `packages/*` + `apps/*`（`package.json:25-28`）；node>=22（`package.json:70-71`）。
  - 渲染层 `apps/renderer/src` 就有 **1079 个文件**（我实测），React 测试文件 275 个、packages 测试 70 个。
- 目录真相（实测，非 README）：
  - `apps/desktop` = Electron 主进程 + 平台层（`apps/desktop/src/platform/`，AGENTS.md:9）
  - `apps/renderer` = Vite + React UI（AGENTS.md:10）
  - `packages/` = 12 个包：`studio-protocol / client-contract / client / studio-host / transport-desktop / transport-web / platform-* / runtime-installer / host-client-api / testkit`（`package.json:66`）
  - `.oil-ui/` = **只有 `.gitignore`，空占位**（实测 `Get-ChildItem .oil-ui -Recurse` 仅 1 文件）→ 不是插件目录，别被名字误导。
  - `catalog/` = **模型目录**：`catalog/model-catalog-v1.json:1-20`（schemaVersion/upstreamCommit/entries）+ `scripts/model-catalog.mjs` 生成；`catalog/model-aliases.json` = `{}`。**不是插件市场**。
  - `omp-patch/` = 上游补丁机制（overlay 自有源码 + 4 组接缝 patch + vendor 子模块，AGENTS.md:172-187）。

## 1. 架构骨架

- 分层与依赖方向（有强制）：`apps/desktop`（唯一可 import electron）→ `apps/renderer`（唯一可 import react）→ `packages/*`；包间值依赖无环、只能走白名单方向。
  - 证据：`scripts/architecture.test.mjs:20`（`ALLOWED_INTERNAL_DEPS`）、`:125-137`（只有 desktop 能碰 electron）、`:149-154`（renderer 不能 import node/electron，必须走 preload）。
  - 规则本身写在 `AGENTS.md:134-148`，CI/check 第一步就拦。
- 核心/插件边界靠什么强制：**类型契约 + 架构测试**，不是目录约定。所有跨层通信只认 `packages/studio-protocol/src/contracts/*`（60+ 个 `*.ts`）与 `packages/client-contract`（命令 query/command 面）。
- Studio Bridge 的形态：host 侧统一 `*-protocol.ts` 一处校验，facade/桌面/renderer 不重复校验、不写结果校验器（`AGENTS.md:52-62`）。这是「单一真源」的纪律。（B2 证据）

## 2.【A12】插件 / 扩展机制（重中之重）

三层，各自独立，别混：

**(a) Runtime 扩展（等价于「真插件」）——源码在子模块，仅能从补丁看到形状**
- `omp-patch/patches/0004-studio-extensibility.patch:1174-1208` 改的是 `packages/coding-agent/src/extensibility/extensions/types.ts`：扩展持有 **`ExtensionUIContext`**，可挂 `approveTool()` 审批面、`askDialog()` 富提问、`select()`。说明扩展**能向宿主贡献 UI/审批能力**，不是纯工具。
- 同 patch `:1209-1326` 的 `wrapper.ts` 把 `RegisteredTool` 适配成 AgentTool；`:1160-1173` 的 `ExtensionRunner` 有 `#drawingExtensions()`、`ext.linkSchemes`（扩展可注册**链接协议处理器**）。→ 贡献点至少包括：工具、命令、快捷键、linkScheme、助手文本渲染器、审批面。
- **发现/装载/校验/隔离/热插拔：未找到**（loader 在 `omp-patch/vendor/oh-my-pi`，本 checkout 空目录）。只能确认运行时存在 `ExtensionRunner` 与 `extensibility/extensions/{runner,types,wrapper}.ts`（patch 文件列表）。

**(b) 签名的「组件」插件（可当二进制插件参考）**
- `apps/desktop/src/office-component-manifest.ts:3-18`：`OfficeComponentManifest{schema,component,version,platform,engineVersion,entrypoint,archive{url,sha256,bytes},sourceUrl,license}` + **签名校验** `verifyOfficeComponent()`（平台校验、version 安全、sha256/字节数、entrypoint 白名单）。这是「外挂组件怎么验签+校验再启动」的可抄样板（LibreOffice 预览组件）。

**(c) 命令级贡献清单（★ 最贴近我们的 kernel.mjs）**
- `packages/studio-protocol/src/contracts/manifests.ts:21-51`：`OperatorCommandManifestEntry` 每条命令带
  `source: "builtin"|"extension"|"skill"|"prompt-template"|"file-command"`、`implementation`、`risk`、`effect`、`availability`、`contractTestId`。
- `:53-59` `OperatorCommandManifest{generatedAt, upstreamCommit, hash, commands, unclassifiedBuiltins}` —— **生成式清单 + 来源标注 + 未分类兜底**。
- `:61-96` `FULL_PARITY_REQUIRED_CAPABILITIES` 列了必须对等的核心能力（含 agent.spawn/kill/revive/job.list…），是把「插件能加什么」和「核心承诺什么」分开的硬清单。
- 扩展链接单列一个契约：`contracts/extension-links.ts:1-3`（`extensions.links.activate` → `{handled}`）。

**结论**：它没有「目录扫描式插件市场」；它的扩展点由 Runtime 提供、由**生成清单**统一暴露、由**架构测试**守边界。这与我们 `tools/plugin/kernel.mjs` 的定位高度对应（见 §9-机制3）。

## 3.【A13】MCP / 工具接入

- 契约面完整（客户端侧）：`packages/client-contract/src/operations.ts`
  - `mcp.get`（磁盘扫描，不是连接态）`:137-139,227-230`
  - `mcp.setEnabled` / `mcp.setInstructions` / `mcp.refresh` / `mcp.test` / `mcp.logs.get` `:699-740`
- 运行态模型：`packages/studio-protocol/src/contracts/runtime-catalog.ts:2-19` `McpRuntimeStatus{available,startupTimeoutMs,servers[{name,state:ready|pending|failed|disconnected,tools,transport:stdio|http|sse,source{level:user|project|native},error,toolInfo[{name,readOnlyHint}]}]}`。
- 管理 UI：**不是 settings**，在 `apps/renderer/src/capabilities/CapabilitiesPage.tsx:224-300,418,526`（读 `mcp.get`、跑 `mcp.test`、`mcp.setEnabled`）+ `capabilities/McpRuntimePane.tsx` + `McpAuthActions.tsx`。
- **MCP client 本身/怎么起 server：未找到**（在 Runtime 子模块）；本仓只确认「配置在 OMP 原生 mcp.json，Host 只做磁盘扫描与探活」。

## 4.【A11】调度 / 后台任务

- 后台任务 = Agent 的 job/service 快照树，不是 cron：`apps/renderer/src/backgroundTasks/backgroundTasksModel.ts:40-55`（`buildBackgroundTasks(jobs, services, links)` → `buildJobTree`）。
- 取消走契约 `job.cancel{jobId, expectedGeneration}`（`operations.ts:546-547`），带 generation 栅栏防旧请求误杀。
- 面板：`backgroundTasks/BackgroundTasksDock.tsx`、`BackgroundTasksPanel.tsx`、`useBackgroundTasks.ts`；面板在 `panels/registry.ts:10`（id `jobs`）。
- **定时任务定义/存储/tick：未找到**（定时调度若存在也在 Runtime）。

## 5.【C1/C2】agent 循环与停止条件

- **主循环：判不了**——不在本 checkout（`omp-patch/vendor/oh-my-pi` 空）。AGENTS.md:5 明确「Runtime 执行」，本仓仅镜像契约（`Action`/`Observation` 不在此仓，只有 renderer 的 `CommandBlock`/`ActivityLine` 呈现）。
- 可见的刹车旋钮（契约层）：
  - `loop.pause` / `loop.disable`（`client-contract/src/operations.ts:470-471`）
  - 子任务预算：`gui-workbench-settings.ts:25-28` `task.maxConcurrency`(32)、`task.maxRecursionDepth`(2)、`task.maxRuntimeMs`(0=不限)、`task.softRequestBudget`(200，到软预算提示收尾)。
  - 会话树/分叉：`session.fork`/`session.tree.navigate`/`session.handoff`（`operations.ts:495-504`）。
- **停止条件判定本身：判不了**（执行侧在 Runtime）；本仓只证明「停止/预算是**可配置旋钮 + 契约命令**，不是硬编码」。

## 6.【A6/A7】记忆

- **无 agent 记忆子系统**。grep `memory` 命中全是 UI 层：`git/gitDiffMemory.ts`、`git/gitGraphMemory.ts`、`settings/MemoryCredentialPane.tsx`、`sidebar/expandMemory.ts`、`shellMemory.ts` —— 与「跨会话语义记忆/溯源/TTL」无关。
- **A7 溯源/冲突消解/TTL：未找到**（整仓 grep ttl|supersede|decay|conflict 无记忆相关命中）。

## 7. 界面（D1–D5）

- 技术栈：React + Vite（`apps/renderer`）；Electron 壳（`apps/desktop`）。**无 Vue/Svelte**。
- 布局范式 = **可停靠工作台（dock/float/native window）**：
  - `apps/renderer/src/dock/types.ts:62-79` `DockLayout{left,rail,right,bottom,floats,hidden,cards,agentPanels,browserPages,fileViews,presetId}` —— 一份**可序列化布局**。
  - `workbench/WorkbenchCanvas.tsx`（3000 行，装配所有面板）+ `dock/DockRegions.tsx`（left/rail/bottom/float）+ `dock/NativeFloat.tsx`（钉成系统窗口）。
- 状态可见性：`dock/panelMeters.tsx` + `agent/AgentRosterMeter` + `conversation/ChangesDockMeter` + `usage/TokenCounterPane`（能看到「谁在跑/改了几个文件/花了多少 token」）。
- 多主题/i18n：`apps/renderer/src/i18n/`、`styles/`（`styles/tokens.css` 的 Motion 段 + `styles/motion.css`，见 AGENTS.md:150-158）。
- 面板清单是**静态注册表**：`panels/registry.ts:3-25`（21 个固定面板 id，含 files/git/browser/computer/jobs/agents/agent-detail/context/terminal/tests/output/logs…）。

## 8. ⭐ 最值得抄的 3 条机制

### 机制 1：面板「稳定宿主层」——DOM/React 节点不动，只移容器
- 位置：`apps/renderer/src/dock/hosts.ts:40-392`（`PanelHosts` 类）
  - `get(id)` 每个面板一个持久 `div.dock-panel-content`（`:60-75`），`inert+hidden` 保活；
  - 关键手法：`placeHost()` 用 **`moveBefore()`** 把同一节点在 rail↔host layer 间移动，注释明说「preserves focus, iframe state and running media」（`:143-149`）；跨文档窗口 `attachWindow()`（`:162-179`）；
  - `measure()` 先读全部 rect、再写一次（`:298-391`），避免布局抖动；`rememberScroll/restore` 保滚动位（`:123-129,376-384`）。
- 为什么好：解决的是「分屏/浮动/独立窗口切换时 iframe 重载、焦点丢失、终端/编辑器状态清零」——这正是任何 WorkbenchScene 重挂载的经典坑。我们 `WorkbenchScene.tsx` 若用 React 条件渲染切面板，必然踩。
- 我们抄到哪：`apps/vouch-web/.../WorkbenchScene.tsx` +（若有）面板宿主层；把「切换布局」从「卸载/挂载 React 树」改成「移动同一个 portal 宿主 div」。

### 机制 2：单一可序列化 DockLayout + 迁移/预设
- 位置：`apps/renderer/src/dock/types.ts:62-79`（模型）+ `dock/model.ts`（纯函数 `locatePanel/removePanels/projectConversationPanel`，见 `dock/conversationPanels.ts:1-25` 用法）+ `dock/store.ts`（`DockStore` 订阅，`DockContext.tsx:44-45` `useSyncExternalStore`）。
- 为什么好：布局是**一个可 JSON 化的对象**（能存、能恢复、能存 preset、能做 agentPanels/browserPages/fileViews 实例表），而不是散落的组件 state。`DockAction` 联合（`types.ts:90-115`）把「开/关/移动/浮起/隐藏/缩放」都变成可归约动作。
- 我们抄到哪：`apps/vouch-web/.../WorkbenchScene.tsx` 的布局状态——抽出 `LayoutDoc` + reducer + `locatePanel` 选择器，别让每个 panel 自管位置。

### 机制 3：生成式「能力/命令清单」带 provenance（对应我们的 kernel/plugin）
- 位置：`packages/studio-protocol/src/contracts/manifests.ts:21-96`（`OperatorCommandManifestEntry.source/implementation/risk/effect/availability/contractTestId` + `FULL_PARITY_REQUIRED_CAPABILITIES`）；对照 `apps/desktop/src/office-component-manifest.ts:3-18`（签名组件清单）。
- 为什么好：插件/技能/内置命令**统一进一张清单**，每条标明来源与实现方式，还有「必须对等的核心能力」清单 + `unclassifiedBuiltins` 兜底。这给插件生态一个**可校验的目录**，而不是靠约定。我们的 `tools/plugin/kernel.mjs` 正缺这种「注册即登记、可断言、能报告未分类」的清单层。
- 我们抄到哪：`tools/plugin/kernel.mjs`——给每个 plugin 注册项加 `{source, implementation, risk, effect, availability, contractTestId}`，生成 `plugin-manifest.json`，并保留 `unclassified` 槽；UI 侧（catalog 面板）读这份清单渲染。

## 9. 我们不该抄的

- **Electron 专属窗口/平台层**：`dock/NativeFloat.tsx`、`apps/desktop/src/remote/*`（远程主机 provisioning/ssh 隧道）、`platform-win32|darwin`、`office-component`（LibreOffice 签名分发）、`pack-unix/pack-win`——重、绑桌面形态，我们 Web GUI 用不上。
- **1079 文件的渲染层**：它为「30 种面板 + 预览双数据」付了巨大复杂度；我们不要照搬「每个新页面必须同时接预览 fixture + 真数据」这套纪律（AGENTS.md:64-98），除非确有预览需求。
- **`catalog/` 的模型目录**：那是模型元数据（contextWindow/thinkingConfig），与插件目录同名不同义，别误当插件市场抄。
- **过度防御的 generation 栅栏/多重签名**：`job.cancel expectedGeneration`、office 签名链——我们当前规模未必要，先抄「可校验清单」即可，别把签名基建一起拉进来。

---

## 附：给 lead 的一句话结论
omp-studio 本身不是多 agent 框架，是 OMP 的**工作台壳**；真正可抄的是「桌面级面板宿主层（hosts.ts）」+「可序列化 DockLayout（dock/types.ts+model.ts）」+「生成式能力清单（manifests.ts）」三件，正好对应我们的 `WorkbenchScene.tsx` 与 `tools/plugin/kernel.mjs`。agent 循环/记忆/MCP 连接都在空子模块里，**判不了**，不要假设。
