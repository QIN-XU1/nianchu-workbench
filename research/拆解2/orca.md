# orca 拆解（v2「可抄实现」口径）

> 仓库：`D:\refs\orca`（37,185 文件，TypeScript）。**先纠正定位**：它不是 agent 框架 / harness，是
> **一个 Electron 桌面 IDE**，把 Claude Code / Codex / OpenCode 等**外部 coding agent 并行跑在各自
> git worktree 里**，并提供 Chat UI + 终端 + diff + 浏览器 + CLI（`package.json:4`：
> "Next-gen IDE for parallel agentic development"）。**它没有自己的 agent 主循环**——循环全在外部 CLI 里，
> Orca 只负责「起进程、收事件、画界面、收审批」。这一点决定了后面 C1/C2 只能判「判不了」。

---

## 1. 定位与规模（1 段）

- 一句话：Cursor 系的**并行 agent IDE**（MIT，作者 stablyai），版本 `1.4.214`（`package.json:3`），
  主进程入口 `./out/main/index.js`（`package.json:11`）。
- 规模：仓库 37,185 文件，`src/` 下 30,547 文件；主语言 TypeScript。
- 技术栈：Electron `43.8.7`、React `19.2`、zustand `5.1`、tailwindcss `4.3`、monaco `0.55`、
  @xterm/xterm `6.1.0-beta`（`package.json` dependencies/devDependencies）。
- 证据：`package.json:2-11`；`src/` 结构（`src/main` 140+ 子模块 / `src/renderer/src` / `src/shared` /
  `src/cli` / `src/preload` / `src/packages` / `src/wsl-guest`）。
- star / 最近 push：本 checkout **无 `.git`**（`Test-Path .git` = False），**未找到**，不臆测。

---

## 2. 架构骨架

- 顶层目录职责：
  - `src/main`：Electron 主进程。**这是宿主本体**——ACP（`src/main/acp`，与外部 agent 的协议）、PTY、插件、工作区、自动化、浏览器、computer、emulator 等 140+ 子目录。
  - `src/renderer/src`：React UI（`app-shell/`、`components/`、`store/`、`runtime/`、`i18n/`）。
  - `src/shared`：契约 + 纯逻辑（`shared/plugins/*`、`shared/agent-session/*`、`shared/orchestration/*`）。
  - `src/cli`、`src/preload`、`src/packages`、`src/wsl-guest`。
- 依赖方向：renderer → shared（`@/` 与 `../../../../shared`），main → shared；shared 不反向引 main/renderer。
  强制手段是 **CI 脚本（ratchet）而不是约定**：`config/scripts/static-analysis/process-boundaries/check-runtime-electron-ratchet.mjs`
  （`package.json:68`）与 `.../check-legacy-relay-fence-ratchet.mjs`（`package.json:57`），外加 ast-grep 门禁
  （`package.json:29` `lint:ast-grep-gates`）。
- 核心 / 插件边界：核心 = `src/main/plugins`（PluginService + worker + panel host）；
  插件只能通过 manifest 声明、经 capability 白名单与 host-api 绑定访问宿主，**拿不到宿主内部对象**（见第 3 段）。

---

## 3. 【A12】插件 / 扩展机制（重中之重）

**结论：这是一套完整的 Electron 插件体系，不是 VS Code 扩展体系**（无 `package.json contributes` 的 vscode 那套，
而是自研 `orca-plugin.json` + 独立 worker + 隔离 webview 面板）。

### 3.1 清单长什么样
文件名 `orca-plugin.json`（`PLUGIN_MANIFEST_FILENAME`，`shared/plugins/manifest/plugin-manifest.ts:251`）。
真实片段（`examples/plugins/hello-worker-panel/orca-plugin.json`）：
```json
{
  "manifestVersion": 2,
  "execution": "trusted-worker",
  "id": "hello-worker-panel",
  "version": "1.0.0",
  "engines": { "orca": ">=1.4.246" },
  "pluginApi": 1,
  "main": "worker/main.mjs",
  "contributes": {
    "panels":   [{ "id": "tasks", "title": "...", "icon": "blocks", "entry": "src/panel.tsx", "ui": "components" }],
    "settings": [{ "key": "celebrate", "type": "boolean", "default": true }]
  },
  "capabilities": [{ "kind": "storage:own" }, { "kind": "settings:own" }, { "kind": "agent:read" }]
}
```
字段定义见 `plugin-manifest.ts:151-217`：v1 / v2 用 `z.discriminatedUnion('manifestVersion', ...)`；
v2 额外要求 `execution` 档位；`capabilities` 上限 32（`:142-146`）；`contributes` 每项默认空（`:136-141`）。

