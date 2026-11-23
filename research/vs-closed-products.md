# ChatGPT 与 Claude Code 能力剖析（闭源，产品级）

> 目的：给「这能力要不要做、做到什么程度算超过」提供判据。重点在找可超过的点，不是夸。

## 说明：证据等级

- **[确证]**：可由本机已安装的官方分发物／官方类型定义／官方发布物复现，注明文件、版本或字段。
- **[高置信]**：多来源一致，或来自官方文档但我方本机无法复核（本环境 `docs.claude.com`、`developers.openai.com`、`help.openai.com` 均被拦截或返回 403）。
- **[推测]**：仅由结构、命名、数据表推断，无直接证据，不得当事实引用。

**本机取证（2026-11-14，只读）**：Claude Code **2.1.325**（原生单二进制 355MB，`claude --help` 全量参数、二进制字符串）；Agent SDK **0.3.325** 的 `sdk.d.ts`(592KB)/`sdk-tools.d.ts`(179KB)；ChatGPT **桌面 26.901.5003.0**（Appx 内含 `ChatGPT.exe` 与 `Codex.exe`）与 Codex CLI **0.167.2**；`~/.codex` 运行产物（rollout JSONL、`state_5`/`memories_1`/`goals_1`/`queue_1`/`logs_2`/`thread_history_1` 六个 SQLite）、桌面 `config.toml`、`app.asar` 字符串；`~/.claude/settings.json`。**仅读取结构与元数据，未引用任何用户会话内容或凭据。**

**前提更正**：[确证] Codex CLI 是 **Apache-2.0 开源**（npm README 载明），真正闭源的是 ChatGPT 桌面与服务端；Claude Code 闭源但公开 Agent SDK 类型。故 OpenAI 侧证据较硬，Anthropic 侧靠「发行物 + 公开类型」。

---

## 一、ChatGPT（含 Codex/Agent 形态）

### 定位

一句话：**ChatGPT 正在把「聊天／项目／连接器／深研／图像／语音」与「Codex 执行体（本地 agent + 云任务）」合并成一个桌面壳**。[确证]：Appx 内同时有 `ChatGPT.exe`、`Codex.exe`、`chatgpt-app-dark.ico`；状态键 `chatgpt-migration-announcement-completed-v1`；插件文案自称 "ChatGPT in-app browser"、"Windows Computer Use lets ChatGPT use any app"。所以「ChatGPT 有 agent」和「Codex 有聊天」是同一件事的两面。

### 能力清单（20 维）

