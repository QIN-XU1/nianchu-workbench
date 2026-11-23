# open-design 拆解（可抄实现口径）

> 仓库：`D:\refs\open-design\open-design-main`（4,826 文件，TypeScript / TSX）
> 采样时间：2026-11-17。所有结论带 `文件:行号`；未找到的写「未找到」。

---

## 1. 定位与规模

一句话：**OpenDesign = 「AI 设计 agent 工作台」**，不是设计组件库——左侧是 agent 对话（Claude Code / Codex / OpenCode 等外部 CLI agent），右侧是可多 tab 的 workspace（画布 / 文件 / 浏览器 / 终端 / 预览），外面套一层「插件 + 技能 + 设计系统 + MCP」生态。它是**宿主（host）**，agent 循环本身不在本仓内。

- 文件数 4,826；TS 3104 / TSX 1162 / CSS 166。主语言 TypeScript。
- 版本：`apps/daemon/package.json` → `@open-design/daemon 0.27.2`；`apps/desktop/package.json` → `0.27.2`。
- **无根 `package.json`、无 `.git`**（`Test-Path` 均为 False），故 star / 最近 push 日期**未找到**。
- 各 app 文件量：`apps/web` 2528、`apps/daemon` 1929、`apps/desktop` 106、`apps/packaged` 56、`apps/closure` 8。
- **重要限制**：`apps/*/package.json` 依赖 `@open-design/{components,contracts,plugin-runtime,platform,sidecar…}` 这些 workspace 包，但**快照里没有 `packages/` 目录**（`Test-Path packages` 不存在），`plugins/_official/` 亦缺。所以「manifest 的 Zod 校验 / GenUI 契约 / 组件库」本体看不到，只能从 daemon 侧调用点推断。

## 2. 架构骨架

顶层（`apps/AGENTS.md:7-16` + 目录实测）：

- `apps/web` — Next.js 16 App Router + React 18 前端；入口 `apps/web/app/[[...slug]]/page.tsx`，主壳 `apps/web/src/App.tsx`；`/api/* /artifacts/* /frames/*` 由 `next.config.ts` rewrite 到 daemon。
- `apps/daemon` — Express + SQLite 本地 daemon + `od` bin；拥有 REST/SSE、agent CLI 拉起、技能、设计系统、artifact 持久化、静态服务。
- `apps/desktop` — Electron 外壳，通过 sidecar IPC 拿 web 端口，不猜端口。
- `apps/packaged` — 打包运行入口，起 daemon/web sidecar，注册 `od://`。
- `apps/closure` — 独立分发内容，冷启动期只放生命周期 fixture。

daemon 内域划分（`apps/daemon/src/` 实测）：`runtimes/`（agent CLI 适配与 run 生命周期，最大）、`routes/`（REST 按域分文件）、`plugins/`（插件系统）、`mcp*.ts`（MCP 双端）、`memory*.ts`（记忆）、`routines.ts`、`critique/`（多面板评审）、`connectors/`（Composio）、`design-systems/`、`genui/`、`skills.ts`。

依赖方向（可验证的）：
- **纯 FS 读 → 唯一写 → 纯函数**三层是硬拆的：`plugins/registry.ts` 顶注释「Pure FS read, no SQLite write — the installer module is the only writer」（`registry.ts:97`）；`plugins/apply.ts:1-15` 声明 apply 是纯函数（无 DB/FS/network），副作用归调用方。这是**插件内核可测的关键**。
- 业务层禁止 import sidecar 包：`apps/AGENTS.md:44-46`「App business layers must not import sidecar packages or branch on runtime.mode」。
- `apps/daemon/src/server.ts` 只做 bootstrap 路由，域路由必须进 `routes/`（`apps/AGENTS.md:22-30`）。

核心/插件边界强制手段：**目录约定 + 类型契约**（`@open-design/contracts` 的 `PluginManifest`/`InstalledPluginRecord` 等），**未见 CI 脚本级强制**（root 无 package.json，`packages/` 缺失）。

## 3. 【A12】插件 / 扩展机制（重中之重）