### 3.2 怎么被发现
`discoverPlugins(...)`（`plugin-discovery.ts:259`）→ `readManifestDir`（`:80`）。
扫描目录：`getUserPluginsDir` = `<userData>/plugins`（`:72-78`）+ 开发文件夹（dev folders，watcher 另起）。
读文件有 1MB 上限（`plugin-manifest-file.ts:6`）。

### 3.3 怎么校验
- Schema：zod（`plugin-manifest.ts:201-217`），`parsePluginManifest` / `parseHostPluginManifest` 返回 `{ok, manifest|error}`。
- 失败回报：`plugin-discovery.ts:103-110` 返回 `{ rootDir, error: 'invalid manifest: ...' }`；
  另含引擎兼容性（`requires Orca X`，`:114-121`）、declared artifact 校验（`:122`）、字体校验（`:139`）。
- consent 指纹：`fingerprintPluginConsent(...)`（`plugin-discovery.ts:160-166`），能力或 worker tier 变化需重新授权。

### 3.4 怎么装载
- 代码插件跑在**独立子进程 worker**：`PluginWorkerManager`（`workers/plugin-worker-manager.ts`），
  有 slot pool、idle reap、restart loop、generation 保留（同目录 `worker-supervision/*`）。
- TS/TSX 源码由 sucrase 转译后加载（`plugin-source-sucrase-transform.ts`、`panels/source-transpilation/plugin-source-transpiler.ts`）。
- **面板**二选一（`plugin-panel-contribution.ts:94-146`）：
  - `ui: "html"`（默认）：`entry` 当网页，跑在隔离 `<webview>`/srcdoc iframe（`panels/guest-isolation/plugin-frame-isolation.ts:9`，元素实现 `components/plugins/frames/plugin-frame-element.tsx:12`）。
  - `ui: "components"`：`entry` 当隐藏模块执行，Orca 用自己的控件**渲染它返回的组件树**（`components/plugins/declarative/*`）。
- panel↔worker 经 `PluginPanelBridge`（`panels/plugin-panel-bridge.ts`），带消息字节预算与速率限制（`:11-29`）。

### 3.5 贡献点（16 类）
`PLUGIN_CONTRIBUTION_POINTS`（`shared/plugins/contributions/plugin-contribution-points.ts:59-76`）：
`panels, commands, events, hooks, languagePacks, keybindings, vmRecipes, themes, terminalThemes,
iconThemes, fonts, syntaxes, customEditors, newFiles, settings, statusBarItems`。
另有**预留**点 `skills` / `mcpServers` / `agents`（同文件 `:82-106`，暂必须为空）。

### 3.6 隔离与能力限制
`capabilities` 是**封闭白名单**，15 种（`plugin-capabilities.ts:16-31`）：`workspace:read/write`、
`agent:read/launch`、`terminal:send/read`、`notifications:show`、`storage:own`、`secrets:own`、
`settings:own`、`appearance:write`、`workspace:create`、`automation:read/write`、`history:read`。
host 调用经 `workers/host-api/plugin-host-call-adapter.ts` / `plugin-host-method-bindings.ts` 绑定，
每个能力独立 gate（`plugin-capability-gate.ts`）。**插件拿不到宿主内部对象**。

### 3.7 热插拔
安装/卸载/更新/启用/禁用齐全（`plugins/installation/*`、`plugin-enablement.ts`），状态存 settings：
`disabledPlugins` + `pluginConsents`（`plugin-enablement.ts:37-45`）；dev 文件夹改动由 watcher 自动重启（`plugin-dev-watcher.ts`）。
市场侧有 `plugins/catalog/*`（marketplace、kill-list、安装统计、update approval）。

---

## 4. 【A13】MCP / 工具接入

- **没有宿主级 MCP client**（因为循环在外部 CLI 里）。只做**配置巡检 + 展示**：
  `shared/mcp-config.ts:45` 的 `MCP_CONFIG_CANDIDATES` 读 `.mcp.json` / `.cursor/mcp.json` /
  `.claude.json` / `.claude/mcp.json`，解析出 `servers/transport/status`（`:23-42`），设置页展示
  （`components/settings/repository/mcp/*`）。