| 维度 | 判定 | 证据（优先本机可复现） | 置信度 |
|---|---|---|---|
| 1 代码编辑 | 部分 | 统一 `exec` 工具里 `apply_patch`（`*** Begin Patch/Update File/@@/+`），归档 rollout 中 `exec` 调用 817 次；无独立 diff 预览流程，回退主要靠 git；`thread-tab-route-checkpoint/rewind` 字符串存在但语义未证 | [确证]/回退[推测] |
| 2 终端与沙箱 | 有（工程级） | `sandbox_policy`：`managed{file_system:restricted, network:restricted}`，逐路径 read/write，`.git/.agents/.codex` 只读，`/tmp` 可写；另有 `disabled`（danger-full-access）；`codex-windows-sandbox-setup.exe`、`config.toml [windows] sandbox="elevated"` | [确证] |
| 3 联网/搜索 | 有 | `web_search_call` 事件类型；"search the web" 个性化设置；browser/chrome 插件支持 `iab/extension/cdp` 三后端 | [确证] |
| 4 多模态 | 有 | app-context 明示可用 markdown 绝对路径渲染图/视/音；`imagegen` 内置技能；computer-use 截屏；realtime voice；`visualize` 交互件 | [确证] |
| 5 长上下文与压缩 | 部分 | `model_context_window=258400`（rollout 实测）；`compacted` 事件内容为"另一个语言模型生成的摘要"；压缩不结束任务（system prompt 明说） | [确证]；具体模型窗口[推测] |
| 6 记忆 | 有（跨会话） | `memories_1.sqlite` 两阶段：`stage1_outputs(raw_memory, rollout_summary, usage_count, last_usage, selected_for_phase2)` + `jobs(lease/retry)`；设置双开关 "Reference saved memories" / "reference recent conversations" | [确证] |
| 7 项目管理 | 有 | `projects`+`project_roots`（多根工作区）、worktree 字符串、cloud task 关联 ChatGPT project、PR 相关字符串 5800+、`list_projects`/`move_project_to_sidebar_section` 等工具 | [确证] |
| 8 子代理/并行 | 有 | thread 即 agent：`create_thread/fork_thread/list_threads/read_thread/wait_threads/send_message_to_thread/handoff_thread`；`thread_spawn_edges`；`thread_dynamic_tools` | [确证] |
| 9 部署形态 | 云+桌面+CLI+IDE | 桌面 Appx、`codex` CLI、`source=vscode`、云会话；云会话**读不到本地文件**（UI 文案："this conversation started in the cloud, so ChatGPT can't access files on your computer"） | [确证] |
| 10 扩展机制 | 有（插件+App） | 插件包=`.codex-plugin/plugin.json`+`skills/`+`mcpServers`+`hooks`（Stop→`mcp_tool`）+ `interface`（图标/分类/默认提示）；市场 `openai-bundled`/`openai-api-curated`；Apps=`codex_apps` MCP，`tool_search` 懒加载 | [确证] |
| 11 权限审批 | 有（三档治理） | `approval_policy`(never/on-request…)+`sandbox_policy`+`guardian-approvals`（自动审批复核）+`approvals_reviewer`；system prompt 明写"按判断、授权跨轮持久、被 auto-review 拒绝要如实转述" | [确证] |
| 12 可观测性 | 有（工程向） | `logs_2.sqlite` 12672 行（level/target/module/file/line/thread_id）；`token_usage_record`；`thread_turns(status/error/duration/first-token)`；`world_state` 每轮快照；面向用户的审计视图[推测]弱 | [确证]/弱项[推测] |
| 13 循环与停止 | 有 | turn 事件流 `task_started→…→task_complete/turn_aborted`；`thread_goals` 有 `token_budget/tokens_used/time_used/status(budget_limited)`，说明有目标式长跑与预算停止 | [确证] |
| 14 工具协议 | 有（独特） | 统一 `custom_tool_call: exec`（JS 体调 `tools.exec_command`/`apply_patch`，`Promise.allSettled` 并行）+ `js` 持久 REPL + `wait/sleep`；MCP 走 `mcp__server__tool`；`deferred_tool_world_state` | [确证] |
| 15 错误恢复 | 部分 | rollout→`thread_history` 投影与重放、jobs `retry/lease`、`turn_aborted`+`error_json`、命令可 `yield_time_ms` 转后台 | [确证] |
| 16 自验证 | 部分偏弱 | 内置 `review-agent` 技能（只读、缺陷优先、可证伪的入册条件）；`codeReviewPlugin` 开关；验收标准仍由 agent 自拟 | [确证]/结论[高置信] |
| 17 交互形态 | GUI 为主 | 桌面 GUI + CLI TUI + VS Code/Windsurf 扩展 + Web；`--ide` | [确证] |
| 18 布局与密度 | 中低 | `conversationDetailMode="STEPS_COMMANDS"`、`show-context-window-usage`、右栏（file tree/artifact/browser）、thread tabs `routes+topology`（标签页路由/拓扑结构）、侧栏项目/任务/分区 | [确证] |
| 19 状态可见性 | 中 | 上下文窗口占用、步骤/命令折叠、`heartbeat-thread-permissions`、未读态；每任务成本/预算仪表[推测]无 | [确证]/[推测] |
| 20 会话组织 | 强 | threads/projects/sections/pinned/archived/自动标题/prompt history/drafts/tabs；`remote_control_enrollments`（跨机遥控）；外部 agent 配置导入（claude-code/claude-cowork/cursor） | [确证] |

### 架构推断