**清单长什么样**（真实片段，`apps/daemon/tests/fixtures/plugin-fixtures/sample-plugin/open-design.json`）：
```json
{
  "$schema": "https://open-design.ai/schemas/plugin.v1.json",
  "specVersion": "1.0.0",
  "name": "sample-plugin", "title": "Sample Plugin", "version": "1.0.0",
  "tags": ["sample","phase1"],
  "od": {
    "kind": "skill",
    "taskKind": "new-generation",
    "useCase": { "query": "Generate a {{topic}} brief for {{audience}}." },
    "context": { "skills": [{"ref":"open-design-landing"}], "atoms": ["todo-write","discovery-question-form"] },
    "inputs": [
      {"name":"topic","type":"string","required":true,"label":"Topic"},
      {"name":"audience","type":"select","options":["VC pitch","general"],"default":"general"}
    ],
    "capabilities": ["prompt:inject"]
  }
}
```

- **怎么被发现（三源合并）**：`plugins/registry.ts:99-203` `resolvePluginFolder()` 依次读同目录 `open-design.json`（sidecar，最高优先）、`SKILL.md`（`adaptAgentSkill`）、`.claude-plugin/plugin.json`（`adaptClaudePlugin`），再 `mergeManifests({sidecar, adapters})`（`registry.ts:150-157`）。都没有则报错「contains no SKILL.md, no .claude-plugin/plugin.json, and no open-design.json」。bundled 插件由启动 walker 扫 `plugins/_official/**`（`plugins/bundled.ts:63-140`，支持 `<id>/` 直放与 `atoms|scenarios|bundles/<id>/` 一层递归）。
- **怎么校验**：`parseManifest`（Zod，来自 `@open-design/plugin-runtime`，`registry.ts:24-30`）→ `validateSafe(manifest)`（`registry.ts:158-163`）；作者侧 `validate.ts` 把 resolve+`doctorPlugin` 拼成预装 lint；`doctor.ts:47-100` 额外校验 atom id（`isKnownAtom` 上 `FIRST_PARTY_ATOMS` 目录）、connector refs、记录 freshDigest。
- **怎么装载**：进程内**数据装载**，不是动态 import 可执行代码——插件提供 manifest + skill 正文 + pipeline/atom 声明，apply 时把内容汇入系统提示与运行期驱动（见下）。没有子进程/沙箱插件运行时。
- **贡献点**：`od.kind`（skill/template/design-system/prototype…）；`od.context`（skills/atoms/mcp/designSystem）；`od.connectors.{required,optional}`；`od.genui.surfaces`（插件自带 UI 表面）；`od.pipeline.stages`（流水线阶段）；`od.inputs`（apply 前必填表单）。见 `trust.ts:37-63` `requiredCapabilities()` 逐项枚举。
- **隔离/能力**：`trust.ts` 两档 —— `TRUSTED_DEFAULT_CAPABILITIES`（`trust.ts:15`，含 `mcp:* connector:* genui:* pipeline:*`）vs `RESTRICTED_DEFAULT_CAPABILITIES=['prompt:inject']`（`trust.ts:23`）。`defaultTrustForRecord`：`local` 装=trusted，其余=restricted（`trust.ts:27-29`）。可升权词汇表 `KNOWN_TOP_LEVEL_CAPABILITIES`（`trust.ts:85-97`：prompt:inject/fs:read/fs:write/mcp/subprocess/bash/network/connector/pipeline:*/genui:custom-component），`validateCapabilityList` 拒绝未知名（`trust.ts:112-149`）。
- **热插拔**：`installer.ts:196 installPlugin`、`:877 uninstallPlugin`、`:722 installFromLocalFolder`；状态存 SQLite `installed_plugins` 行（`registry.ts:58-64` 注释、`registry.ts:205-283` rowToInstalledPlugin）；`grantCapabilities/revokeCapabilities`（`trust.ts:160-260`）就地增删能力。
- **apply 贡献落地**：`apply.ts:119 applyPlugin()` 校验 `od.inputs`（`MissingInputError`→422），产出 `ApplyResult`（项目元数据 + systemPrompt block + chip 条），并派生 atom surface（`atoms/auto-surfaces.ts`）、连接器绑定（`connector-gate.ts`）。插件 UI 表面走 GenUI：`routes/genui.ts:47-56` `/api/runs/:runId/genui`；前端 `GenUISurfaceRenderer.tsx`(936)。

> 抄点：**三源兼容 + merge + Zod-validate + trust 能力档 + 唯一写库** 这套骨架，比我们自研装载层成熟得多。

## 4. 【A13】MCP / 工具接入

