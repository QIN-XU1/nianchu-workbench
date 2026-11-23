# 闭源产品拆解：7 个

> 对象：ChatGPT/Codex、Claude Code 桌面版、Cursor、Trae、WorkBuddy、CodeBuddy、Qoder
> 证据等级严格分级：**[确证]** 本机取证可复现 / **[高置信]** 多来源或官方文档但本机不可复核 / **[推测]** 仅结构推断
> 拆解时间：2026-11-15 ｜ 按 `research/拆解/标准.md`

## 证据基础

| 产品 | 本机取证 | 证据强度 |
|---|---|---|
| ChatGPT / Codex | 桌面 26.901.5003.0（Appx 内含 ChatGPT.exe + Codex.exe）、Codex CLI 0.167.2、`~/.codex` 六个 SQLite、rollout JSONL、config.toml | **强**（[确证]） |
| Claude Code | 2.1.325 原生单二进制 355MB、Agent SDK 0.3.325 的 `sdk.d.ts`(592KB)/`sdk-tools.d.ts`(179KB)、`~/.claude/settings.json` | **强**（[确证]） |
| **Qoder** | `D:\file\software\Qoder` Electron 应用，app.asar **127.2MB**，v**0.1.6**，38 依赖 | **中**（[确证] 结构，实现[推测]） |
| **WorkBuddy** | `D:\file\software\WorkBuddy` Electron 应用，app.asar **173.6MB**，v**5.9.3**，19 依赖 | **中**（[确证] 结构） |
| Cursor | 未安装 | **弱**（仅文档 + 公开信息 [高置信]） |
| Trae | 未安装 | **弱**（仅文档 [高置信]） |
| CodeBuddy | 未安装 | **弱**（仅文档 [高置信]） |

> **取证纪律**：只读结构、元数据、包清单、文件路径。**不引用任何用户会话内容或凭据**。

---

# 一、ChatGPT / Codex

## 一句话定位

**ChatGPT 正在把「聊天 / 项目 / 连接器 / 深研 / 图像 / 语音」与「Codex 执行体（本地 agent + 云任务）」合并成一个桌面壳。**

[确证]：Appx 内同时有 `ChatGPT.exe`、`Codex.exe`、`chatgpt-app-dark.ico`；状态键 `chatgpt-migration-announcement-completed-v1`；插件文案自称 "ChatGPT in-app browser"、"Windows Computer Use lets ChatGPT use any app"。

**所以「ChatGPT 有 agent」和「Codex 有聊天」是同一件事的两面。**

## 底层架构

- **分层**：Electron 壳（Chromium 152）→ app-server（JSON-RPC，`threads`/`dynamic_tools`/`spawn_edges` 落在 `state_5.sqlite`）→ Codex 执行体；六个 SQLite 分库承担状态、历史投影、队列、记忆、目标、日志。[确证]；「app-server」为结构推断[推测]
- **执行循环**：`session_meta`(base_instructions+cli_version) → `turn_context`(world_state：agents_md/environments/permission_profile/skills) → `response_item`×N → `token_usage_record`/`compacted`。**world_state 每轮注入**是它「状态驱动」的核心。[确证]
- **记忆**：后台两阶段管线（stage1 原始记忆 + rollout 摘要 → phase2 挑选），带 usage 计数与 job 租约，形态接近「离线巩固」而非「实时写入」。[确证]
  `memories_1.sqlite` 两阶段：`stage1_outputs(raw_memory, rollout_summary, usage_count, last_usage, selected_for_phase2)` + `jobs(lease/retry)`。
- **扩展信任面**：App = 一组 MCP 工具，插件 = 技能+MCP+App 的捆绑；这意味着第三方能力进入的默认通道是 **MCP**，而不是自造协议。[确证]
- **并发模型**：一个 thread 一个工作区（可多根），线程有独立 sandbox/approval；父子关系显式落表，但**无每子代理的独立资源账本**（仅 thread 级 tokens_used）。[确证]/缺口[推测]
- **沙箱**：`sandbox_policy: managed{file_system:restricted, network:restricted}`，逐路径 read/write，`.git/.agents/.codex` 只读，`/tmp` 可写；另有 `disabled`（danger-full-access）；`codex-windows-sandbox-setup.exe`。[确证]