- **分层**：Electron 壳（Chromium 152）→ app-server（JSON-RPC，`threads`/`dynamic_tools`/`spawn_edges` 落在 `state_5.sqlite`）→ Codex 执行体；六个 SQLite 分库承担状态、历史投影、队列、记忆、目标、日志。[确证]；「app-server」为结构推断[推测]
- **执行循环**：`session_meta`(base_instructions+cli_version) → `turn_context`(world_state：agents_md/environments/permission_profile/skills) → `response_item`×N → `token_usage_record`/`compacted`。world_state 每轮注入是它「状态驱动」的核心。[确证]
- **记忆**：后台两阶段管线（stage1 原始记忆+rollout 摘要 → phase2 挑选），带 usage 计数与 job 租约，形态接近「离线巩固」而非「实时写入」。[确证]
- **扩展信任面**：App=一组 MCP 工具，插件=技能+MCP+App 的捆绑；这意味着第三方能力进入的默认通道是 **MCP**，而不是自造协议。[确证]
- **并发模型**：一个 thread 一个工作区（可多根），线程有独立 sandbox/approval；父子关系显式落表，但**无每子代理的独立资源账本**（仅 thread 级 tokens_used）。[确证]/缺口[推测]

### 界面特征（若做界面，从这里学）

1. **「任务」是统一概念**：UI 叫 task、内部叫 thread、提示词明说同义——把「会话/子代理/后台任务」收成一个对象，避免用户做概念翻译。[确证]
2. **状态可见性写进壳里**：上下文窗口占用、步骤/命令二级详略、权限心跳、未读；不靠聊天文本汇报。[确证]
3. **右栏承载产物**（文件树/artifact/内置浏览器），对话区只留过程摘要——产物与过程分离。[确证]
4. **云/本地边界对用户直说**：cloud task 明示「不能读你电脑文件」。诚实标注能力边界，比隐藏更省支持成本。[确证]
5. 可抄但别全抄：pets、贴纸、busy-bar 这类情绪化层，对「工作台」是噪音。[推测]

---

## 二、Claude Code

### 定位

一句话：**面向终端的「高密度单列 agent 工作台」**，用 44 个细粒度工具 + 33 个 hook 事件 + 6 种权限模式构成可编程 harness，再把同一内核铺到 IDE/桌面/Web/云/Chrome。[确证]

### 能力清单（20 维）