**双端都有**：
- **MCP client（我们最关心）**：`apps/daemon/src/mcp-config.ts`（1220 行）。存储 `<dataDir>/mcp-config.json`，形状 `{ servers: [...] }`（`mcp-config.ts:9,103`）。`McpServerConfig`（`mcp-config.ts:33-47`）：`id/label/transport(stdio|sse|http)/enabled/authMode(none|oauth)/command/args/env/url/headers`；**刻意对齐 Claude Code `.mcp.json` / Cursor 配置**（`mcp-config.ts:13-17`）。spawn 时按 agent 注入：`buildClaudeMcpJson()`（`:312`）写项目 `.mcp.json`，`buildAcpMcpServers()`（`:386`）给 ACP agent 的 `mcpServers` 参数。内置模板 `MCP_TEMPLATES`（`:594`）。
- **管理 UI**：`apps/web/src/components/McpClientSection.tsx`（1405 行，Settings→MCP 面板）；后端 `mcp-routes.ts`（470）负责增删改、OAuth（`mcp-oauth.ts` 545、`mcp-tokens.ts` 240）、`install-info` 一键盘安装 Codex。
- **MCP server（反向）**：`apps/daemon/src/mcp.ts`（3453 行）是 stdio MCP server，把本地项目的 `list_files/read_file/write_file/create_artifact`（`mcp.ts:512-613`）暴露给**别的** repo 的 agent（Claude Code/Cursor/Zed）；`MCP_SERVER_INSTRUCTIONS` + `ui://` brief app 资源。
- 工具结果回填：run 事件流 `tool_use/tool_result` 由 `runs.ts:113-165 summarizeToolEvents` 汇总成 total/succeeded/failed/unknown/duration。

## 5. 【A11】调度 / 后台任务

- **用户可见的定时任务叫 Routine**（=「定时启动的 agent 会话」）：`routes/routine.ts:1-40` 注册 `/api/routines`，依赖 `RoutineService`（`routines.ts` 678 行）的 `nextRunAt/rescheduleOne/runNow/unschedule`。
- **schedule 形状**：`apps/web/src/components/routineScheduleLabels.ts:5-11` → `hourly`(minute) / `daily|weekdays`(time,tz) / `weekly`(weekday,time,tz)，时区用 `Intl.DateTimeFormat` 计算 GMT 偏移。
- **UI**：`NewAutomationModal.tsx:1-3`「persistence layer is /api/routines，user-facing model is a scheduled agent conversation（新项目或追加会话）」；`RoutinesSection.tsx`(910)、`TasksView.tsx`(1145)。
- **谁 tick**：服务进程内调度（`RoutineService.rescheduleOne/runNow`），无 systemd；其它常驻循环是 `setInterval`（`maintenance.ts:190`、`collab-cloud-service.ts:1728`），属维护轮询不是用户任务。
- 失败/超时：routine 侧未见独立四态；run 侧的超时/取消见 §6。

## 6. 【C1/C2】agent 循环与停止条件

- **主循环不在本仓**：真实「模型→工具→再模型」由外部 CLI agent 执行；OD 是**编排 + 解析 + 判定**。入口 `runtimes/runs.ts`（2577 行）、`runtimes/agent-process.ts`（532，spawn/stdio）、`runtimes/claude-stream.ts`（1107，解析 Claude `stream-json`）、`runtimes/json-event-stream.ts`（1466）。一轮定义=消费一条 turn_end 事件。
- **停止条件（很多且可独立判定）**：
  - 空闲/首输出/产物静默超时：`chat-run-lifecycle.ts:1-7`（10min 默认、artifact quiet 60s），`resolveActiveInactivityTimeoutMs:52-58`。
  - 正常停止：`turn_end && stopReason !== 'tool_use'`（`chat-run-lifecycle.ts:126-129`、`claude-stream.ts:824-858`）。
  - 终止状态归类：`classifyChatRunCloseStatus:57-90`（canceled/succeeded/failed，处理 ACP 强杀 SIGTERM、Windows code=1、已产出产物即算 succeeded）。
  - 重启恢复：`run-restart-recovery.ts`（`interruptDurableRunAfterDaemonRestart`，`runs.ts:24-27`）。
  - **完成度裁定**（超值得抄）：`runs.ts:1689-1694`
    ```ts
    run.endedWithUnfinishedWork =
      Boolean(run.truncatedMidTurn) || hostRecordedDeliveryFailure ||
      (!authenticatedDoneProvesDelivery && !endedByAskingUser
        && todoSnapshotHasUnfinishedWork(run.lastTodoSnapshot));
    ```
    即「max_tokens 截断 / 宿主亲眼看到的媒资失败 / 未完成 todo」三路各自可否决，且宿主证据不被模型自述覆盖（`runs.ts:1653-1688` 注释）。