## 执行逻辑

- **工具协议独特**：统一 `custom_tool_call: exec`（JS 体调 `tools.exec_command`/`apply_patch`，`Promise.allSettled` 并行）+ `js` 持久 REPL + `wait/sleep`；MCP 走 `mcp__server__tool`。[确证]
- **循环与停止**：turn 事件流 `task_started→…→task_complete/turn_aborted`；`thread_goals` 有 `token_budget/tokens_used/time_used/status(budget_limited)` —— **有目标式长跑与预算停止**。[确证]
- **权限审批三档治理**：`approval_policy`(never/on-request…) + `sandbox_policy` + `guardian-approvals`（自动审批复核）+ `approvals_reviewer`；system prompt 明写「按判断、授权跨轮持久、被 auto-review 拒绝要如实转述」。[确证]
- **错误恢复**：rollout→`thread_history` 投影与重放、jobs `retry/lease`、`turn_aborted`+`error_json`、命令可 `yield_time_ms` 转后台。[确证]
- **上下文压缩**：`model_context_window=258400`（rollout 实测）；`compacted` 事件内容为「另一个语言模型生成的摘要」；**压缩不结束任务**（system prompt 明说）。[确证]

## 界面设计

1. **「任务」是统一概念**：UI 叫 task、内部叫 thread、提示词明说同义 —— 把「会话/子代理/后台任务」收成一个对象，避免用户做概念翻译。[确证]
   **判断**：这是界面层最值得学的一条。我们的「会话/任务」如果分开，用户要理解两套心智模型。
2. **状态可见性写进壳里**：上下文窗口占用、步骤/命令二级详略、权限心跳、未读；**不靠聊天文本汇报**。[确证]
3. **右栏承载产物**（文件树/artifact/内置浏览器），对话区只留过程摘要 —— **产物与过程分离**。[确证]
4. **云/本地边界对用户直说**：cloud task 明示「不能读你电脑文件」。诚实标注能力边界，比隐藏更省支持成本。[确证]
5. 可抄但别全抄：pets、贴纸、busy-bar 这类情绪化层，对「工作台」是噪音。[推测]

## 优势（可验证）

1. **world_state 每轮注入让状态驱动成为默认** —— 不需要模型主动「记住」，环境每轮都告诉它。
   [证据: `turn_context` 落 `state_5.sqlite`，每轮生成]
2. **thread 即 agent，统一了会话/子代理/后台任务** —— `create_thread/fork_thread/list_threads/read_thread/wait_threads/send_message_to_thread/handoff_thread` 七个操作覆盖全部协作形态。
   [证据: `thread_spawn_edges` 表]
3. **压缩不结束任务，而是换一份摘要继续** —— 长任务不因上下文满而中断。
   [证据: system prompt 明说]
4. **预算停止是一等机制** —— `thread_goals.status(budget_limited)` 说明它真的会因为预算而停。
   [证据: `token_budget/tokens_used/time_used`]
5. **第三方能力默认走 MCP** —— 不自造协议，降低生态接入成本。
   [证据: Apps = `codex_apps` MCP，`tool_search` 懒加载]

## 缺点（可验证）

1. **无每子代理的独立资源账本**。
   出问题场景：开 5 个子代理并行跑长任务，无法知道是哪个烧的钱，也无法单独给它设预算。
   验证：`thread_goals` 只有 thread 级 `tokens_used`，子代理无独立记录。[确证]

2. **可观测性偏工程向，面向用户的审计视图弱**。
   出问题场景：`logs_2.sqlite` 12672 行（level/target/module/file/line/thread_id）是给开发者看的；普通用户想知道「这轮都干了什么、花了多少」没有产品化视图。
   验证：`token_usage_record` 与 `thread_turns` 有数据，但 [推测] 无对应用户界面。

3. **回退靠 git，没有独立 diff 预览流程**。
   出问题场景：想看「这次改动和上次比怎么样」必须先 commit 或 stash。
   验证：`apply_patch` 走 `exec`，回退主要靠 git。[确证]/回退流程[推测]