| 维度 | 判定 | 证据 | 置信度 |
|---|---|---|---|
| 1 代码编辑 | 有（最完整） | `FileEdit(old/new/replace_all)` 返回 `structuredPatch`+`gitDiff`+`originalFile`+`userModified`；`FileWrite`/`NotebookEdit`；用户可改提案 | [确证] |
| 2 终端与沙箱 | 有 | `Bash`/`PowerShell`：后台任务、Ctrl+B、超时自动转后台；`--restricted` 移除执行类工具并收窄文件域；`seatbelt`(11)/`bubblewrap`(65) 字符串；Windows 沙箱线索 | [确证]/Windows[推测] |
| 3 联网/搜索 | 有 | `WebFetch`/`WebSearch` 工具；Chrome 集成（`--chrome`/`OfferChromeSetup`） | [确证] |
| 4 多模态 | 部分 | `--file file_id:path` 预取、图片粘贴、bash 输出 `isImage`；transcript 有 `voice_call_talk`、`mobile` 命令；**无图像生成** | [确证]/语音场景[高置信] |
| 5 长上下文与压缩 | 有 | `--autocompact auto 或 100k–1M`；`compact_boundary`/`microcompact_boundary`/`isCompactSummary`；每模型 `autoCompactWindow`(实测 196k–272k)；`context-1m` beta | [确证] |
| 6 记忆 | 有（三层） | `CLAUDE.md`+auto memory（`# auto memory`、去重指令、`memory_saved` 事件）+`agent-memory/{user,project,local}`+team memdir；`Projects` 工具含 `project_memory_list/read` 与 RAG `project_search` | [确证] |
| 7 项目管理 | 有 | `-w/--worktree`、`EnterWorktree/ExitWorktree`（含 multi-repo workspace）、`claude rm` 删 worktree、`--from-pr`、`--tmux`、`--cloud`、`ultrareview`（云多代理评审） | [确证] |
| 8 子代理/并行 | 有（最全） | `Agent`(subagent_type 含 `fork`/Explore、后台默认、model/effort 覆盖)；SDK `agents` 定义含 `observer`/`omitClaudeMd`/`autoCompactWindow`；`TaskCreate/Update/List` 任务板；Agent teams（`--teammate-mode`、`TeammateIdle`）；`claude agents/attach/logs/stop` | [确证] |
| 9 部署形态 | 最全 | 原生 CLI + 桌面(`--desktop`) + IDE + Web(claude.ai/code) + 云(`--cloud`) + 自托管环境(`--environment ccpool_`) + Chrome + 企业 gateway | [确证] |
| 10 扩展机制 | 最全 | plugins(`--plugin-dir/--plugin-url`/市场) + skills(`SKILL.md`、`ProposeSkills` 自提技能) + **33 hook 事件** + MCP(stdio/SSE/HTTP/sdk) + output styles/workflows/themes/keybindings；`--safe-mode` 一键全关；`import` 从别的 agent 迁移 | [确证] |
| 11 权限审批 | 有（6 模式） | `default/acceptEdits/plan/dontAsk/auto/bypassPermissions`；allow/deny 规则（`Bash(git *)`）；权限建议 `PermissionUpdate`；`PermissionRequest/PermissionDenied` hooks；`PermissionDecisionClassification` 喂遥测 | [确证] |
| 12 可观测性 | 强 | OTel spans（`claude_code.interaction`/`invoke_agent`/`gen_ai.*`）+`--debug[=hooks,mcp]`+`--debug-file`；transcript 事件分类；`SDKMessage` 40+ 事件（rate limit/status/permission denied/writes lost）；`observer` 只读观察代理；gateway 企业遥测 | [确证] |
| 13 循环与停止 | 有 | `maxTurns`、`--max-budget-usd`、`--task-budget`、`effort` 五档、`--fallback-model`；`ScheduleWakeup`(/loop 动态节奏)、`CronCreate`(持久化)/`Monitor`(命令或 WebSocket)、`ProposeGoal`（可验证完成条件+独立评估器） | [确证] |
| 14 工具调用协议 | 有 | 44 个离散工具 JSON Schema；`toolAliases`（把 `Bash` 重定向到 `mcp__workspace__bash`）；`--input/output-format stream-json`；`ENABLE_TOOL_SEARCH` | [确证] |
| 15 错误恢复 | 有 | `SDKAPIRetryMessage`、`permission_retry`、`SDKSessionWritesLostMessage`、`--resume/--fork-session/--rewind-files`、checkpoint/rewind、压缩边界 | [确证] |
| 16 自验证 | 部分偏强 | `ReportFindings`(CONFIRMED/PLAUSIBLE+verify pass)、`ultrareview` 云审、review 代理、`ProposeGoal` 评估器、`/doctor`、`SendFeedback` 模型自报缺陷（含 failure_mode：幻觉/提前停止/循环/过度自信） | [确证]/仍自评[高置信] |
| 17 交互形态 | TUI 为主 | TUI + IDE 内嵌 + 桌面 + Web + Chrome；`--ax-screen-reader` 无障碍 | [确证] |
| 18 布局与信息密度 | 高 | 单列时间线；过程行折叠成一张卡（36px 行、无图标、行尾 chevron）；等待行（三点动画+耗时+"No response yet"）；上下文饼图+数字行；搜索 palette | [确证]/布局细节[高置信] |
| 19 状态可见性 | 强 | 上下文计量 + token/缓存命中/成本（按币种） + 模型/effort/权限模式 + 后台任务提示 + `status(compacting/requesting)` | [确证] |
| 20 会话组织 | 强 | `--resume/--continue/--name/--session-id/--fork/--from-pr/--teleport`、`purge`、后台 agents 列表、自动标题、`projects`、transcript 归档 | [确证] |

### 架构（已知：CLI + MCP + skills + hooks + subagents，及其扩展）

- **单内核多壳**：一个原生二进制（Bun 编译）即是 CLI/host；桌面、Web、云会话、Chrome 都是同一 harness 的不同前端与传输。[确证]
- **工具层**：44 个离散工具（含 `Workflow` 脚本编排、`Artifact` 发布、`RemoteTrigger` webhook、`Monitor`、`Cron`、`Projects`、`ProposeSkills/ProposeGoal`），通过 `toolAliases` 可被宿主重定向到 MCP 工具——**工具名是稳定契约**。[确证]
- **事件层**：33 个 hook 事件（Pre/PostToolUse、PermissionRequest/Denied、Pre/PostCompact、SubagentStart/Stop、TaskCreated/Completed、WorktreeCreate/Remove、ConfigChange、FileChanged…）+ `SDKMessage` 事件流，等于把 harness 每个关节都暴露成可编程点。[确证]
- **记忆层**：`CLAUDE.md`（用户写）+ auto memory（AI 写，含去重纪律）+ agent-memory 三作用域 + team memory + Projects（云端项目知识库，带 RAG）。[确证]
- **自演进**：`ProposeSkills`（自己提出新技能/改进，附 memory 证据）、`skill-creator`/`plugin-creator` 类能力、`SendFeedback` 自报产品缺陷——**把「改自己」做成了工具**。[确证]