- **状态持久化**：run 事件 journalled，可 replay（`runs.ts:2072-2084`「Incomplete run event journal replay」守卫）；`runHasHostRecordedDeliveryFailure`、`persisted terminal state`（`runs.ts:1701`）。

## 7. 【A6/A7】记忆

- **存储形态**：纯文件系统 Markdown（`memory.ts:1-25`）：`<dataDir>/memory/MEMORY.md`（索引，一行一条）+ `<type>_<slug>.md`（每条正文 + frontmatter：name/description/type）+ `.config.json`（开关）。**仿 Claude Code auto-memory**。依赖零，复用 daemon 的 `frontmatter.ts`。
- **类型**：`profile / user / feedback / project / reference / rule`（`memory.ts:5-12` 注释 + `MEMORY_TYPES` 契约）。
- **注入**：`composeMemoryBody()`（`memory.ts:621-710`）只注入「被 MEMORY.md 链接的」条目（`parseIndexLinkIds`），按 canon 顺序 profile 先、rule 后；profile 渲染成 KEY/VALUE 行，rule 渲染成 rubric。
- **溯源**：每条 frontmatter 有 `source: heuristic|llm|manual|connector|brand|annotation`（`memory.ts:76-101`）。
- **冲突/自我校验（两环）**：`memory-verify.ts`(180) 把「active rule」当 rubric 做 POST 自校验；`memory-rules.ts`(230) 从标注蒸馏规则；`listActiveRuleEntries()`（`memory.ts:713`）——被移出索引的规则立即停止强制。
- **TTL/老化**：**未找到**（grep 无 ttl 淘汰；仅 `memory-cleanup.ts` 114 行做清理，非 TTL）。跨会话召回=每次组 prompt 时读同一份 MEMORY.md，天然跨会话。
- 事件刷新：`memoryEvents` EventEmitter → `/api/memory/events` SSE（`memory.ts:39-44`），前端 `MemorySection.tsx`(2626) 自动刷新。

## 8. 【D1–D5】界面

- **技术栈**：React 18 + Next 16 App Router；样式=**原生 CSS + Tailwind4(postcss) + CSS Modules**，无 UI 框架。画布=@excalidraw/excalidraw 0.18；富文本=lexical；动效=motion；3D=three。
- **布局范式（最像我们工作台）**：`styles/shell.css:2352` `.split` 三轨 grid：
  ```
  grid-template-columns: var(--project-chat-panel-width) var(--project-chat-handle-width) var(--project-workspace-panel-track);
  ```
  左聊天面板 + 拖拽 handle + 右 workspace；`.split.split-focus`（`:2410`）把前两轨归零折叠全屏画布；`.split-resize-handle`（`:2546`）可拖；`--project-chat-panel-width` 用 `@property` 做过渡（`:2363-2371`）。workspace 内是**多 tab**（`workspace/tab-launcher.ts:1-70` 注册表：打开文件/New Terminal/New Browser/New Page/New Sketch/New Document/Upload；注释「加一种 tab = 注册一条 action + FileWorkspace 加一个 render 分支」）。
- **状态可见性（D3 很强）**：`components/chat/ExecutionShell.tsx:9-16` 一轮的执行记录四态头——「进行中(球+扫光+秒数，默认展开)/思考中/已完成(总耗时,默认收起)/运行失败(红,默认收起)」，正文按 todo 分段；`CountingNumber.tsx`、`PlanPill.tsx`、`RunErrorCard.tsx`。是否有「还差什么」：`runs.ts endedWithUnfinishedWork` 直接喂给 project card / pet task center（`runs.ts:1671-1675`）。
- **主题/密度/多工作区**：light-only（`app/layout.tsx:30-40` themeInitScript 强制 `data-theme=light`，注释明说「product removed the theme setting」，暗色变量仍在 tokens.css 但被刻意封印）；i18n 20+ 语言（`styles/home` 与 `i18n/content.*.ts`）；多工作区=Team/Personal 绑定隔离（`registry.ts pluginVisibleFromWorkspace:262-283`）。
- 设计系统流：`DesignSystemFlow.tsx`(5580) + `styles/design-system-flow.css`(3799)——设计系统 token/组件/审计/版本修订全链路 UI。