4. **自验证偏弱，验收标准仍由 agent 自拟**。
   出问题场景：agent 说「做完了」，用户无法判断它是否真的验证过。
   验证：内置 `review-agent` 技能（只读、缺陷优先、可证伪的入册条件），但 [高置信] 无强制「必须证明完成」的机制。

5. **Windows 沙箱需额外 setup**。
   出问题场景：首次使用要跑 `codex-windows-sandbox-setup.exe`，否则可能降级到 `disabled`。
   验证：`config.toml [windows] sandbox="elevated"`。[确证]

---

# 二、Claude Code 桌面版

## 一句话定位

**面向终端的「高密度单列 agent 工作台」**，用 44 个细粒度工具 + 33 个 hook 事件 + 6 种权限模式构成可编程 harness，再把同一内核铺到 IDE/桌面/Web/云/Chrome。

## 底层架构

- **双层**：原生单二进制（2.1.325，355MB）+ Agent SDK（0.3.325，`sdk.d.ts` 592KB / `sdk-tools.d.ts` 179KB）。
  这是它与其它闭源产品最大的不同：**它把 harness 本身开放成 SDK**。
- **工具面 44 个**，细粒度到 `FileEdit(old/new/replace_all)` 返回 `structuredPatch`+`gitDiff`+`originalFile`+`userModified`。
- **hook 事件 33 个** —— 比 ECC 用的 8 个多得多。
- **权限 6 种模式**。
- **沙箱**：`seatbelt`(macOS, 11 处字符串) / `bubblewrap`(Linux, 65 处)；`--restricted` 移除执行类工具并收窄文件域。

[确证]

## 执行逻辑

- **编辑最完整**：`FileEdit` 返回三重校验（patch + gitDiff + originalFile）+ `userModified` 标记用户是否改过提案。
  **判断**：`userModified` 这一位很关键 —— 它让「agent 的改动」和「用户改过的改动」在数据层就分开，避免后续 agent 覆盖用户意图。
- **终端**：`Bash`/`PowerShell`：后台任务、Ctrl+B、超时自动转后台。
- **多模态部分**：`--file file_id:path` 预取、图片粘贴、bash 输出 `isImage`；transcript 有 `voice_call_talk`、`mobile` 命令。

## 界面设计

**TUI 信息密度**（终端形态的高密度单列）：
- 工具调用折叠成单行 + 可展开
- 权限提示内联在流中，不弹窗
- 状态行常驻底部

**判断**：终端形态逼出了「一屏内最有效的信息组织」，这比 GUI 更容易看清什么信息是必需的。

## 优势（可验证）

1. **harness 本身开放成 SDK** —— `sdk.d.ts` 592KB + `sdk-tools.d.ts` 179KB，第三方可以按同一工具契约写自己的 agent。
   [证据: Agent SDK 0.3.325 类型定义]
2. **`userModified` 位把「agent 改的」和「用户改的」在数据层分开** —— 避免后续 agent 覆盖用户意图。
   [证据: `FileEdit` 返回值]
3. **工具细粒度到 44 个** —— 而不是「一个大 file 工具」，让权限与审计可以按操作类型收敛。
   [证据: `sdk-tools.d.ts`]
4. **hook 事件 33 个** —— 比 ECC 用的 8 个多 4 倍，可编程面显著更大。
   [证据: 二进制字符串 + 文档]
5. **沙箱是原生的（seatbelt/bubblewrap），不是应用层黑名单**。
   [证据: 二进制内 11 + 65 处沙箱字符串]

## 缺点（可验证）

1. **355MB 单二进制**。
   出问题场景：分发体积大、冷启动慢、无法按需加载模块。
   验证：`claude` 可执行文件 355MB。

2. **闭源 + 只公开类型，不公开实现**。
   出问题场景：想改 harness 行为只能通过 hook 与 SDK 的有限接口；遇到 bug 无法自查。
   验证：开源的是 `sdk.d.ts`（类型），不是实现。

3. **终端优先，图形能力弱**。
   出问题场景：需要看图表、图片对比、多栏并排时体验受限（虽有桌面版但本质是 TUI 内核）。
   验证：界面特征全是 TUI 模式。

4. **44 工具 + 33 hook 事件 = 学习曲线陡**。
   出问题场景：新用户不知道哪个工具/钩子该用，容易过度配置。
   验证：`sdk-tools.d.ts` 179KB。