### 界面特征（TUI 信息密度具体怎么排）

1. **三级信息降级**：过程行（工具调用）压成一行、可折叠卡片；思考/摘要再压一层；只有回答占正文宽度。[确证]
2. **一屏三块固定信息**：顶部状态（模型/effort/权限模式）、底部输入框上沿（上下文计量饼图 + token/成本数字行）、中间时间线；等待时状态行变成"正在做什么+已耗时"。[确证]
3. **读/搜默认折叠，改/跑默认展开**——按风险分配可见面积。[高置信]
4. **成本即一等公民**：上下文占比、缓存命中率、按币种结算，随流式 token 实时走字。[确证]
5. **过程可回溯**：transcript 有 `work_segment/grouped_tool_use/collapsed_read_search/recap_fold/microcompact_boundary`，为"回看一段工作"设计的数据结构。[确证]

---

## 三、两者共同的最强项（短期超不过，要老实承认）

1. **模型–harness 联合调优**：两家的提示词、工具描述、压缩策略和自家模型是一起训／一起评的（Claude 的 effort 五档、Codex 的 reasoning summary 与 `personality` 都是模型侧参数）。[确证]/效果[高置信] 我们换任意模型都拿不到同等工具调用稳定性。
2. **工具调用可靠性 + 失败恢复的工程量**：重试事件、写入丢失检测、投影重放、沙箱 ACL，这些是数千个边缘案例堆出来的。[确证]
3. **长上下文与压缩**：Claude 1M 上限 + microcompact；Codex 258k + 两阶段记忆巩固。压缩后仍能续跑是硬功夫。[确证]
4. **分发与账号体系**：订阅即用、企业 gateway/合规、桌面/IDE/Web/手机全端。[确证]
5. **扩展生态引力**：MCP 事实标准 + 双方各自插件市场 + 第三方自愿适配（连我们的参考插件都在复刻 Claude 皮肤）。[确证]
6. **沙箱工程**：Windows 提权沙箱、seatbelt/bubblewrap、CUA 运行时——安全边界做错会出事故，这块不宜自研追赶。[确证]

## 四、两者共同的短板 / 结构性问题（这是机会）

1. **验收靠自己**：Claude 的 review 有 `CONFIRMED/PLAUSIBLE`，Codex 有 review-agent 技能，但「任务是否真完成」最终由同一个模型判定，没有独立可复算的完成判据。[确证]/结构性[高置信] → **机会：外部 DoneSpec + 独立验证器 + 证据账本**。
2. **压缩是摘要，不是状态**：Codex 的 `compacted` 明写"另一个模型生成的摘要"；Claude 是 `isCompactSummary`。摘要不可审计、会丢决策与约束，且用户无法检查丢了什么。[确证] → **机会：结构化任务状态（目标/约束/决策/证据索引）替代散文摘要**。
3. **审批仍是"问人"**：Codex 提示词直说"用户很烦被反复确认"，于是靠 `guardian-approvals` 自动复核；Claude 用 6 模式+hooks。但都没有**影响面预演**（这次改动会碰哪些文件/端点/数据）与**审批预算**。[确证] → **机会：策略引擎 + dry-run + 爆炸半径预估**。
4. **记忆无治理**：两家都在提示词里写"写前去重/可更新"，但都没有用户可见的 provenance、冲突检测、过期与遗忘面板；记忆仍是黑箱。[确证]/UI[推测] → **机会：可审计记忆（来源、冲突、TTL、用户确认）**。
5. **多代理不可见**：Claude 有 agents 列表与 attach，Codex 有 thread tabs/spawn_edges，但没有拓扑视图、没有每代理成本/预算台账、没有共享写冲突提示。[确证]/缺口[推测] → **机会：任务板 + 拓扑 + 每代理资源账本**。
6. **云/本地割裂**：ChatGPT cloud task 读不到本地文件；Claude 云会话与本地会话也是两套状态。[确证] → **机会：local-first 单一状态，云端只做算力**。
7. **平台锁定**：记忆/目标/会话都存在厂商私有格式（Codex 的六个 SQLite、Claude 的 `~/.claude`）。两家都新加了「从别的 agent 导入」（Claude `import`；ChatGPT 探测 claude-code/cursor），反证了迁移是真实痛点。[确证] → **机会：开放会话/记忆格式 + 双向导入**。
8. **可观测面向工程，不面向用户**：OTel/logs 是给 SRE 的；用户看不到「这条结论来自哪次工具输出/哪行文件」。[确证]/推断[高置信] → **机会：决策级 trace，每条结论可点回证据**。