- 起 ACP 会话时明确传 `mcpServers: []`（`acp/session/start/acp-structured-handshake.ts:111,133`）——
  MCP 由外部 agent CLI 自己管。
- 插件清单预留 `mcpServers` 贡献点，但当前**必须为空**（`plugin-contribution-points.ts:106`）。
=> 判定「部分」：有 MCP 配置的读取/UI，无 MCP 连接器。

---

## 5. 【A11】调度 / 后台任务

- `AutomationService`（`main/automations/automation-service.ts:44`）：内置 `setInterval` tick，
  `DEFAULT_TICK_MS = 60 * 1000`（`:41`）。
- 定义 → 存储 → tick → 派发：`dispatch/*`（precheck、refusal、`schedule-drift-report`、`automation-wake-settle`）、
  run 历史 `run-history/*`、完成观察 `observation/run-completion-watcher.ts`、终态保留 `terminal-retention/*`。
- 失败/超时/四态：有 `isFinalAutomationRunStatus` + missed-run / refused-run 记录（`automation-service.ts:10-37`）。
- 还能接管外部调度器（`external-managers/*`）。
=> 「有」：定时任务定义/存储/tick/失败态都齐，但它调度的是「唤起一次 agent」，不是常驻服务。

---

## 6. 【C1/C2】agent 循环与停止条件

- **主循环不在本仓库**：Orca 的「一轮」= 一次 prompt 派发给外部 agent。
  `AcpStructuredSessionAdapter.dispatch`（`acp/session/acp-structured-session-adapter.ts:101` → `:137 turns.dispatch`）、
  `cancelTurn`（`:155`）；轮次状态机 `AcpStructuredTurns`（`acp/turns/acp-structured-turns.ts:24-45`，
  `get running`）。
- 停止条件（Orca 侧可见的）：人点 Stop / steer 打断（`acp-structured-turns.ts:27-45`）、
  provider 报错（`acp/turns/acp-prompt-failure.ts`）、以及**外部 CLI 自己的 max_turns**
  （`shared/agent-status/process/dsb-headless-command.ts:38` 传 `--max-turns`；
  `native-chat/.../provider-frame-disposition.ts:162` 收 `error_max_turns`）。
- 状态持久化：transcript jsonl 可 resume（见第 7 段）。
=> **C1 判不了**（无自有主循环可看）；**C2 部分**（只有 stop/steer + 外部 max_turns，**没有**预算/空工具停/显式 done 等复合刹车）。

---

## 7. 【A6/A7】记忆

- `src/main/memory` **不是对话记忆**，是**进程内存/RSS 监控**（`main/memory/host-memory.ts`、
  `windows-process-resource-collector.ts`）。
- 会话「记忆」= transcript 持久化 + replay：`native-chat/transcript-reader.ts:35` 读全量 transcript，
  `acp/history/acp-history-replay.ts:14` 回放历史；可 resume/reattach。
- `skills/`（顶层）与 `src/main/skills` 是**技能包安装**，不是记忆召回。
=> **A6 无 / A7 无**（没有向量库、没有溯源/老化/TTL/冲突消解、没有跨会话语义召回）。

---

## 8. 【D1–D5】界面

- 技术栈：React 19.2 + Electron 43 + zustand 5 + tailwind 4 + monaco + xterm（`package.json`）。
- 布局范式（D1）：**tab 分组 + pane 切分**；关键点——**聊天不是独立面板，而是终端 pane 上的 portal**：
  `components/terminal-pane/chat/TerminalPaneNativeChatPortal.tsx:20-95`（同一个 pane 可在「Chat / 终端」间切换，
  `onSplitRight/onSplitDown` `:45-46`）。聊天本体 `NativeChatView.tsx:11-32`；右侧 sidebar activity bar 承载插件面板
  （`plugin-panel-contribution.ts:119` "right-sidebar activity bar"）；工作区 = 多 worktree（`components/sidebar/workspace-card/*`）。
  - 会话内部组织：`components/native-chat/` 分 `conversation/ composer/ messages/ prompts/ tools/ usage/ worker-approvals/ subagents/` 等（目录）。
- D3 状态可见性：`context.usage` 时间线（`acp/timeline/acp-context-usage.ts:1`）显示上下文用量/窗口；
  crew 面板按 `needsYou / working / idle / failed` 分组（`components/orchestration-crew/OrchestrationCrewPanel.tsx:57-69`）；
  status-bar 有账号/用量/rate-limit 段（`components/status-bar/*`）。