5. **无「整轮只读」的 plan 模式**（[高置信]）。
   出问题场景：想先看方案再批准，只能靠逐个 tool call 拦。
   验证：文档里 `--restricted` 是移除执行类工具，不是「本轮只读」。

---

# 三、Cursor

## 一句话定位

**VS Code fork 的编辑器内 agent**，把 AI 深度嵌进编辑体验（inline diff、Tab 补全、Composer）。

## 证据强度

**弱**：未安装，无本机取证。以下为 [高置信]（多来源一致）与 [推测]，**不得当事实引用**。

## 底层架构 [高置信]

- VS Code fork（同一扩展生态 + 同一 UI 框架）
- 三层 AI：Tab（补全）/ inline edit（Cmd+K）/ Composer（多文件 agent）
- 索引：代码库 embedding 索引（本地或云端）

## 界面设计 [高置信]

1. **inline diff 是核心交互** —— 改动直接显示在编辑器里，接受/拒绝逐个 hunk。
   **判断**：这是「编辑器内 agent」相对「对话式 agent」的根本优势 —— 改动在上下文里，不用来回对照。
2. **Tab 补全的延迟要求极严**（<100ms 级），因此模型小、上下文窄。
3. **Composer 是多文件 agent 面**，与 chat 分开。

## 优势 [高置信]

1. **inline diff 让「看改动」和「看代码」是同一件事** —— 不需要在对话和文件间切换。
2. **VS Code fork 免费获得整个扩展生态** —— 不重复造编辑器。
3. **三层 AI 按延迟需求分层** —— Tab 要快用小模型、Composer 要准用大模型。

## 缺点

1. **[高置信] fork 的代价是永远落后上游** —— VS Code 每次大版本都要跟。
   出问题场景：上游改了扩展 API，Cursor 要重新适配。
2. **[推测] 索引的隐私边界对用户不透明** —— 代码库 embedding 在本地还是云端，普通用户说不清。
   出问题场景：企业内使用时的合规审查。
3. **[高置信] 闭源 + 订阅制** —— 无法自托管、无法审计。
4. **[推测] 多文件 agent 的失败恢复弱** —— Composer 改 10 个文件如果中途失败，回退粒度是整批还是单文件不明。

---

# 四、Trae

## 一句话定位

**字节跳动的 AI IDE**，主打 Builder 模式（从需求直接生成项目）与中文场景适配。

## 证据强度

**弱**：未安装。以下 [高置信] / [推测]。

## 底层架构 [推测]

- 基于 VS Code（与 Cursor 同路线）
- Builder 模式：需求 → 项目脚手架 → 多文件生成
- 中文优先的 prompt 与模板

## 优势 [高置信]

1. **Builder 模式把「从零建项目」做成一条龙** —— 不需要先有代码库才能用 agent。
   **判断**：这是对「空目录」场景的正确优化，Cursor 的索引方案在这里无效。
2. **中文场景适配** —— 中文 prompt、中文文档、国内模型接入。
3. **[高置信] 免费额度较大** —— 拉新策略。

## 缺点

1. **[推测] Builder 生成的代码可维护性存疑** —— 一次性生成大量文件，缺少渐进演化的路径。
   出问题场景：生成的 20 个文件里 3 个不符合团队规范，改起来比手写更慢。
2. **[推测] 依赖闭源模型服务** —— 离线/内网场景受限。
3. **[高置信] 生态较新** —— 插件与社区远不如 VS Code/Cursor。
4. **[推测] 无本机取证 = 无法验证其架构声明** —— 这是它相对 ChatGPT/Claude Code 的证据劣势。

---

# 五、WorkBuddy（腾讯）

## 一句话定位

**腾讯的办公场景 agent 桌面端**，Electron 大包（241.7MB JS），内建 `tencent-docs` 集成与 CLI。

## 本机取证 [确证]

| 项 | 值 |
|---|---|
| 安装路径 | `D:\file\software\WorkBuddy` |
| 版本 | **5.9.3** |
| 依赖数 | 19 |
| app.asar | **173.6MB** |
| 解出文件 | **9893 个** |
| JS 体量 | **241.7MB** |
| 顶层目录 | `node_modules`(5799) / `renderer`(1958) / `resources`(1476) / `main`(334) / `cli`(308) / `native`(11) / `preload`(5) / `tencent-docs`(1) |