## 9. ⭐ 最值得抄的 3 条机制

**① 三轨可拖分栏 + tab 注册表（工作台骨架）**
- 位置：`apps/web/src/styles/shell.css:2352-2436`（`.split` 三轨 + `.split-focus` 折叠 + 变量过渡）、`:2546-2606`（resize handle）；`apps/web/src/components/workspace/tab-launcher.ts:1-70`（LauncherAction 注册表）。
- 为什么好：我们三视图（记忆元画布/进度/能力）正需要「右 agent 对话固定 + 左工作区可折叠放大 + 多 tab 可插拔」，它是用**CSS 变量做宽度动画 + 一条 action 注册一个新 tab**，没有 UI 框架负担，12px 圆角/浅色同一基调。
- 我们抄到哪：`apps/vouch-web/src/web-ui/src/app/scenes/workbench/WorkbenchScene.tsx`（把现在的固定分栏换成 `.split` 三轨 + `--wb-primary` 变量 + tab 注册表）。

**② 插件 trust 能力档 + 唯一写库 + 纯 apply**
- 位置：`apps/daemon/src/plugins/trust.ts:15-149`（两档默认能力 + 词汇表校验）、`registry.ts:97-203`（纯 FS 读、三源 merge）、`apply.ts:1-15,119`（纯函数 apply）、`installer.ts:196,877`（唯一写 + 卸载）。
- 为什么好：我们的 A12 卡在「loader 只有 list/load 没入口、无隔离」；它把「信任两档 → 能力集 → apply 纯函数」拆开，restricted 只能是 `prompt:inject`，升权走显式词汇表，能直接拿来约束「插件能改什么」。
- 我们抄到哪：`tools/plugin/`（自研装载层）与 `tools/skills/inject.mjs`——补 trust 档 + 能力校验 + 纯 apply。

**③ 一轮执行记录的四态头 + 完成度裁定**
- 位置：`apps/web/src/components/chat/ExecutionShell.tsx:9-16,86-200`（四态头 + todo 分段 + 秒数/token）、`apps/daemon/src/runtimes/runs.ts:1689-1694` + `chat-run-lifecycle.ts:120-135`（停止条件族）。
- 为什么好：我们的进度视图只显示「跑/没跑」，缺「在做什么/多久/还差什么/为什么失败」；它四态可折叠 + `endedWithUnfinishedWork`（截断 / 宿主观测失败 / 未完 todo 三路否决）正好补我们的「完成度判定」空白。
- 我们抄到哪：`WorkbenchScene.tsx` 的进度视图 + 一个 `computeEndedWithUnfinishedWork(run)` 纯函数。

## 10. 我们不该抄的

- **不要抄它「无 agent 循环」的形态去替换我们的循环**：OD 把循环外包给 28 个外部 CLI（`runtimes/defs/*.ts`），自己只做编排；我们 DSH 是自带循环的 harness，抄它的 `claude-stream.ts`/`json-event-stream.ts` 解析器会平添「多协议解析」复杂度，只在需要接外部 CLI 时才借鉴。
- **light-only 的强制**是它 2026-08 的产品决策（`layout.tsx:30-37` 删了暗色切换）；我们若要暗色别照搬，但可直接用它的暗色 token 变量段（`tokens.css:236-345`）作为暗色值来源。
- **巨型单文件**别学：`FileViewer.tsx` 20131 行、`ProjectView.tsx` 16253、`SettingsDialog.tsx` 9036——这是历史包袱，抄逻辑别抄组织方式。
- **纯文件记忆 + 无 TTL** 适合它单人本地场景；我们有跨会话/多租户需求，`MEMORY.md + 每事实一文件` 可抄作「人可读层」，但老化/冲突消解要另加（它 `memory-verify/rules` 的 rubric 思路可借，TTL 没有）。
- **`packages/` 缺失的坑**：manifest 的 Zod schema、GenUI 契约、组件库源码都不在快照里，凡是引用 `@open-design/plugin-runtime` 具体实现的结论都只能停在调用签名，不能当源码抄。