- D4 主题/i18n：`useTranslate`（`i18n/use-translate`）、插件可贡献 themes/tokens（`shared/plugins/artifacts/plugin-theme-*`）。
- D2 可视化 / D5 动效：有状态指示点、crew 图标栈、usage 图（`components/status-bar/*Usage*`）；
  动效令牌未专门核查 → D5 判不了。

---

## 9. ⭐ 最值得抄的 3 条机制

### （1）审批卡片：把「确认」抽象成 options 数组，协议与展示分离
- 位置：`components/native-chat/prompts/NativeChatApprovalCard.tsx:43-230`；类型 `ChatApproval`
  `shared/native-chat/input/native-chat-interactive-prompt.ts:16-33`（`options: {label, send}[]`）。
- 为什么好：它把 title / description / `decisionReason` / `blockedPath`（渲染成 "Needs access to <路径>"）/
  `detail`（可折叠，`:201-230`）/ `subject`（plan 审批走 markdown）全部**结构化**，用户一眼知道「要访问什么、
  为什么」。选项按钮第一个默认 primary（`neutralOptions` 时降级为平级），Esc=取消/折叠（`:80-110`）。
  我们缺的正是这种「协议驱动、可被任意 provider 复用」的确认卡。
- 我们抄到哪：`apps/vouch-web/src/web-ui/src/app/scenes/workbench/WorkbenchScene.tsx` 对话面板里的 tool-approval 卡片。

### （2）并行 worker 审批栈：把子 agent 的确认汇总到父对话统一收口
- 位置：`components/native-chat/worker-approvals/NativeChatWorkerApprovals.tsx:61-`（stack 固定在 composer 上方，
  allow/deny 走 runtime RPC `orchestration.approvalAnswer`，`:86`；deny 固定带 `OWNER_DENY_REASON` `:32`）；
  payload→卡片 `worker-approval-card-model.ts`（`allowedActions.map` → options）。
- 为什么好：多 agent 画布里，审批**不该每个节点各弹一个框**。它把 worker 的确认拉进 coordinator 的对话流，
  做成可堆叠（`placement:'stacked'`，不抢焦点），答完变 receipt 留在原位。这正是「agent 画布 + 对话面板」需要的收口方式。
- 我们抄到哪：`WorkbenchScene.tsx`（对话侧）+ 画布节点的审批中转。

### （3）插件 manifest 的「execution 档位 + capability 白名单 + consent 指纹」三件套
- 位置：`shared/plugins/manifest/plugin-manifest.ts:151-217`（v2 `execution`：
  `data / declarative / sandboxed-ui / trusted-worker`，超出档位的贡献直接校验失败）；
  `shared/plugins/capabilities/plugin-capabilities.ts:16-31`（15 种能力白名单）；
  `main/plugins/plugin-enablement.ts:14-45`（consent 绑定 `consentFingerprint`，能力/tier 变化必须重批）。
- 为什么好：它把插件从「信任即全权」降到「**最小权限档位 + 声明能力 + 指纹可复核**」，且档位越权直接 schema 拒绝。
  比一句 `trust: true` 强太多，是我们插件装载层（`tools/plugin/kernel.mjs`）最该补的。
- 我们抄到哪：dsh 的 plugin/skill 装载层（`tools/plugin/kernel.mjs` + `cordis.patch.yml`）。

---

## 10. 我们不该抄的

1. **别抄它的 IDE 复杂度**：140+ `src/main` 子模块、160+ `components` 目录、一堆 ratchet/lint/审计脚本，
   是为大型 IDE 团队堆的。我们要的是「agent 画布 + 对话面板」，不需要 tab 分组/split pane/WSL/SSH/emulator/browser 全栈。
2. **别抄「无自有 agent 循环」的假设**：Orca 假设循环在外部 CLI，所以它用 ACP/PTY 双模态 + 「chat 是终端的 portal」。
   我们的循环在 dsh，直接照搬这层会平白多出一个「进程代理」。
3. **MCP 只做配置巡检、不做宿主 client**：这部分不能抄，我们要真 MCP client。
4. **插件 marketplace / kill-list / 签名 / 审计链**：早期过度，先做「manifest + capability + worker 隔离」即可。
5. **多端（desktop/mobile/web/wsl）齐头并进**：它到处是 `isWebClientLocation`、WSL relay、remote-layout 分支，
   是历史包袱，不要复制。