**能力域命中**（按路径关键词统计）：
```
插件/扩展 1469 · 模型/供应商 1168 · 终端 316 · 知识库/文档 178
账户/遥测 135 · MCP 77 · 编辑器 34 · 内置 agent/对话 32
```

**关键结构发现**：
- 有独立 `cli` 目录（308 文件）—— 说明它也有 CLI 形态，不只是 GUI
- 有 `native` 目录（11 文件）—— 有原生模块，不是纯 JS
- 有 `tencent-docs` 目录 —— 腾讯文档深度集成
- `renderer` 1958 文件 vs `main` 334 文件 —— 典型 Electron 前端重后端轻

## 优势（可验证）

1. **腾讯文档深度集成** —— 有专门的 `tencent-docs` 目录，不是通用 MCP 适配。
   **判断**：办公场景的核心痛点是「文档在哪」，直接集成比通用连接器有效。
   [证据: `app.asar` 内 `tencent-docs/` 目录]

2. **同时提供 CLI 与 GUI 形态** —— `cli` 目录 308 文件。
   **判断**：办公场景里「批量处理」用 CLI、「日常交互」用 GUI，两个形态各有必需。
   [证据: `app.asar` 内 `cli/` 目录]

3. **MCP 支持较深** —— 77 处路径命中。
   [证据: 能力域统计]

## 缺点（可验证）

1. **包体极大：241.7MB JS / 9893 文件**。
   出问题场景：冷启动慢、更新下载量大、内存占用高（Electron + 242MB JS）。
   验证：`(Get-ChildItem -Recurse -File).Count` = 9893；JS 字节累计 241.7MB。

2. **`node_modules` 占 58.6% 文件数（5799/9893）**。
   出问题场景：依赖树深，供应链风险面大；升级任一依赖都可能连锁。
   验证：顶层目录统计。

3. **无本机可见的测试或类型定义**（[推测]，未深入 asar 内容）。
   出问题场景：质量不可外部验证。

4. **版本 5.9.3 但依赖只有 19 个**（vs Qoder 38 个）—— 说明大量代码是自家打包而非 npm 依赖。
   出问题场景：可维护性依赖内部工程规范，外部无法评估。
   验证：`package.json` dependencies 计数。

---

# 六、CodeBuddy（腾讯）

## 一句话定位

**腾讯的编码助手**（Copilot 系），主打企业内集成。

## 证据强度

**弱**：未安装，无本机取证。以下 [高置信] / [推测]。

## 优势 [高置信]

1. **企业内集成是主战场** —— 与腾讯云/企微/工蜂等内部体系打通。
   **判断**：闭源编码助手在国内的真实护城河是「企业已采购的生态」，不是模型能力。
2. **合规与私有化部署** —— 企业采购的硬要求。

## 缺点

1. **[推测] 与 WorkBuddy 定位重叠** —— 两个腾讯产品，用户分不清用哪个。
2. **[高置信] 无本机取证 = 无法验证架构** —— 证据强度最弱的一档。
3. **[推测] 编码能力依赖底层模型** —— 不自研模型的话，上限受制于供应商。

---

# 七、Qoder（阿里）

## 一句话定位

**阿里的 agentic IDE**，Electron 桌面端（127MB asar），主打 repo 级上下文理解。

## 本机取证 [确证]

| 项 | 值 |
|---|---|
| 安装路径 | `D:\file\software\Qoder` |
| 版本 | **0.1.6** |
| 依赖数 | 38 |
| app.asar | **127.2MB** |
| 解出文件 | **4456 个** |
| JS 体量 | **68.8MB** |
| 顶层目录 | `node_modules`(3284) / `out`(1171) |
| 入口 | `./out/main/index.js` |

**能力域命中**：
```
模型/供应商 1192 · 终端 95 · 账户/遥测 52 · 插件/扩展 11 · MCP 10 · 编辑器 7 · 知识库/文档 5
```