## 五、对我们的 10 条可执行结论

> 每条给「做不做／做到什么程度算超过」，判据可量化。以下是我们自己的建议，不是对两家的断言，故不逐条标置信度；依据见上文已标注的证据。

1. **做，且这是主战场：任务可靠性闭环**。不追模型能力，追「做完并能证明做完」。超过判据：任一任务能输出 DoneSpec + 独立验证器结论 + 证据链，第三方（人或另一个 agent）可只凭产物复算出「完成/未完成」，且误判率 < 5%。
2. **做，记忆改成「可审计记忆」**。保留现有「3 条/300 字/默认关闭/fail-open」，加 provenance、冲突检测、TTL、用户确认写回。超过判据：3 条/300 字注入的 recall ≥ 当前全量注入的 95%，且每条记忆可点回来源会话/文件行；冲突记忆 100% 被标出而非静默覆盖（参考 `研究素材/笔记01` 与 `research/记忆系统顶尖实践-调研报告.md` 的 1.2 / 1.4 节）。
3. **做，用结构化状态替代摘要**。超出判据：压缩后回放测试中关键决策/约束/未完成项丢失率 = 0，且用户能看到"这次压缩丢了什么"。
4. **做，审批升级为「策略 + 预演」**。超过判据：危险操作 0 次静默执行；每次审批附影响面（文件/命令/外网/写盘）；同类审批次数比 Claude 的 6 模式下降 ≥ 30%。
5. **做，多代理可见化**。超过判据：N 个并行代理的拓扑、各自 worktree/沙箱边界、token/成本/耗时实时可看；同文件并发写冲突必须被检测并提示（两家发行物中均未见，[推测]）。
6. **做，决策级 trace**。不是 token 级日志。超过判据：任意一条结论/改动可点到「哪次工具调用、哪个文件行、哪条记忆」；可导出为人类可读的审计报告（对比：两家遥测服务运维与企业合规，不供终端用户追溯单条结论）。
7. **界面：抄 Claude 的密度 + 补它的缺**。过程行折叠卡、等待行的"做什么+耗时"、上下文计量饼图+成本行照做；再加**目标/任务板**这一层（两家都只有会话列表）。超过判据：用户 3 秒内能回答「在做什么/花了多少/还差什么」；单屏可见信息项 ≥ Claude，且多出一个"任务完成度"。
8. **扩展：只做 MCP + 兼容两家的清单**。做 MCP 宿主，同时能加载 Codex 的 `.codex-plugin/plugin.json`（skills+MCP+hooks+interface）与 Claude 的 `SKILL.md`/hooks。超过判据：现有生态插件零改可直接跑 ≥ 1 个真实插件；自研协议一律不新增。
9. **部署：local-first + 数据自有 + 可选云爆发**。超过判据：断网全功能可用；云端只在需要算力时接管，且能访问本地工作区（直接对打 ChatGPT cloud task 的限制）；记忆/会话格式公开、可导入导出。
10. **明确不做（至少这一轮）**：图像/视频生成、语音通话、computer use、自研沙箱。理由是这些是模型与系统工程密集型、大厂边际成本低而我们无法形成判据优势；只保留接口位（MCP 工具位）以便未来接入。**把省下的力气全押在第 1、2、3 条——那三条是结构化优势，且两家受"自己给自己判卷"的结构约束，短期不会自破。**