**关键结构发现**：
- 只有两个顶层目录：`node_modules`(73.7%) + `out`(26.3%)
- `out` 目录 1171 文件 = 编译产物，**没有 src**
- 有 `.qoder-update` / `.qoder-versions` 目录 —— 自带更新器与多版本共存
- **模型/供应商命中 1192 处，远高于其他能力域** —— 多模型接入是它的重心

## 优势（可验证）

1. **多模型接入是重心** —— 1192 处路径命中「模型/供应商」，是第二位（终端 95）的 12.5 倍。
   **判断**：这说明它的差异化不是 UI 或工作流，而是「支持多少模型」。
   [证据: 能力域统计]

2. **自带多版本共存更新器** —— `.qoder-update` + `.qoder-versions`。
   **判断**：企业环境常见「不敢升级」，多版本共存是实用设计。
   [证据: 安装目录]

3. **包体相对克制** —— 68.8MB JS（vs WorkBuddy 241.7MB），4456 文件（vs 9893）。
   [证据: 统计]

## 缺点（可验证）

1. **版本 0.1.6 —— 极早期**。
   出问题场景：功能不完整、API 不稳定、可能重构。
   验证：`package.json` version = 0.1.6。

2. **`out` 是编译产物，无 src** —— 无法通过 asar 判断源码结构。
   出问题场景：外部无法评估其架构质量。
   验证：顶层只有 `node_modules` 与 `out`。

3. **插件/扩展只有 11 处命中** —— 扩展面窄。
   出问题场景：想加自定义能力时选择少。
   验证：能力域统计。

4. **`node_modules` 占 73.7%（3284/4456）** —— 依赖占比比 WorkBuddy 还高。
   出问题场景：供应链风险面大。
   验证：顶层目录统计。

5. **无 MCP 深度**（10 处 vs WorkBuddy 77 处）。
   出问题场景：接外部工具生态能力弱。
   验证：能力域统计。

---

# 八、7 个产品的横向对比

| 维度 | ChatGPT/Codex | Claude Code | Cursor | Trae | WorkBuddy | CodeBuddy | Qoder |
|---|---|---|---|---|---|---|---|
| 形态 | 桌面+云+CLI+IDE | 终端+桌面+IDE+Web | VS Code fork | VS Code fork | Electron 桌面+CLI | 插件/IDE | Electron 桌面 |
| 证据强度 | **强** [确证] | **强** [确证] | 弱 [高置信] | 弱 [高置信] | 中 [确证结构] | 弱 [高置信] | 中 [确证结构] |
| 工具数 | 统一 exec 协议 | **44** | 未知 | 未知 | 未知 | 未知 | 未知 |
| hook 事件 | 未知 | **33** | 未知 | 未知 | 未知 | 未知 | 未知 |
| 沙箱 | managed 逐路径 | seatbelt/bubblewrap | 未知 | 未知 | 未知 | 未知 | 未知 |
| 成本可见 | 有 token_usage_record | 有 | 未知 | 未知 | 未知 | 未知 | 未知 |
| **预算熔断** | **有**（budget_limited） | 未知 | 未知 | 未知 | 未知 | 未知 | 未知 |
| 记忆 | 两阶段离线巩固 | 有 | 索引 | 未知 | 未知 | 未知 | 未知 |
| 界面范式 | 三栏+右栏产物 | TUI 高密度单列 | inline diff | Builder | 未知 | 未知 | 未知 |
| 包体 | 桌面 Appx | **355MB 单二进制** | 未知 | 未知 | **241.7MB JS** | 未知 | 68.8MB JS |
| 文件数 | 未知 | 未知 | 未知 | 未知 | **9893** | 未知 | 4456 |

---

# 九、共同的最强项（短期超不过，老实承认）

1. **模型能力本身** —— 闭源产品背后是自家/合作的前沿模型。我们的模型接入能力受限。
2. **Sandbox 的原生实现** —— ChatGPT 的 managed sandbox、Claude Code 的 seatbelt/bubblewrap 是 OS 级隔离。我们的 A15 是应用层能力边界（虽已能挡等价分解，但不是 OS 隔离）。
3. **云端任务编排** —— ChatGPT 的 cloud task + thread 拓扑，需要云基础设施。
4. **生态规模** —— Cursor 拿到整个 VS Code 生态；ChatGPT 有 Apps + 插件市场。

**结论**：这四项不追求短期超过，追求「够用 + 在别的维度超过」。

---

# 十、共同的短板（这是我们的机会）

## 机会 1：没有一家把「不确定」当一等公民

- ChatGPT：有 `task_complete/turn_aborted` 两态，但没有「做了一半但判不了」这一态
- Claude Code：权限提示有，但「这个结论可靠吗」不表达
- 其余闭源：无证据

**我们的 A7/A5/A15 已把四态（PASS/WARN/FAIL/UNKNOWN）做成机制。**
**验证超过的方法**：构造一个「无法判定」的场景，看产品是否诚实说「判不了」而不是给结论。

## 机会 2：成本可见性普遍弱

- ChatGPT 有 `token_usage_record` 但 [推测] 无产品化仪表
- DSH 完全无（0 命中）
- 其余未知

**验证超过的方法**：会话结束给出可复算金额，同会话两次展示一致，换模型后历史金额不重算。

## 机会 3：压缩后溯源普遍不清晰

- ChatGPT 压缩成「另一个模型的摘要」，原消息去哪了 [推测] 可查
- hermes 有 `absorbed_message_uids` 但正确性靠 6 处 SQL 复制

**验证超过的方法**：压缩+rewind+branch 三重叠加后，任意被吸收消息仍能唯一反查到源行。

## 机会 4：配置演进普遍「升级即断」

- openclaw 明写不做兼容别名
- 闭源产品通常也不提供迁移路径

**验证超过的方法**：保留最近两 minor 可读 + doctor 报弃用 + 旧配置真实启动测试作门禁。

## 机会 5：界面层「状态可见性」只做了一半

- ChatGPT 做了上下文占用、步骤详略，但没有「这个结论的证据在哪」
- 我们的做法：四态 + 每条记忆带来源 + 每个场景能追溯到 tools/ 下哪个脚本

---

# 十一、可照搬的（具体）

| 从谁 | 抄什么 | 落到哪 |
|---|---|---|
| ChatGPT | 「任务」统一概念（thread = 会话 = 子代理 = 后台任务） | 我们的场景模型 |
| ChatGPT | world_state 每轮注入 | 上下文装配 |
| ChatGPT | 右栏承载产物，对话区只留过程摘要 | 界面布局 |
| ChatGPT | 诚实标注能力边界（「云任务不能读本地文件」） | 我们已有（UNKNOWN 单列） |
| Claude Code | `userModified` 位分开「agent 改的」与「用户改的」 | 编辑与记忆 |
| Claude Code | 44 细粒度工具而非 1 个大工具 | 工具设计 |
| Claude Code | harness 开放成 SDK | 长期目标 |
| Cursor | inline diff（改动在上下文里） | 编辑器集成 |
| Trae | Builder 模式（空目录也能起） | 新项目引导 |
| WorkBuddy | 文档系统深度集成而非通用连接器 | 场景集成 |
| Qoder | 多版本共存更新器 | 分发 |

---

# 十二、必须超过的（具体到怎么验证）

| 能力 | 行业现状 | 验证方法 |
|---|---|---|
| **不确定性一等化** | 无（ChatGPT 只有完成/中止两态） | 构造不可判定场景，产品必须说「判不了」且不并入通过。**我们 A7/A5/A15 已实现，需做端到端演示。** |
| **成本可复算** | ChatGPT 有记录无产品化仪表；DSH 完全无 | 会话结束给金额，两次展示一致，换模型不重算 |
| **压缩后单点溯源** | ChatGPT 摘要化；hermes 靠 6 处 SQL 复制 | 压缩+rewind+branch 后任意消息唯一反查，且有 DB 约束 |
| **配置演进兼容** | openclaw 升级即断 | 最近两 minor 可读 + doctor 报弃用 + 旧配置启动测试 |
| **状态可见性到「证据」级** | 只到「在做什么」 | 每个结论可点开看到证据来源（文件/行号/截图/URL） |
| **包体克制** | WorkBuddy 241.7MB JS / Qoder 68.8MB | 目标：核心运行时 JS < 50MB，且能按需加载 |
| **证据强度自证** | 闭源产品无法外部验证 | 我们的拆解标准要求 `路径:行号`，且验收器断言 |